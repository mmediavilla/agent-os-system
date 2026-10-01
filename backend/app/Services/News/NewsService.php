<?php

namespace App\Services\News;

use App\Services\Calendar\AddressRefused;
use App\Services\Calendar\FeedAddress;
use Carbon\CarbonImmutable;
use Illuminate\Http\Client\PendingRequest;
use Illuminate\Http\Client\Pool;
use Illuminate\Http\Client\Response;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use InvalidArgumentException;

/**
 * The news, by beat, by query and by the owner's interests.
 *
 * The weather's shape and the calendar's fetch: read through Laravel so every
 * outlet is asked from one place on one clock, **cached per feed** so one dead
 * outlet costs that outlet and nothing else, and fetched concurrently
 * (`Http::pool`) inside the request that asked, because four outlets queued
 * behind one another is two seconds of nothing. Where a fetch may go is
 * {@see FeedAddress}'s decision, asked before every one.
 *
 * **Nobody names a URL.** Every item handed out carries a short `id` and is
 * remembered here for `item_days`; pinning — by the tool or from the HUD —
 * sends that id and {@see self::item()} resolves it. The model and the browser
 * each get a closed set to pick from, `open_on_this_machine`'s rule.
 *
 * **Seen-before is the assistant's alone.** A read with `$markSeen` records
 * each item it returns and flags the ones it had already recorded, so a second
 * briefing can say what is new. The HUD reads without it: browsing the overlay
 * is not the assistant having told the owner anything.
 *
 * **An unreachable outlet is named in every answer.** An empty beat beside a
 * dead feed is not "no news", and the caller is given what it needs to say so.
 */
final class NewsService
{
    public function __construct(private readonly FeedAddress $address) {}

    /** @return array<string, string> every beat's key and label, in the order they are offered */
    public function beats(): array
    {
        return array_map(fn (array $beat) => (string) $beat['label'], (array) config('news.beats'));
    }

    /**
     * A beat's latest: its outlets, plus its search where it has one.
     *
     * With a `$query`, the beat's outlets are narrowed to items that mention
     * it and one search is run for it — narrowed to the beat's own search
     * phrase where it has one, so "floods" on the local beat asks about Metro
     * Manila's floods rather than the world's.
     *
     * @return array{beat: string, label: string, query: ?string, items: list<array<string, mixed>>, unreachable: list<array{source: string, message: string}>}
     */
    public function beat(string $beat, ?string $query = null, bool $markSeen = false): array
    {
        $config = config("news.beats.{$beat}");

        if (! is_array($config)) {
            throw new InvalidArgumentException("There is no \"{$beat}\" beat.");
        }

        $query = trim((string) $query) ?: null;
        $sources = array_map(fn (array $feed) => $this->feed($feed), $config['feeds']);

        $search = match (true) {
            $query !== null => trim($query.' '.($config['search'] ?? '')),
            isset($config['search']) => (string) $config['search'],
            default => null,
        };

        // The search goes last, so an item both an outlet and Google carry is
        // kept as the outlet's: its link is the article, not a redirect.
        if ($search !== null) {
            $sources[] = $this->search($search);
        }

        $read = $this->read($sources);
        $items = [];

        foreach ($sources as $source) {
            foreach ($read[$source['key']]['items'] ?? [] as $item) {
                if ($query !== null && $source['kind'] === 'feed' && ! self::mentions($item, $query)) {
                    continue;
                }

                $items[] = $item;
            }
        }

        $items = self::cap(self::newestFirst(self::dedupe($items)), (int) config('news.per_beat'), (int) config('news.per_source'));

        return [
            'beat' => $beat,
            'label' => (string) $config['label'],
            'query' => $query,
            'items' => $this->hand($items, $markSeen),
            'unreachable' => self::unreachable($sources, $read),
        ];
    }

