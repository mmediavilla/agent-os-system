<?php

namespace App\Services\Calendar;

use App\Models\CalendarFeed;
use Carbon\CarbonImmutable;
use DateTimeZone;
use Illuminate\Contracts\Encryption\DecryptException;
use Illuminate\Http\Client\PendingRequest;
use Illuminate\Http\Client\Pool;
use Illuminate\Http\Client\Response;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Throwable;

/**
 * The user's calendars — Google, iCloud, anything with an iCal address — as one
 * list of wall-clock events.
 *
 * The weather's shape, for the weather's reasons: fetched through Laravel so
 * the secret never reaches the page, and cached per feed so a HUD left open all
 * day costs each provider one request per calendar every few minutes rather
 * than one per poll. Where a fetch may go is {@see FeedAddress}'s decision, and
 * it is asked before every one.
 *
 * **Two cache entries per feed, because freshness and the last reading are
 * different questions.** `attempt` says when the feed was last asked and how
 * that went, and expires on the short clock — five minutes after a success, one
 * after a failure. `reading` is the last successful parse and does not expire:
 * a failed fetch leaves it where it was, so an outage shows as a calendar
 * flagged unreachable with its last known events, rather than as a week that
 * has suddenly emptied. Those two look identical to anyone reading the panel,
 * and only one of them is true.
 *
 * **Nothing here ever says the address**, to anyone — and that includes error
 * messages. Guzzle's connection errors quote the URL they failed on, so a
 * failure is described in a sentence of our own and the exception is not even
 * logged: `laravel.log` is not somewhere a credential should end up either.
 */
final class CalendarService
{
    public function __construct(
        private readonly IcsReader $reader,
        private readonly FeedAddress $address,
    ) {}

    public function zone(): DateTimeZone
    {
        return new DateTimeZone((string) config('agent.timezone'));
    }

    /** Today, where the user is — not where the server is. */
    public function today(): CarbonImmutable
    {
        return CarbonImmutable::now($this->zone())->startOfDay();
    }

    /**
     * The span a fetch reads, as local midnights.
     *
     * @return array{from: CarbonImmutable, to: CarbonImmutable} `to` exclusive
     */
    public function horizon(): array
    {
        $today = $this->today();

        return [
            'from' => $today->subDays((int) config('calendar.past_days')),
            'to' => $today->addDays((int) config('calendar.future_days') + 1),
        ];
    }

    /**
     * Every enabled calendar's events in a window, and how each feed is doing.
     *
     * `$from` and `$to` are local dates, both inclusive.
     *
     * @return array{configured: bool, from: string, to: string, events: list<array<string, mixed>>, feeds: list<array<string, mixed>>}
     */
    public function window(string $from, string $to): array
    {
        $feeds = CalendarFeed::query()->where('enabled', true)->orderBy('id')->get();

        $this->refresh($feeds->reject(fn (CalendarFeed $feed) => Cache::has(self::attemptKey($feed))));

        $first = "{$from}T00:00:00";
        $last = CarbonImmutable::parse($to)->addDay()->format('Y-m-d').'T00:00:00';

        $events = [];

        foreach ($feeds as $feed) {
            foreach (Cache::get(self::readingKey($feed))['events'] ?? [] as $row) {
                if (IcsReader::overlaps($row, $first, $last)) {
                    $events[] = ['calendar_id' => $feed->id] + $row;
                }
            }
        }

        // One list across calendars, in time order — all-day first on its day.
        usort($events, fn (array $a, array $b) => [$a['starts_at'], ! $a['all_day'], $a['title']]
            <=> [$b['starts_at'], ! $b['all_day'], $b['title']]);

        return [
            'configured' => CalendarFeed::query()->exists(),
            'from' => $from,
            'to' => $to,
            'events' => $events,
            'feeds' => $feeds->map(fn (CalendarFeed $feed) => $this->present($feed))->all(),
        ];
    }

    /**
     * Fetch an address once, before it is saved, to prove it is a calendar and
     * to learn its name. Nothing is cached — there is no feed to cache it under.
     *
     * @return array{ok: true, reading: array<string, mixed>}|array{ok: false, message: string}
     */
    public function probe(string $url): array
    {
        $target = $this->address->check($url);

        if (! $target['ok']) {
            return $target;
        }

        try {
            $response = $this->request(Http::createPendingRequest(), $target)->get($url);
        } catch (Throwable $e) {
            $response = $e;
        }

        return $this->outcome($response);
    }

    /** Seed a new feed's cache from its probe, so the first read does not fetch it again. */
    public function remember(CalendarFeed $feed, array $reading): void
    {
        Cache::forever(self::readingKey($feed), $reading);
        Cache::put(self::attemptKey($feed), ['ok' => true], (int) config('calendar.ttl'));
    }

    public function forget(CalendarFeed $feed): void
    {
        Cache::forget(self::readingKey($feed));
        Cache::forget(self::attemptKey($feed));
    }

    /**
     * Forget only when the feed was last asked, so the next read fetches it
     * rather than waiting out the failure's minute. The last reading stays —
     * Troubleshoot's `refresh_calendar_feeds`, which touches the cache and
     * never the address.
     */
    public function retry(CalendarFeed $feed): void
    {
        Cache::forget(self::attemptKey($feed));
    }

