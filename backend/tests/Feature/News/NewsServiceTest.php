<?php

namespace Tests\Feature\News;

use App\Services\News\NewsService;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;
use InvalidArgumentException;
use Tests\TestCase;
use Tests\Unit\News\FeedParserTest as Feed;

/**
 * Which outlets are asked, how often, what one answer holds, and what is
 * remembered — off `Http::fake`, the fake resolver and the array cache. What an
 * item *is* is FeedParserTest's.
 */
class NewsServiceTest extends TestCase
{
    protected function setUp(): void
    {
        parent::setUp();

        config([
            'news.ttl' => 1200,
            'news.failure_ttl' => 120,
            'news.search_ttl' => 900,
            'news.max_bytes' => 100_000,
            'news.per_beat' => 5,
            'news.per_source' => 2,
            'news.seen_days' => 3,
            'news.item_days' => 7,
            'news.max_age_days' => 7,
            'news.future_minutes' => 60,
            'news.summary_chars' => 280,
            'news.search' => [
                'name' => 'Google News',
                'url' => 'https://news.google.com/rss/search',
                'params' => ['hl' => 'en-PH', 'gl' => 'PH', 'ceid' => 'PH:en'],
                'summaries' => false,
                'exclude' => ['facebook.com'],
            ],
            'news.beats' => [
                'local' => [
                    'label' => 'Metro Manila',
                    'feeds' => [
                        ['name' => 'Alpha', 'url' => 'https://alpha.example/feed'],
                        ['name' => 'Beta', 'url' => 'https://beta.example/feed'],
                    ],
                    'search' => 'Metro Manila',
                ],
                'tech' => [
                    'label' => 'Tech',
                    'feeds' => [['name' => 'Gamma', 'url' => 'https://gamma.example/feed']],
                ],
            ],
            'news.interests' => ['max' => 10, 'searched' => 2, 'per_interest' => 2],
        ]);

        // Noon on the 29th, UTC.
        $this->travelTo('2026-09-29 12:00:00');
    }

    private function news(): NewsService
    {
        return app(NewsService::class);
    }

    /** An RSS body of [title, hours ago] pairs, each linked under $host. */
    private static function feed(string $host, array $stories, string $extra = ''): string
    {
        return Feed::rss(array_map(fn (array $s) => Feed::item(
            $s[0],
            "https://{$host}/".rawurlencode($s[0]),
            $s[1] === null ? null : now()->subMinutes((int) round($s[1] * 60))->toRfc2822String(),
            "About {$s[0]}.",
            $s[2] ?? $extra,
        ), $stories));
    }

    /** A Google News item: the headline with its outlet appended, and `<source>`. */
    private static function google(string $title, string $outlet, float $hoursAgo): array
    {
        return ["{$title} - {$outlet}", $hoursAgo, "<source url=\"https://{$outlet}\">{$outlet}</source>"];
    }

    private function fakeLocal(array $alpha, array $beta, array $google = []): void
    {
        Http::fake([
            'alpha.example/*' => Http::response(self::feed('alpha.example', $alpha)),
            'beta.example/*' => Http::response(self::feed('beta.example', $beta)),
            'news.google.com/*' => Http::response(self::feed('news.google.com', $google)),
        ]);
    }

    /** @return array<string, string> */
    private static function params(Request $r): array
    {
        parse_str((string) parse_url($r->url(), PHP_URL_QUERY), $query);

        return $query;
    }

    private static function titles(array $result): array
    {
        return array_column($result['items'], 'title');
    }

    public function test_a_beat_is_its_outlets_and_its_search_newest_first_and_capped(): void
    {
        $this->fakeLocal(
            [['A1', 1], ['A2', 2], ['A3', 3]],
            [['B1', 1.5], ['B2', 5]],
            [self::google('G1', 'Manila Times', 0.5), self::google('G2', 'Manila Times', 4)],
        );

        $out = $this->news()->beat('local');

        // Newest first; Alpha's third is over its two, so B2's slot comes up.
        $this->assertSame(['G1', 'A1', 'B1', 'A2', 'G2'], self::titles($out));
        $this->assertSame(['Metro Manila', 'local', null, []], [$out['label'], $out['beat'], $out['query'], $out['unreachable']]);
        $this->assertSame('Manila Times', $out['items'][0]['source']);

        foreach ($out['items'] as $item) {
            $this->assertMatchesRegularExpression('/^[0-9a-f]{12}$/', $item['id']);
            $this->assertSame(NewsService::id($item['link']), $item['id']);
            $this->assertArrayNotHasKey('seen_before', $item);
        }
    }

