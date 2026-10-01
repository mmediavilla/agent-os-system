<?php

namespace Tests\Feature\Calendar;

use App\Models\CalendarFeed;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Schema;
use Tests\TestCase;
use Tests\Unit\Calendar\IcsReaderTest;

/**
 * GET /api/calendar — the feeds, the cache, and what the page is told.
 *
 * What an event *means* is IcsReaderTest's; this is about which feeds are
 * asked, how often, what is kept when a provider does not answer, where a
 * fetch may go, and that the address never comes back out.
 */
class CalendarTest extends TestCase
{
    use RefreshDatabase;

    public const PERSONAL = 'https://calendar.google.com/calendar/ical/me%40gmail.com/private-a1b2c3/basic.ics';

    public const WORK = 'https://calendar.google.com/calendar/ical/work%40example.com/private-d4e5f6/basic.ics';

    /** iCloud's public calendar link, as stored — the `webcal://` it is shared as, made https. */
    public const ICLOUD = 'https://p52-caldav.icloud.com/published/2/MTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkw';

    protected function setUp(): void
    {
        parent::setUp();

        config(['agent.timezone' => 'Asia/Manila', 'calendar.ttl' => 300, 'calendar.failure_ttl' => 60]);

        // Thursday the 10th, ten in the morning in Manila.
        $this->travelTo('2026-09-10 02:00:00');
    }

    public static function dentist(): string
    {
        return IcsReaderTest::ics([<<<'ICS'
            UID:dentist@google.com
            DTSTART:20260910T070000Z
            DTEND:20260910T074500Z
            SUMMARY:Dentist
            ICS], 'Personal');
    }

    public static function standup(): string
    {
        return IcsReaderTest::ics([<<<'ICS'
            UID:standup@google.com
            DTSTART:20260910T010000Z
            DTEND:20260910T011500Z
            SUMMARY:Standup
            ICS], 'Work');
    }

    private function feed(string $url = self::PERSONAL, array $attrs = []): CalendarFeed
    {
        return CalendarFeed::create($attrs + ['url' => $url, 'name' => 'Personal', 'color' => 'peacock']);
    }

    private function week()
    {
        return $this->getJson('/api/calendar?from=2026-09-10&to=2026-09-16');
    }

    public function test_the_apps_own_calendar_is_gone(): void
    {
        // 10.2 dropped it rather than merging it in: the owner makes events in Google
        // Calendar, so a second calendar here would be one nobody writes to.
        $this->assertFalse(Schema::hasTable('events'));
        $this->getJson('/api/events')->assertNotFound();
    }

    public function test_with_no_calendars_it_says_so_and_asks_nobody(): void
    {
        Http::fake();

        $this->week()->assertOk()->assertJson([
            'configured' => false,
            'events' => [],
            'feeds' => [],
        ]);

        Http::assertNothingSent();
    }

    public function test_it_merges_every_calendar_into_one_list_in_time_order(): void
    {
        Http::fake([
            'calendar.google.com/calendar/ical/me*' => Http::response(self::dentist()),
            'calendar.google.com/calendar/ical/work*' => Http::response(self::standup()),
        ]);

        $personal = $this->feed();
        $work = $this->feed(self::WORK, ['name' => 'Work', 'color' => 'tomato']);

        $response = $this->week()->assertOk();

        // One list, not one per calendar: the 09:00 standup from Work comes
        // before the 15:00 dentist from Personal.
        $this->assertSame(
            [[$work->id, 'Standup', '2026-09-10T09:00:00'], [$personal->id, 'Dentist', '2026-09-10T15:00:00']],
            array_map(fn ($e) => [$e['calendar_id'], $e['title'], $e['starts_at']], $response->json('events')),
        );

        $this->assertSame(['ok', 'ok'], array_column($response->json('feeds'), 'status'));
        $this->assertSame(['peacock', 'tomato'], array_column($response->json('feeds'), 'color'));
    }

    public function test_the_address_never_comes_back_out(): void
    {
        Http::fake(['*' => Http::response(self::dentist())]);
        $this->feed();

        $body = $this->week()->assertOk()->getContent();

        $this->assertStringNotContainsString('private-a1b2c3', $body);
        $this->assertStringNotContainsString('calendar.google.com', $body);
    }

    public function test_the_address_is_encrypted_at_rest(): void
    {
        $this->feed();

        $stored = CalendarFeed::query()->toBase()->value('url');

        $this->assertStringNotContainsString('private-a1b2c3', $stored);
        $this->assertSame(self::PERSONAL, CalendarFeed::first()->url);
    }

    public function test_each_feed_is_cached(): void
    {
        Http::fake(['*' => Http::response(self::dentist())]);
        $this->feed();

        $this->week()->assertOk();
        $this->week()->assertOk();
        $this->getJson('/api/calendar?from=2026-09-01&to=2026-09-30')->assertOk();

        // Polled for as long as the HUD is open, and a different window is the
        // same feed: one fetch serves all of them.
        Http::assertSentCount(1);

        $this->travel(301)->seconds();
        $this->week()->assertOk();
        Http::assertSentCount(2);
    }

    public function test_a_failed_fetch_keeps_the_last_reading_and_says_so(): void
    {
        Http::fakeSequence()
            ->push(self::dentist())
            ->push('', 503);
        $this->feed();

        $this->week()->assertOk();
        $this->travel(301)->seconds();

        $response = $this->week()->assertOk();

        // The week has not emptied — Google did not answer, which is a different
        // statement, and the panel can only tell them apart if it is told.
        $this->assertSame(['Dentist'], array_column($response->json('events'), 'title'));
        $response->assertJsonPath('feeds.0.status', 'failed');
        $response->assertJsonPath('feeds.0.message', 'The calendar answered 503.');
        $this->assertNotNull($response->json('feeds.0.fetched_at'));
    }