    /**
     * A feed as the client and the model see it. Never the address.
     *
     * `status` is read off the cache and never causes a fetch: `ok` and
     * `failed` are the last attempt; `pending` is a feed nobody has read yet.
     *
     * @return array<string, mixed>
     */
    public function present(CalendarFeed $feed): array
    {
        $attempt = Cache::get(self::attemptKey($feed));
        $reading = Cache::get(self::readingKey($feed));

        $status = match (true) {
            is_array($attempt) => $attempt['ok'] ? 'ok' : 'failed',
            is_array($reading) => 'ok',
            default => 'pending',
        };

        return [
            'id' => $feed->id,
            'name' => $feed->name,
            'color' => $feed->color,
            'enabled' => $feed->enabled,
            'status' => $status,
            'message' => $status === 'failed' ? $attempt['message'] : null,
            // When the events being shown were read — which, after a failure, is
            // how old the last reading is.
            'fetched_at' => $reading['fetched_at'] ?? null,
            // Events in the feed that could not be read — a malformed one, or a
            // series too long to expand. Rare, and said rather than hidden.
            'skipped' => $reading['skipped'] ?? 0,
        ];
    }

    /**
     * Fetch every feed that is due, concurrently.
     *
     * Concurrently because the fetches happen inside the request that asked,
     * and three calendars at half a second each is a second and a half of
     * nothing on the panel if they queue behind one another.
     *
     * @param  Collection<int, CalendarFeed>  $feeds
     */
    private function refresh(Collection $feeds): void
    {
        $urls = [];
        $targets = [];

        foreach ($feeds as $feed) {
            try {
                $url = $feed->url;
            } catch (DecryptException) {
                // The app key changed under it. No fetch can fix that, so
                // none is made — the panel says what will fix it instead.
                $this->record($feed, [
                    'ok' => false,
                    'message' => 'This address can no longer be decrypted, because the app key changed. Remove the calendar and add it again.',
                ]);

                continue;
            }

            // Checked again, not trusted from the day it was saved: the name
            // in it can have been pointed somewhere else since.
            $target = $this->address->check($url);

            if (! $target['ok']) {
                $this->record($feed, $target);

                continue;
            }

            $urls[$feed->id] = $url;
            $targets[$feed->id] = $target;
        }

        if ($urls === []) {
            return;
        }

        $responses = Http::pool(fn (Pool $pool) => array_map(
            fn (int $id) => $this->request($pool->as((string) $id), $targets[$id])->get($urls[$id]),
            array_keys($urls),
        ));

        foreach ($feeds as $feed) {
            if (array_key_exists($feed->id, $urls)) {
                $this->record($feed, $this->outcome($responses[(string) $feed->id] ?? null));
            }
        }
    }

    /** @param  array{host: string, port: int, ip: string}  $target  what {@see FeedAddress::check()} cleared */
    private function request(PendingRequest $request, array $target): PendingRequest
    {
        return $request
            ->timeout((int) config('calendar.timeout'))
            ->withOptions($this->address->options($target))
            ->accept('text/calendar');
    }

    /**
     * @return array{ok: true, reading: array<string, mixed>}|array{ok: false, message: string}
     */
    private function outcome(mixed $response): array
    {
        if ($response instanceof AddressRefused) {
            return ['ok' => false, 'message' => $response->getMessage()];
        }

        if (! $response instanceof Response) {
            return ['ok' => false, 'message' => 'The calendar could not be reached.'];
        }

        if (in_array($response->status(), [401, 403, 404], true)) {
            return ['ok' => false, 'message' => 'The calendar no longer recognises this address. It may have been reset or stopped being shared; add the new address.'];
        }

        if (! $response->successful()) {
            return ['ok' => false, 'message' => 'The calendar answered '.$response->status().'.'];
        }

        $horizon = $this->horizon();

        try {
            $reading = $this->reader->read($response->body(), $this->zone(), $horizon['from'], $horizon['to']);
        } catch (Throwable) {
            return ['ok' => false, 'message' => 'That address did not return a calendar. Use the calendar\'s iCal address — Google calls it the "Secret address in iCal format", iCloud its public calendar link.'];
        }

        return ['ok' => true, 'reading' => $reading + ['fetched_at' => now()->toIso8601String()]];
    }

    /** @param  array{ok: bool, reading?: array<string, mixed>, message?: string}  $outcome */
    private function record(CalendarFeed $feed, array $outcome): void
    {
        if ($outcome['ok']) {
            $this->remember($feed, $outcome['reading']);

            return;
        }

        // The reading is left alone: a failure is a fact about the fetch, not
        // about the calendar.
        Cache::put(
            self::attemptKey($feed),
            ['ok' => false, 'message' => $outcome['message']],
            (int) config('calendar.failure_ttl'),
        );
    }

    private static function readingKey(CalendarFeed $feed): string
    {
        return "calendar.feed.{$feed->id}.reading";
    }

    private static function attemptKey(CalendarFeed $feed): string
    {
        return "calendar.feed.{$feed->id}.attempt";
    }
}