    /**
     * One search per interest, for the first `interests.searched` of them.
     *
     * @param  list<string>  $interests
     * @return array{beat: string, label: string, searched: list<string>, items: list<array<string, mixed>>, unreachable: list<array{source: string, message: string}>}
     */
    public function interests(array $interests, bool $markSeen = false): array
    {
        $searched = array_slice(array_values(array_filter(array_map('trim', $interests))), 0, (int) config('news.interests.searched'));
        $sources = array_map(fn (string $interest) => $this->search($interest), $searched);
        $read = $this->read($sources);

        $items = [];
        $seen = [];

        foreach ($searched as $i => $interest) {
            $mine = self::dedupe($read[$sources[$i]['key']]['items'] ?? []);
            // Across interests too: a story that answers two of them is told once.
            $mine = array_filter($mine, fn (array $item) => ! isset($seen[self::fingerprint($item['title'])]));
            $mine = self::cap(self::newestFirst(array_values($mine)), (int) config('news.interests.per_interest'), PHP_INT_MAX);

            foreach ($mine as $item) {
                $seen[self::fingerprint($item['title'])] = true;
                $items[] = ['interest' => $interest] + $item;
            }
        }

        // One search source, named once however many interests it failed.
        $unreachable = array_values(array_unique(self::unreachable($sources, $read), SORT_REGULAR));

        return [
            'beat' => 'interests',
            'label' => 'Your interests',
            'searched' => $searched,
            'items' => $this->hand($items, $markSeen),
            'unreachable' => $unreachable,
        ];
    }

    /**
     * An item handed out in the last `item_days`, by its id — or null.
     *
     * @return array{id: string, title: string, link: string, source: string, published_at: ?string, summary: ?string}|null
     */
    public function item(string $id): ?array
    {
        $item = preg_match('/^[0-9a-f]{12}$/', $id) ? Cache::get("news.item.{$id}") : null;

        return is_array($item) ? $item : null;
    }

    /**
     * Fetch a beat's sources now, cache or not, and say how each went — for
     * `news:probe`, which is where a feed's address is proven.
     *
     * @return list<array{beat: string, source: string, kind: string, ok: bool, items: int, newest: ?string, message: ?string}>
     */
    public function probe(?string $beat = null): array
    {
        $beats = $beat === null ? array_keys($this->beats()) : [$beat];
        $rows = [];

        foreach ($beats as $key) {
            $config = config("news.beats.{$key}");

            if (! is_array($config)) {
                throw new InvalidArgumentException("There is no \"{$key}\" beat.");
            }

            $sources = array_map(fn (array $feed) => $this->feed($feed), $config['feeds']);

            if (isset($config['search'])) {
                $sources[] = $this->search((string) $config['search']);
            }

            $read = $this->read($sources, force: true);

            foreach ($sources as $source) {
                $outcome = $read[$source['key']];
                $dates = array_filter(array_column($outcome['items'] ?? [], 'published_at'));

                $rows[] = [
                    'beat' => $key,
                    'source' => $source['name'],
                    'kind' => $source['kind'],
                    'ok' => $outcome['ok'],
                    'items' => count($outcome['items'] ?? []),
                    'newest' => $dates === [] ? null : max($dates),
                    'message' => $outcome['message'] ?? null,
                ];
            }
        }

        return $rows;
    }

    /** @return array{kind: string, key: string, name: string, url: string, ttl: int, zone: ?string, summaries: bool, exclude: list<string>} */
    private function feed(array $feed): array
    {
        return [
            'kind' => 'feed',
            'key' => 'news.feed.'.sha1($feed['url']),
            'name' => (string) $feed['name'],
            'url' => (string) $feed['url'],
            'ttl' => (int) config('news.ttl'),
            'zone' => $feed['zone'] ?? null,
            'summaries' => (bool) ($feed['summaries'] ?? true),
            'exclude' => [],
        ];
    }

    /** @return array{kind: string, key: string, name: string, url: string, ttl: int, zone: ?string, summaries: bool, exclude: list<string>} */
    private function search(string $query): array
    {
        $config = (array) config('news.search');

        // One cache entry per question, however it was capitalised or spaced.
        $normal = mb_strtolower(preg_replace('/\s+/u', ' ', trim($query)) ?? $query);

        return [
            'kind' => 'search',
            'key' => 'news.search.'.sha1($normal),
            'name' => (string) $config['name'],
            'url' => $config['url'].'?'.http_build_query(['q' => $normal] + (array) ($config['params'] ?? [])),
            'ttl' => (int) config('news.search_ttl'),
            'zone' => null,
            'summaries' => (bool) ($config['summaries'] ?? true),
            'exclude' => array_values((array) ($config['exclude'] ?? [])),
        ];
    }

