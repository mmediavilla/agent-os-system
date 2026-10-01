<?php

namespace Tests\Feature\News;

use App\Agent\Contracts\MutatingTool;
use App\Agent\ToolRegistry;
use App\Agent\Tools\GetNews;
use App\Models\PinnedArticle;
use App\Services\News\ArticleNotHeld;
use App\Services\News\NewsService;
use App\Services\News\PinWriter;
use App\Services\Owner;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;
use Tests\Unit\News\FeedParserTest as Feed;

/**
 * The reading list (19.2): pins by id, never by URL; a snapshot that outlives
 * the registry; all or nothing; read as a timestamp — through the writer, the
 * two tools and the routes alike.
 */
class PinsTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        config([
            'agent.timezone' => 'Asia/Manila',
            'news.search' => [
                'name' => 'Google News',
                'url' => 'https://news.google.com/rss/search',
                'params' => ['hl' => 'en-PH'],
                'summaries' => false,
            ],
            'news.beats' => [
                'local' => [
                    'label' => 'Metro Manila',
                    'feeds' => [['name' => 'Alpha', 'url' => 'https://alpha.example/feed']],
                ],
                'tech' => [
                    'label' => 'Tech',
                    'feeds' => [['name' => 'Gamma', 'url' => 'https://gamma.example/feed']],
                ],
            ],
            'news.interests' => ['max' => 10, 'searched' => 5, 'per_interest' => 2],
            // Room for all three of one outlet's stories.
            'news.per_source' => 5,
        ]);

        // Noon UTC is 20:00 in Manila.
        $this->travelTo('2026-09-29 12:00:00');

        Http::fake([
            'alpha.example/*' => Http::response(Feed::rss([
                Feed::item('Flood in Marikina', 'https://alpha.example/flood', now()->subHours(2)->toRfc2822String(), 'Water rose overnight.'),
                Feed::item('MRT fare review', 'https://alpha.example/mrt', now()->subHours(5)->toRfc2822String(), 'A hearing is set.'),
                Feed::item('Undated notice', 'https://alpha.example/notice'),
            ])),
            'gamma.example/*' => Http::response(Feed::rss([])),
            'news.google.com/*' => Http::response(Feed::rss([])),
        ]);
    }

    /** The local beat, read the way the HUD reads it, so every item is held. */
    private function held(): array
    {
        return collect(app(NewsService::class)->beat('local')['items'])->keyBy('title')->all();
    }

    private function writer(): PinWriter
    {
        return app(PinWriter::class);
    }

    // ── The writer ───────────────────────────────────────────────────────────

    public function test_a_pin_is_a_snapshot_of_the_held_item(): void
    {
        $flood = $this->held()['Flood in Marikina'];

        [$done] = $this->writer()->pin([['id' => $flood['id']]]);

        $this->assertSame(PinWriter::PINNED, $done['outcome']);
        $pin = PinnedArticle::sole();
        $this->assertSame($flood['id'], $pin->item_id);
        $this->assertSame('Flood in Marikina', $pin->title);
        $this->assertSame('Alpha', $pin->source);
        $this->assertSame('https://alpha.example/flood', $pin->link);
        $this->assertSame('Water rose overnight.', $pin->summary);
        $this->assertSame('2026-09-29 10:00:00', $pin->published_at->utc()->format('Y-m-d H:i:s'));
        $this->assertNull($pin->read_at);
        $this->assertSame(Owner::id(), $pin->user_id);
    }

    public function test_a_pin_outlives_the_registry(): void
    {
        $flood = $this->held()['Flood in Marikina'];
        $this->writer()->pin([['id' => $flood['id']]]);

        // The feed and the registry both forget; the pin must not.
        Cache::flush();

        $this->assertNull(app(NewsService::class)->item($flood['id']));
        $this->assertSame('Flood in Marikina', PinnedArticle::sole()->title);

        // And re-pinning it is still the same row, not a "no longer held".
        [$done] = $this->writer()->pin([['id' => $flood['id']]]);
        $this->assertSame(PinWriter::ALREADY_PINNED, $done['outcome']);
    }

    public function test_an_undated_item_pins_undated(): void
    {
        $this->writer()->pin([['id' => $this->held()['Undated notice']['id']]]);

        $this->assertNull(PinnedArticle::sole()->published_at);
    }

    public function test_pinning_twice_is_one_row_and_says_so(): void
    {
        $flood = $this->held()['Flood in Marikina'];

        $this->writer()->pin([['id' => $flood['id']]]);
        $again = $this->writer()->pin([['id' => $flood['id']], ['id' => $flood['id']]]);

        $this->assertCount(1, $again);
        $this->assertSame(PinWriter::ALREADY_PINNED, $again[0]['outcome']);
        $this->assertSame(1, PinnedArticle::count());
    }

    public function test_an_id_not_held_pins_nothing_at_all(): void
    {
        $flood = $this->held()['Flood in Marikina'];

        try {
            $this->writer()->pin([['id' => $flood['id']], ['id' => 'abcdefabcdef']]);
            $this->fail('Expected ArticleNotHeld.');
        } catch (ArticleNotHeld $e) {
            $this->assertStringContainsString('abcdefabcdef', $e->getMessage());
            $this->assertStringContainsString('fetch the news again', $e->getMessage());
        }

        // All or nothing: the good first id was not pinned either.
        $this->assertSame(0, PinnedArticle::count());
    }

    public function test_a_title_that_is_not_the_held_one_is_refused(): void
    {
        $flood = $this->held()['Flood in Marikina'];

        // Case and spacing are not a different story.
        $this->writer()->pin([['id' => $flood['id'], 'title' => '  flood IN  marikina ']]);
        $this->assertSame(1, PinnedArticle::count());

        // A different story under that id is: the card would say one thing and pin another.
        $mrt = $this->held()['MRT fare review'];
        $this->expectException(ArticleNotHeld::class);
        $this->writer()->pin([['id' => $mrt['id'], 'title' => 'Flood in Marikina']]);
    }

    public function test_read_keeps_the_first_time_and_reopen_clears_it(): void
    {
        $this->writer()->pin([['id' => $this->held()['Flood in Marikina']['id']]]);
        $pin = PinnedArticle::sole();

        $this->writer()->read($pin);
        $first = $pin->fresh()->read_at;

        $this->travel(1)->hours();
        $this->writer()->read($pin->fresh());
        $this->assertEquals($first, $pin->fresh()->read_at);

        $this->writer()->reopen($pin->fresh());
        $this->assertNull($pin->fresh()->read_at);
    }

    public function test_read_at_is_not_fillable(): void
    {
        $this->assertNotContains('read_at', (new PinnedArticle)->getFillable());
    }

    // ── pin_articles ──────────────────────────────────────────────────────────

    public function test_pin_articles_is_a_gated_news_write_registered_after_get_news(): void
    {
        $registry = app(ToolRegistry::class);
        $names = array_keys($registry->all());

        $this->assertInstanceOf(MutatingTool::class, $registry->get('pin_articles'));
        $this->assertSame(['get_news', 'pin_articles', 'list_pinned_articles'], array_slice($names, -3));
        // Voice is read-only, so it never sees the write.
        $this->assertFalse($registry->readOnly()->has('pin_articles'));
    }

    public function test_pin_articles_takes_the_whole_list_in_one_call(): void
    {
        $held = $this->held();

        $out = app(ToolRegistry::class)->attempt('pin_articles', ['articles' => [
            ['id' => $held['Flood in Marikina']['id'], 'title' => 'Flood in Marikina'],
            ['id' => $held['MRT fare review']['id'], 'title' => 'MRT fare review'],
        ]]);

        $this->assertFalse($out['is_error']);
        $this->assertSame(2, PinnedArticle::count());
        $this->assertStringContainsString('"outcome":"pinned"', $out['text']);
    }

    public function test_pin_articles_refuses_what_it_cannot_resolve_as_a_sentence(): void
    {
        $registry = app(ToolRegistry::class);

        // An id that is not an id, a missing title, an empty list: validation.
        foreach ([
            ['articles' => [['id' => 'https://alpha.example/flood', 'title' => 'Flood in Marikina']]],
            ['articles' => [['id' => 'abcdefabcdef']]],
            ['articles' => []],
        ] as $input) {
            $this->assertTrue($registry->attempt('pin_articles', $input)['is_error'], json_encode($input));
        }

        // A well-formed id nobody handed out: the writer's sentence, nothing written.
        $out = $registry->attempt('pin_articles', ['articles' => [['id' => 'abcdefabcdef', 'title' => 'Anything']]]);
        $this->assertTrue($out['is_error']);
        $this->assertStringContainsString('fetch the news again', $out['text']);
        $this->assertSame(0, PinnedArticle::count());
    }

    public function test_get_news_marks_what_is_already_pinned(): void
    {
        $this->writer()->pin([['id' => $this->held()['Flood in Marikina']['id']]]);

        $items = collect(app(GetNews::class)->handle(['beat' => 'local'])['items'])->keyBy('title');

        $this->assertTrue($items['Flood in Marikina']['pinned']);
        $this->assertArrayNotHasKey('pinned', $items['MRT fare review']);
        $this->assertStringContainsString('pin_articles', app(GetNews::class)->description());
    }

    // ── list_pinned_articles ──────────────────────────────────────────────────

    public function test_the_list_is_unread_first_on_the_owners_clock(): void
    {
        $held = $this->held();
        $this->writer()->pin([['id' => $held['Flood in Marikina']['id']]]);
        $this->travel(10)->minutes();
        $this->writer()->pin([['id' => $held['MRT fare review']['id']]]);
        $this->travel(10)->minutes();
        $this->writer()->pin([['id' => $held['Undated notice']['id']]]);
        $this->writer()->read(PinnedArticle::where('title', 'Undated notice')->sole());

        $out = app(ToolRegistry::class)->get('list_pinned_articles')->handle([]);

        // Unread newest pin first, then read.
        $this->assertSame(['MRT fare review', 'Flood in Marikina', 'Undated notice'], array_column($out['articles'], 'title'));
        $this->assertSame(3, $out['total_matching']);
        $this->assertSame(2, $out['unread']);

        [, $flood, $notice] = $out['articles'];
        // 10:00 UTC is 18:00 in Manila: wall clock, no offset.
        $this->assertSame('2026-09-29T18:00:00', $flood['published_at']);
        $this->assertSame('2026-09-29T20:00:00', $flood['pinned_at']);
        $this->assertSame($held['Flood in Marikina']['id'], $flood['id']);
        $this->assertArrayNotHasKey('read_on', $flood);
        $this->assertSame('2026-09-29', $notice['read_on']);
        $this->assertArrayNotHasKey('published_at', $notice);

        $unread = app(ToolRegistry::class)->get('list_pinned_articles')->handle(['status' => 'unread']);
        $this->assertSame(2, $unread['total_matching']);
    }

    public function test_the_list_is_a_read_voice_has(): void
    {
        $this->assertTrue(app(ToolRegistry::class)->readOnly()->has('list_pinned_articles'));
    }

    // ── The routes ───────────────────────────────────────────────────────────

    public function test_the_hud_reads_a_beat_without_marking_it_seen(): void
    {
        $this->getJson('/api/news?beat=local')
            ->assertOk()
            ->assertJsonPath('beat', 'local')
            ->assertJsonPath('items.0.title', 'Flood in Marikina')
            ->assertJsonPath('items.0.pinned', false)
            ->assertJsonPath('items.0.pin_id', null)
            ->assertJsonPath('beats.0', ['key' => 'local', 'label' => 'Metro Manila'])
            ->assertJsonPath('beats.2', ['key' => 'interests', 'label' => 'Your interests']);

        // Browsing is not being told: the assistant's first briefing is still new.
        $first = app(GetNews::class)->handle(['beat' => 'local']);
        $this->assertArrayNotHasKey('seen_before', $first['items'][0]);
    }

    public function test_the_first_beat_is_the_default_and_an_unknown_one_is_a_422(): void
    {
        $this->getJson('/api/news')->assertOk()->assertJsonPath('beat', 'local');
        $this->getJson('/api/news?beat=sports')->assertStatus(422)->assertJsonValidationErrors(['beat']);
        $this->getJson('/api/news?beat=local&query='.str_repeat('x', 101))->assertStatus(422);
    }

    public function test_interests_with_none_set_are_an_empty_search(): void
    {
        $this->getJson('/api/news?beat=interests')
            ->assertOk()
            ->assertJsonPath('beat', 'interests')
            ->assertJsonPath('searched', [])
            ->assertJsonPath('items', []);
    }

    public function test_a_pin_from_the_hud_is_201_then_200(): void
    {
        $id = $this->held()['Flood in Marikina']['id'];

        $this->postJson('/api/news/pins', ['item_id' => $id])
            ->assertCreated()
            ->assertJsonPath('item_id', $id)
            ->assertJsonPath('title', 'Flood in Marikina')
            ->assertJsonPath('read_at', null);

        $this->postJson('/api/news/pins', ['item_id' => $id])->assertOk();
        $this->assertSame(1, PinnedArticle::count());

        $this->getJson('/api/news?beat=local')
            ->assertJsonPath('items.0.pinned', true)
            ->assertJsonPath('items.0.pin_id', PinnedArticle::sole()->id);
    }

    public function test_the_browser_cannot_pin_a_url_or_an_id_not_held(): void
    {
        $this->postJson('/api/news/pins', ['item_id' => 'https://alpha.example/flood'])
            ->assertStatus(422)
            ->assertJsonValidationErrors(['item_id']);

        $this->postJson('/api/news/pins', ['item_id' => 'abcdefabcdef'])
            ->assertStatus(422)
            ->assertJsonValidationErrors(['item_id']);

        $this->assertSame(0, PinnedArticle::count());
    }

    public function test_the_list_route_counts_the_unread(): void
    {
        $held = $this->held();
        $this->writer()->pin([['id' => $held['Flood in Marikina']['id']], ['id' => $held['MRT fare review']['id']]]);
        $this->writer()->read(PinnedArticle::where('title', 'Flood in Marikina')->sole());

        $this->getJson('/api/news/pins')
            ->assertOk()
            ->assertJsonPath('unread', 1)
            ->assertJsonPath('data.0.title', 'MRT fare review')
            ->assertJsonPath('data.1.title', 'Flood in Marikina');
    }

    public function test_read_reopen_and_remove(): void
    {
        $this->writer()->pin([['id' => $this->held()['Flood in Marikina']['id']]]);
        $pin = PinnedArticle::sole();

        $this->postJson("/api/news/pins/{$pin->id}/read")->assertOk();
        $this->assertNotNull($pin->fresh()->read_at);

        $this->deleteJson("/api/news/pins/{$pin->id}/read")->assertOk()->assertJsonPath('read_at', null);

        $this->deleteJson("/api/news/pins/{$pin->id}")->assertNoContent();
        $this->assertSame(0, PinnedArticle::count());

        $this->postJson("/api/news/pins/{$pin->id}/read")->assertNotFound();
    }

    public function test_a_patch_cannot_mark_a_pin_read(): void
    {
        // There is no PATCH route at all: the fields are a snapshot, and
        // reading has its own.
        $this->writer()->pin([['id' => $this->held()['Flood in Marikina']['id']]]);

        $this->patchJson('/api/news/pins/'.PinnedArticle::sole()->id, ['read_at' => now()])->assertStatus(405);
    }
}