    public function test_a_failure_is_remembered_briefly(): void
    {
        Http::fake(['*' => Http::response('', 500)]);
        $this->feed();

        $this->week()->assertOk()->assertJsonPath('feeds.0.status', 'failed');
        $this->week()->assertOk();

        // Without it an outage turns an open tab into a retry loop against
        // Google; with the full five minutes it outlasts most outages.
        Http::assertSentCount(1);

        $this->travel(61)->seconds();
        $this->week()->assertOk();
        Http::assertSentCount(2);
    }

    public function test_an_unreachable_host_is_described_without_the_address(): void
    {
        Http::fake(['*' => Http::failedConnection('cURL error 28: timed out for '.self::PERSONAL)]);
        $this->feed();

        $response = $this->week()->assertOk();

        // Guzzle quotes the URL it failed on. That message must never be what
        // the panel — or the model — is shown.
        $response->assertJsonPath('feeds.0.message', 'The calendar could not be reached.');
        $this->assertStringNotContainsString('private-a1b2c3', $response->getContent());
    }

    public function test_a_reset_address_is_named_as_one(): void
    {
        Http::fake(['*' => Http::response('Not Found', 404)]);
        $this->feed();

        $this->assertStringContainsString(
            'no longer recognises this address',
            $this->week()->assertOk()->json('feeds.0.message'),
        );
    }

    public function test_a_disabled_calendar_is_neither_fetched_nor_shown(): void
    {
        Http::fake(['*' => Http::response(self::dentist())]);
        $this->feed(self::PERSONAL, ['enabled' => false]);

        $this->week()->assertOk()->assertJson(['configured' => true, 'events' => [], 'feeds' => []]);

        Http::assertNothingSent();
    }

    public function test_a_redirect_to_a_public_host_is_followed(): void
    {
        Http::fake([
            'calendar.google.com/*' => Http::response('', 301, ['Location' => 'https://p52-caldav.icloud.com/published/2/abc']),
            'p52-caldav.icloud.com/*' => Http::response(self::dentist()),
        ]);
        $this->feed();

        $this->assertSame(['Dentist'], array_column($this->week()->assertOk()->json('events'), 'title'));
        Http::assertSentCount(2);
    }

    public function test_a_redirect_is_checked_before_it_is_followed(): void
    {
        $this->fakeDns(['intranet.test' => ['10.0.0.5']]);
        Http::fake(['*' => Http::response('', 302, ['Location' => 'https://intranet.test/admin'])]);
        $this->feed();

        // The address passed when it was saved; the hop is somewhere that check
        // never saw, so it gets one of its own — and fails it before it is asked.
        $this->week()->assertOk()
            ->assertJsonPath('feeds.0.status', 'failed')
            ->assertJsonPath('feeds.0.message', 'The calendar redirected to somewhere this server will not follow.');
        Http::assertSentCount(1);
    }

    public function test_a_redirect_to_plain_http_is_not_followed(): void
    {
        Http::fake(['*' => Http::response('', 302, ['Location' => 'http://127.0.0.1/admin'])]);
        $this->feed();

        $this->week()->assertOk()->assertJsonPath('feeds.0.status', 'failed');
        Http::assertSentCount(1);
    }

    public function test_an_address_that_now_points_inside_the_network_is_not_fetched(): void
    {
        Http::fake();
        $this->feed();

        // Public when it was saved; the name has since been pointed at this
        // machine. The check runs before every fetch, not only on the form.
        $this->fakeDns(['calendar.google.com' => ['93.184.215.14', '127.0.0.1']]);

        $this->week()->assertOk()
            ->assertJsonPath('feeds.0.status', 'failed')
            ->assertJsonPath('feeds.0.message', 'That address points inside this computer or its network, so this server will not fetch it.');
        Http::assertNothingSent();
    }

    public function test_an_icloud_calendar_is_read_like_any_other(): void
    {
        Http::fake(['p52-caldav.icloud.com/*' => Http::response(self::dentist())]);
        $this->feed(self::ICLOUD);

        $this->assertSame(['Dentist'], array_column($this->week()->assertOk()->json('events'), 'title'));
    }

    public function test_the_window_is_inclusive_by_local_date(): void
    {
        Http::fake(['*' => Http::response(IcsReaderTest::ics([
            <<<'ICS'
            UID:late@google.com
            DTSTART:20260916T130000Z
            SUMMARY:Late on the last day
            ICS,
            <<<'ICS'
            UID:next@google.com
            DTSTART:20260916T170000Z
            SUMMARY:First thing after
            ICS,
        ]))]);
        $this->feed();

        // 21:00 on the 16th is in a window that ends on the 16th; 01:00 on the
        // 17th is not — even though both are the 16th in UTC.
        $this->assertSame(['Late on the last day'], array_column($this->week()->json('events'), 'title'));
    }

    public function test_both_bounds_are_required_and_the_window_is_capped(): void
    {
        $this->getJson('/api/calendar')->assertUnprocessable()->assertJsonValidationErrors(['from', 'to']);
        $this->getJson('/api/calendar?from=2026-09-10&to=2026-09-01')->assertUnprocessable()->assertJsonValidationErrors('to');
        $this->getJson('/api/calendar?from=2026-09-10&to=2027-09-10')->assertUnprocessable()->assertJsonValidationErrors('to');
        $this->getJson('/api/calendar?from=2026-09-01&to=2026-12-01')->assertOk();
    }
}