    /**
     * Every source's cached outcome, fetching those that are due.
     *
     * @param  list<array<string, mixed>>  $sources
     * @return array<string, array{ok: bool, items?: list<array<string, mixed>>, message?: string}>
     */
    private function read(array $sources, bool $force = false): array
    {
        $out = [];
        $due = [];

        foreach ($sources as $source) {
            $cached = $force ? null : Cache::get($source['key']);

            if (is_array($cached)) {
                $out[$source['key']] = $cached;

                continue;
            }

            // Checked before every fetch, not trusted from config: a name can
            // be pointed somewhere else after it was written down.
            $target = $this->address->check($source['url']);

            if (! $target['ok']) {
                $out[$source['key']] = $this->record($source, [
                    'ok' => false,
                    'message' => 'The outlet\'s address could not be resolved, or it points somewhere this server will not fetch.',
                ]);

                continue;
            }

            $due[$source['key']] = [$source, $target];
        }

        if ($due === []) {
            return $out;
        }

        $responses = Http::pool(fn (Pool $pool) => array_map(
            fn (string $key) => $this->request($pool->as($key), $due[$key][1])->get($due[$key][0]['url']),
            array_keys($due),
        ));

        foreach ($due as $key => [$source]) {
            $out[$key] = $this->record($source, $this->outcome($source, $responses[$key] ?? null));
        }

        return $out;
    }

    /** @param  array{host: string, port: int, ip: string}  $target  what {@see FeedAddress::check()} cleared */
    private function request(PendingRequest $request, array $target): PendingRequest
    {
        return $request
            ->timeout((int) config('news.timeout'))
            ->withOptions($this->address->options($target))
            ->withUserAgent('ProjectMC news reader')
            ->accept('application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.1');
    }

    /**
     * What a fetch came to, in sentences of our own: Guzzle's quote the URL,
     * and {@see FeedAddress}'s talk about calendars.
     *
     * @return array{ok: bool, items?: list<array<string, mixed>>, message?: string}
     */
    private function outcome(array $source, mixed $response): array
    {
        if ($response instanceof AddressRefused) {
            return ['ok' => false, 'message' => 'The outlet redirected somewhere this server will not follow.'];
        }

        if (! $response instanceof Response) {
            return ['ok' => false, 'message' => 'The outlet could not be reached.'];
        }

        if (! $response->successful()) {
            return ['ok' => false, 'message' => 'The outlet answered '.$response->status().'.'];
        }

        $body = $response->body();

        if (strlen($body) > (int) config('news.max_bytes')) {
            return ['ok' => false, 'message' => 'The outlet sent more than a news feed ever is, so it was not read.'];
        }

        $parsed = FeedParser::parse($body, $source['name'], (int) config('news.summary_chars'), $source['zone'], $source['summaries']);

        if ($parsed['error'] !== null) {
            return ['ok' => false, 'message' => $parsed['error']];
        }

        $now = CarbonImmutable::now();
        $horizon = $now->addMinutes((int) config('news.future_minutes'));
        $oldest = $now->subDays((int) config('news.max_age_days'));
        $excluded = array_map('strtolower', $source['exclude']);
        $items = [];

        foreach ($parsed['items'] as $item) {
            if (in_array(strtolower($item['source']), $excluded, true)) {
                continue;
            }

            $at = $item['published_at'] === null ? null : CarbonImmutable::parse($item['published_at']);

            if ($at !== null && $at->lessThan($oldest)) {
                continue;
            }

            // A stamp from the future is an offset the feed got wrong, and
            // would sit at the top of every list. Undated is the honest reading.
            if ($at !== null && $at->greaterThan($horizon)) {
                $item['published_at'] = null;
            }

            $items[] = $item;
        }

        return ['ok' => true, 'items' => $items];
    }