    public function test_a_story_an_outlet_and_google_both_carry_is_kept_as_the_outlets(): void
    {
        $this->fakeLocal([['Water interruptions set', 3]], [], [self::google('Water Interruptions Set!', 'Alpha', 1)]);

        $out = $this->news()->beat('local');

        $this->assertCount(1, $out['items']);
        $this->assertSame('Alpha', $out['items'][0]['source']);
        $this->assertStringStartsWith('https://alpha.example/', $out['items'][0]['link']);
    }

    public function test_each_feed_is_cached_so_a_second_read_asks_nobody(): void
    {
        $this->fakeLocal([['A1', 1]], [['B1', 1]]);

        $this->news()->beat('local');
        $this->assertCount(3, Http::recorded());

        $this->news()->beat('local');
        $this->assertCount(3, Http::recorded());

        // Past the feeds' twenty minutes (and the search's fifteen), all three again.
        $this->travel(21)->minutes();
        $this->news()->beat('local');
        $this->assertCount(6, Http::recorded());
    }

    public function test_a_dead_outlet_is_named_costs_only_itself_and_is_retried_after_its_minutes(): void
    {
        Http::fake([
            'alpha.example/*' => Http::sequence()->push('down', 503)->push(self::feed('alpha.example', [['A back', 1]])),
            'beta.example/*' => Http::response(self::feed('beta.example', [['B1', 1]])),
            'news.google.com/*' => Http::response(self::feed('news.google.com', [])),
        ]);

        $out = $this->news()->beat('local');

        $this->assertSame(['B1'], self::titles($out));
        $this->assertSame([['source' => 'Alpha', 'message' => 'The outlet answered 503.']], $out['unreachable']);

        // Remembered for its two minutes: not asked again inside them.
        $this->news()->beat('local');
        Http::assertSentCount(3);

        $this->travel(3)->minutes();
        $out = $this->news()->beat('local');

        $this->assertSame(['A back', 'B1'], self::titles($out));
        $this->assertSame([], $out['unreachable']);
    }

    public function test_an_address_that_lands_inside_this_network_is_never_fetched(): void
    {
        $this->fakeDns(['alpha.example' => ['127.0.0.1']]);
        $this->fakeLocal([['A1', 1]], [['B1', 1]]);

        $out = $this->news()->beat('local');

        Http::assertNotSent(fn (Request $r) => str_contains($r->url(), 'alpha.example'));
        $this->assertSame(['B1'], self::titles($out));
        $this->assertSame('Alpha', $out['unreachable'][0]['source']);
        $this->assertStringNotContainsString('alpha.example', $out['unreachable'][0]['message']);
        $this->assertStringNotContainsString('calendar', strtolower($out['unreachable'][0]['message']));
    }

    public function test_a_body_past_the_size_cap_or_not_a_feed_is_a_failure_of_that_outlet(): void
    {
        Http::fake([
            'alpha.example/*' => Http::response(str_repeat('x', 100_001)),
            'beta.example/*' => Http::response('<html>Checking your browser…</html>'),
            'news.google.com/*' => Http::response(self::feed('news.google.com', [self::google('G1', 'Rappler', 1)])),
        ]);

        $out = $this->news()->beat('local');

        $this->assertSame(['G1'], self::titles($out));
        $this->assertSame(['Alpha', 'Beta'], array_column($out['unreachable'], 'source'));
    }

    public function test_social_posts_stale_stories_and_future_stamps_are_handled_on_the_way_in(): void
    {
        $this->fakeLocal(
            [['Fresh', 2], ['Last month', 24 * 30], ['Nearly now', -0.5]],
            [['Tomorrow, apparently', -8]],
            [self::google('A whole Facebook post as a headline', 'facebook.com', 1)],
        );

        $out = $this->news()->beat('local');

        // The month-old story is gone; the stamp eight hours ahead is read as
        // undated and goes last; half an hour ahead is clock skew, and kept.
        $this->assertSame(['Nearly now', 'Fresh', 'Tomorrow, apparently'], self::titles($out));
        $this->assertNull($out['items'][2]['published_at']);
    }

    public function test_an_unknown_beat_is_refused(): void
    {
        $this->expectException(InvalidArgumentException::class);

        $this->news()->beat('sport');
    }

    public function test_a_query_searches_within_the_beat_and_narrows_its_outlets(): void
    {
        $this->fakeLocal(
            [['Flood gates open in Marikina', 1], ['Traffic on EDSA', 1]],
            [['Senate hearing', 2], ['Flooding closes roads', 3]],
            [self::google('Pasig flood warning', 'GMA Network', 2)],
        );

        $out = $this->news()->beat('local', '  Flood ');

        $this->assertSame('Flood', $out['query']);
        // "Flooding" mentions "flood"; EDSA and the Senate do not.
        $this->assertSame(['Flood gates open in Marikina', 'Pasig flood warning', 'Flooding closes roads'], self::titles($out));

        Http::assertSent(fn (Request $r) => str_starts_with($r->url(), 'https://news.google.com/rss/search')
            && self::params($r) === ['q' => 'flood metro manila', 'hl' => 'en-PH', 'gl' => 'PH', 'ceid' => 'PH:en']);
    }

