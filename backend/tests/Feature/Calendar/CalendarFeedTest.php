<?php

namespace Tests\Feature\Calendar;

use App\Models\CalendarFeed;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

/**
 * /api/calendar/feeds — what Settings does with an address.
 */
class CalendarFeedTest extends TestCase
{
    use RefreshDatabase;

    private const URL = CalendarTest::PERSONAL;

    protected function setUp(): void
    {
        parent::setUp();

        config(['agent.timezone' => 'Asia/Manila']);
        $this->travelTo('2026-09-10 02:00:00');
    }

    public function test_adding_a_calendar_reads_its_name_off_the_feed(): void
    {
        Http::fake(['*' => Http::response(CalendarTest::dentist())]);

        $response = $this->postJson('/api/calendar/feeds', ['url' => self::URL])->assertCreated();

        $response->assertJson(['name' => 'Personal', 'color' => 'tomato', 'enabled' => true, 'status' => 'ok']);
        $this->assertArrayNotHasKey('url', $response->json());
        $this->assertStringNotContainsString('private-a1b2c3', $response->getContent());
    }

    public function test_the_probe_seeds_the_cache_so_the_first_read_does_not_fetch_again(): void
    {
        Http::fake(['*' => Http::response(CalendarTest::dentist())]);

        $this->postJson('/api/calendar/feeds', ['url' => self::URL])->assertCreated();
        $this->getJson('/api/calendar?from=2026-09-10&to=2026-09-10')
            ->assertOk()
            ->assertJsonPath('events.0.title', 'Dentist');

        Http::assertSentCount(1);
    }

    public function test_a_second_calendar_gets_the_next_colour_unless_one_is_picked(): void
    {
        Http::fake(['*' => Http::response(CalendarTest::dentist())]);

        $this->postJson('/api/calendar/feeds', ['url' => self::URL])->assertJsonPath('color', 'tomato');
        $this->postJson('/api/calendar/feeds', ['url' => CalendarTest::WORK])->assertJsonPath('color', 'flamingo');
        $this->postJson('/api/calendar/feeds', [
            'url' => str_replace('d4e5f6', 'g7h8i9', CalendarTest::WORK),
            'color' => 'graphite',
        ])->assertJsonPath('color', 'graphite');
    }

    public function test_any_providers_ical_address_is_accepted(): void
    {
        Http::fake(['*' => Http::response(CalendarTest::dentist())]);

        foreach ([
            self::URL,                                                                   // Google's secret address
            'webcal://p52-caldav.icloud.com/published/2/MTIzNDU2Nzg5MDEy',                // iCloud's public link
            'https://outlook.office365.com/owa/calendar/abc@example.com/def/calendar.ics', // Outlook's published ICS
            'https://cloud.example.org:8443/remote.php/dav/public-calendars/xyz?export',   // a Nextcloud share
        ] as $url) {
            $this->postJson('/api/calendar/feeds', ['url' => $url])->assertCreated();
        }

        $this->assertSame(4, CalendarFeed::count());
    }

    public function test_a_webcal_link_is_stored_and_fetched_as_https(): void
    {
        Http::fake(['*' => Http::response(CalendarTest::dentist())]);

        $this->postJson('/api/calendar/feeds', ['url' => 'webcal://p52-caldav.icloud.com/published/2/abc'])->assertCreated();

        $this->assertSame('https://p52-caldav.icloud.com/published/2/abc', CalendarFeed::first()->url);
        Http::assertSent(fn ($request) => $request->url() === 'https://p52-caldav.icloud.com/published/2/abc');

        // The same calendar in its other spelling is the same calendar.
        $this->postJson('/api/calendar/feeds', ['url' => 'https://p52-caldav.icloud.com/published/2/abc'])
            ->assertUnprocessable()
            ->assertJsonPath('errors.url.0', 'That calendar is already added.');
    }

    public function test_an_address_inside_this_network_is_refused_without_being_asked(): void
    {
        $this->fakeDns([
            'projectmc.test' => ['127.0.0.1'],
            'router.lan' => ['192.168.1.1'],
            'split.example.com' => ['93.184.215.14', '::1'],   // public on one family, loopback on the other
            'nowhere.example' => [],
        ]);
        Http::fake();

        foreach ([
            'https://127.0.0.1/calendar.ics' => 'inside this computer or its network',
            'https://[::1]/calendar.ics' => 'inside this computer or its network',
            'https://169.254.169.254/latest/meta-data' => 'inside this computer or its network',
            'https://projectmc.test/api/calendar' => 'inside this computer or its network',
            'webcal://router.lan/cal.ics' => 'inside this computer or its network',
            'https://split.example.com/cal.ics' => 'inside this computer or its network',
            'https://nowhere.example/cal.ics' => 'could not be found',
            'http://calendar.google.com/calendar/ical/x/basic.ics' => 'unencrypted',
            'https://user:pw@calendar.google.com/calendar/ical/x/basic.ics' => 'username or password',
            'ftp://example.com/cal.ics' => 'starts with https:// or webcal://',
            'not a url' => 'not a web address',
        ] as $url => $reason) {
            $message = $this->postJson('/api/calendar/feeds', ['url' => $url])
                ->assertUnprocessable()
                ->json('errors.url.0');

            $this->assertStringContainsString($reason, $message, $url);
            $this->assertStringNotContainsString($url, $message, 'a refusal never quotes the address');
        }

        // The point is that the server never fetched any of them.
        Http::assertNothingSent();
        $this->assertSame(0, CalendarFeed::count());
    }