    /** @param  array{ok: bool, items?: list<array<string, mixed>>, message?: string}  $outcome */
    private function record(array $source, array $outcome): array
    {
        Cache::put($source['key'], $outcome, $outcome['ok'] ? $source['ttl'] : (int) config('news.failure_ttl'));

        return $outcome;
    }

    /**
     * Give each item its id, remember it for pinning, and — for the assistant
     * — note whether it has been told before.
     *
     * @param  list<array<string, mixed>>  $items
     * @return list<array<string, mixed>>
     */
    private function hand(array $items, bool $markSeen): array
    {
        $days = (int) config('news.item_days');
        $seenFor = (int) config('news.seen_days') * 86400;

        return array_map(function (array $item) use ($days, $markSeen, $seenFor) {
            $item = ['id' => self::id($item['link'])] + $item;

            Cache::put("news.item.{$item['id']}", array_diff_key($item, ['interest' => true]), now()->addDays($days));

            if ($markSeen) {
                // `add` is the claim: it succeeds exactly once per window.
                $item['seen_before'] = ! Cache::add("news.seen.{$item['id']}", true, $seenFor);
            }

            return $item;
        }, $items);
    }

    public static function id(string $link): string
    {
        return substr(sha1($link), 0, 12);
    }

    /**
     * @param  list<array<string, mixed>>  $sources
     * @param  array<string, array<string, mixed>>  $read
     * @return list<array{source: string, message: string}>
     */
    private static function unreachable(array $sources, array $read): array
    {
        $out = [];

        foreach ($sources as $source) {
            if (! ($read[$source['key']]['ok'] ?? false)) {
                $out[] = ['source' => $source['name'], 'message' => (string) ($read[$source['key']]['message'] ?? 'The outlet could not be read.')];
            }
        }

        return $out;
    }

    /**
     * One copy of each story, the first one met — callers order their sources
     * so that is the outlet's own.
     *
     * @param  list<array<string, mixed>>  $items
     * @return list<array<string, mixed>>
     */
    private static function dedupe(array $items): array
    {
        $kept = [];

        foreach ($items as $item) {
            $kept[self::fingerprint($item['title'])] ??= $item;
        }

        return array_values($kept);
    }

    /** A headline with case, punctuation and spacing taken out. */
    private static function fingerprint(string $title): string
    {
        return trim(preg_replace('/[^\p{L}\p{N}]+/u', ' ', mb_strtolower($title)) ?? $title);
    }

    /**
     * Newest first; undated last, in the order they came.
     *
     * @param  list<array<string, mixed>>  $items
     * @return list<array<string, mixed>>
     */
    private static function newestFirst(array $items): array
    {
        $order = array_keys($items);

        usort($order, fn (int $a, int $b) => [$items[$a]['published_at'] === null, $items[$b]['published_at'] ?? '', $a]
            <=> [$items[$b]['published_at'] === null, $items[$a]['published_at'] ?? '', $b]);

        return array_map(fn (int $i) => $items[$i], $order);
    }

    /**
     * @param  list<array<string, mixed>>  $items
     * @return list<array<string, mixed>>
     */
    private static function cap(array $items, int $total, int $perSource): array
    {
        $kept = [];
        $bySource = [];

        foreach ($items as $item) {
            if (count($kept) >= $total) {
                break;
            }

            if (($bySource[$item['source']] ?? 0) >= $perSource) {
                continue;
            }

            $bySource[$item['source']] = ($bySource[$item['source']] ?? 0) + 1;
            $kept[] = $item;
        }

        return $kept;
    }

    /** Every word of the query, in the headline or the summary. */
    private static function mentions(array $item, string $query): bool
    {
        $haystack = mb_strtolower($item['title'].' '.($item['summary'] ?? ''));

        foreach (preg_split('/\s+/u', mb_strtolower($query)) ?: [] as $word) {
            if (mb_strlen($word) > 1 && ! str_contains($haystack, $word)) {
                return false;
            }
        }

        return true;
    }
}