    public function test_a_query_on_a_beat_with_no_search_phrase_searches_the_query_alone(): void
    {
        Http::fake([
            'gamma.example/*' => Http::response(self::feed('gamma.example', [['Nintendo shows a new Switch', 1]])),
            'news.google.com/*' => Http::response(self::feed('news.google.com', [])),
        ]);

        $out = $this->news()->beat('tech', 'nintendo');

        $this->assertSame(['Nintendo shows a new Switch'], self::titles($out));
        Http::assertSent(fn (Request $r) => str_contains($r->url(), 'news.google.com') && self::params($r)['q'] === 'nintendo');
    }

    public function test_interests_are_one_search_each_for_the_first_few_capped_and_told_once(): void
    {
        Http::fake(function (Request $r) {
            return Http::response(self::feed('news.google.com', match (self::params($r)['q']) {
                'nintendo' => [self::google('Switch 3 dated', 'Polygon', 1), self::google('Mario film', 'Variety', 2), self::google('Zelda remake', 'IGN', 3)],
                'f1' => [self::google('Switch 3 dated', 'Polygon', 1), self::google('Alonso re-signs', 'ESPN', 2)],
                default => [self::google('Should never be asked', 'Nobody', 1)],
            }));
        });

        $out = $this->news()->interests(['Nintendo', ' F1 ', 'Coffee']);

        $this->assertSame(['Nintendo', 'F1'], $out['searched']);
        $this->assertSame('interests', $out['beat']);
        $this->assertSame(
            [['Nintendo', 'Switch 3 dated'], ['Nintendo', 'Mario film'], ['F1', 'Alonso re-signs']],
            array_map(fn (array $i) => [$i['interest'], $i['title']], $out['items']),
        );
        Http::assertSentCount(2);
    }

    public function test_no_interests_is_no_search_at_all(): void
    {
        Http::fake();

        $out = $this->news()->interests([]);

        $this->assertSame([[], []], [$out['searched'], $out['items']]);
        Http::assertNothingSent();
    }

    public function test_an_item_handed_out_can_be_found_by_its_id_for_a_week(): void
    {
        $this->fakeLocal([['A1', 1]], []);

        $handed = $this->news()->beat('local')['items'][0];
        $held = $this->news()->item($handed['id']);

        $this->assertSame($handed, $held);
        $this->assertNull($this->news()->item('0123456789ab'));
        $this->assertNull($this->news()->item('../../etc'));

        $this->travel(8)->days();
        $this->assertNull($this->news()->item($handed['id']));
    }

    public function test_an_interests_item_is_held_without_the_interest_it_answered(): void
    {
        Http::fake(['news.google.com/*' => Http::response(self::feed('news.google.com', [self::google('Alonso re-signs', 'ESPN', 2)]))]);

        $item = $this->news()->interests(['F1'])['items'][0];

        $this->assertArrayNotHasKey('interest', $this->news()->item($item['id']));
    }

    public function test_seen_before_is_marked_only_by_a_read_that_asks_to_mark(): void
    {
        $this->fakeLocal([['A1', 1]], []);

        // Browsing (the HUD) first: it records nothing.
        $this->news()->beat('local');
        $this->news()->beat('local');

        $first = $this->news()->beat('local', markSeen: true)['items'][0];
        $second = $this->news()->beat('local', markSeen: true)['items'][0];

        $this->assertFalse($first['seen_before']);
        $this->assertTrue($second['seen_before']);

        // Three days on, it is news again.
        $this->travel(3 * 24 * 60 + 1)->minutes();
        Http::fake(['*' => Http::response(self::feed('alpha.example', [['A1', 1]]))]);
        $this->assertFalse($this->news()->beat('local', markSeen: true)['items'][0]['seen_before']);
    }

    public function test_the_probe_fetches_past_the_cache_and_reports_every_source(): void
    {
        $this->fakeLocal([['A1', 1], ['A2', 30]], [['B1', 2]]);

        $this->news()->beat('local');
        $rows = $this->news()->probe('local');

        $this->assertCount(6, Http::recorded());
        $this->assertSame(
            [['Alpha', 'feed', true, 2], ['Beta', 'feed', true, 1], ['Google News', 'search', true, 0]],
            array_map(fn (array $r) => [$r['source'], $r['kind'], $r['ok'], $r['items']], $rows),
        );
        $this->assertSame(now()->subHour()->utc()->toIso8601String(), $rows[0]['newest']);
    }
}