    public function test_an_address_that_is_not_a_calendar_is_refused_with_a_sentence(): void
    {
        Http::fake(['*' => Http::response('<!doctype html><title>Sign in</title>')]);

        $response = $this->postJson('/api/calendar/feeds', ['url' => self::URL])->assertUnprocessable();

        $this->assertStringContainsString('Secret address in iCal format', $response->json('errors.url.0'));
        $this->assertSame(0, CalendarFeed::count());
    }

    public function test_an_address_google_does_not_know_is_refused(): void
    {
        Http::fake(['*' => Http::response('Not Found', 404)]);

        $this->postJson('/api/calendar/feeds', ['url' => self::URL])
            ->assertUnprocessable()
            ->assertJsonValidationErrors('url');

        $this->assertSame(0, CalendarFeed::count());
    }

    public function test_the_same_calendar_cannot_be_added_twice(): void
    {
        Http::fake(['*' => Http::response(CalendarTest::dentist())]);

        $this->postJson('/api/calendar/feeds', ['url' => self::URL])->assertCreated();

        // Compared by hash — the ciphertext differs on every write, so the
        // column itself can never match.
        $this->postJson('/api/calendar/feeds', ['url' => ' '.self::URL.' '])
            ->assertUnprocessable()
            ->assertJsonPath('errors.url.0', 'That calendar is already added.');

        Http::assertSentCount(1);
    }

    public function test_an_unknown_colour_is_refused(): void
    {
        Http::fake();

        $this->postJson('/api/calendar/feeds', ['url' => self::URL, 'color' => 'teal'])
            ->assertJsonValidationErrors('color');
    }

    public function test_a_calendar_can_be_renamed_recoloured_and_switched_off(): void
    {
        $feed = CalendarFeed::create(['url' => self::URL, 'name' => 'Personal', 'color' => 'tomato']);

        $this->patchJson("/api/calendar/feeds/{$feed->id}", ['name' => 'Home', 'color' => 'sage', 'enabled' => false])
            ->assertOk()
            ->assertJson(['name' => 'Home', 'color' => 'sage', 'enabled' => false]);

        // A blank name is no name, and the panel falls back to its own label.
        $this->patchJson("/api/calendar/feeds/{$feed->id}", ['name' => '  '])->assertJsonPath('name', null);
    }

    public function test_the_address_cannot_be_changed_in_place(): void
    {
        $feed = CalendarFeed::create(['url' => self::URL, 'color' => 'tomato']);

        $this->patchJson("/api/calendar/feeds/{$feed->id}", ['url' => CalendarTest::WORK])
            ->assertUnprocessable()
            ->assertJsonPath('errors.url.0', 'The address cannot be changed. Remove the calendar and add the new address.');

        $this->assertSame(self::URL, $feed->fresh()->url);
    }

    public function test_removing_a_calendar_forgets_what_was_read_from_it(): void
    {
        Http::fake(['*' => Http::response(CalendarTest::dentist())]);

        $id = $this->postJson('/api/calendar/feeds', ['url' => self::URL])->json('id');

        $this->deleteJson("/api/calendar/feeds/{$id}")->assertNoContent();

        $this->assertSame(0, CalendarFeed::count());
        $this->getJson('/api/calendar?from=2026-09-10&to=2026-09-10')->assertJson(['configured' => false, 'events' => []]);
        $this->assertNull(cache("calendar.feed.{$id}.reading"));
    }

    public function test_the_list_never_fetches_and_never_shows_an_address(): void
    {
        Http::fake();
        CalendarFeed::create(['url' => self::URL, 'name' => 'Personal', 'color' => 'tomato']);
        CalendarFeed::create(['url' => CalendarTest::WORK, 'name' => 'Work', 'color' => 'sage', 'enabled' => false]);

        $response = $this->getJson('/api/calendar/feeds')->assertOk();

        // Disabled ones included — Settings is where they are switched back on.
        $this->assertSame(['Personal', 'Work'], array_column($response->json('data'), 'name'));
        $this->assertSame(['pending', 'pending'], array_column($response->json('data'), 'status'));
        $this->assertStringNotContainsString('calendar.google.com', $response->getContent());

        Http::assertNothingSent();
    }
}
