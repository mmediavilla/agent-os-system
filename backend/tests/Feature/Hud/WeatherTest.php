<?php

namespace Tests\Feature\Hud;

use App\Services\Weather\WeatherService;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Illuminate\Validation\ValidationException;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

class WeatherTest extends TestCase
{
    protected function setUp(): void
    {
        parent::setUp();

        config(['agent.timezone' => 'Asia/Manila']);
    }

    /**
     * Open-Meteo's answer, in its own shape: columns, and wall clock on the
     * zone it was asked for, with no offset.
     */
    public static function openMeteo(array $current = []): array
    {
        $hours = [];
        $at = CarbonImmutable::parse('2026-09-06 00:00');
        for ($i = 0; $i < 24 * WeatherService::FORECAST_DAYS; $i++) {
            $hours[] = $at->addHours($i)->format('Y-m-d\TH:i');
        }

        $days = array_map(fn ($i) => $at->addDays($i)->format('Y-m-d'), range(0, WeatherService::FORECAST_DAYS - 1));

        return [
            'current' => array_merge([
                'time' => '2026-09-06T14:00',
                'temperature_2m' => 28.6,
                'apparent_temperature' => 33.9,
                'relative_humidity_2m' => 78,
                'precipitation_probability' => 40,
                'weather_code' => 2,
                'wind_speed_10m' => 11.4,
                'wind_direction_10m' => 225,
                'is_day' => 1,
            ], $current),
            'hourly' => [
                'time' => $hours,
                'temperature_2m' => array_map(fn ($i) => 25 + $i % 24 / 4, array_keys($hours)),
                'precipitation_probability' => array_map(fn ($i) => $i % 24 >= 15 ? 70 : 10, array_keys($hours)),
                'weather_code' => array_map(fn ($i) => $i % 24 >= 15 ? 61 : 1, array_keys($hours)),
                'is_day' => array_map(fn ($i) => (int) ($i % 24 >= 6 && $i % 24 < 18), array_keys($hours)),
            ],
            'daily' => [
                'time' => $days,
                'weather_code' => array_fill(0, count($days), 63),
                'temperature_2m_max' => array_fill(0, count($days), 31.2),
                'temperature_2m_min' => array_fill(0, count($days), 24.8),
                'precipitation_probability_max' => array_fill(0, count($days), 80),
                'precipitation_sum' => array_fill(0, count($days), 12.4),
                'wind_speed_10m_max' => array_fill(0, count($days), 18.0),
                'uv_index_max' => array_fill(0, count($days), 9.1),
                'sunrise' => array_map(fn ($d) => "{$d}T05:43", $days),
                'sunset' => array_map(fn ($d) => "{$d}T18:01", $days),
            ],
        ];
    }

    private function configure(): void
    {
        config([
            'hud.weather.latitude' => 14.6,
            'hud.weather.longitude' => 121.0,
            'hud.weather.label' => 'Manila',
        ]);
    }

    #[Test]
    public function it_says_it_is_unconfigured_rather_than_broken(): void
    {
        config(['hud.weather.latitude' => null, 'hud.weather.longitude' => null]);
        Http::fake();

        $response = $this->getJson('/api/weather')->assertOk();

        // Two different states, deliberately. Collapsing them would put
        // "unavailable" on a machine that was simply never told where it is —
        // and no location is guessed, because an IP lookup is a request to a
        // third party the user did not ask for.
        $this->assertFalse($response->json('configured'));
        $this->assertFalse($response->json('available'));

        Http::assertNothingSent();
    }

    #[Test]
    public function it_reads_the_current_conditions(): void
    {
        $this->configure();
        Http::fake(['*' => Http::response(self::openMeteo())]);

        $response = $this->getJson('/api/weather')->assertOk();

        $response->assertJson([
            'configured' => true,
            'available' => true,
            'label' => 'Manila',
            'condition' => 'Partly cloudy',
            'temperature_c' => 28.6,
            'apparent_c' => 33.9,
            'humidity' => 78,
            'precipitation_chance' => 40,
            'wind_kph' => 11.4,
            // Where it is coming *from*, as one of eight points.
            'wind_from' => 'SW',
            'is_day' => true,
        ]);
    }

    #[Test]
    public function it_asks_on_the_users_clock_and_reads_the_answer_on_it(): void
    {
        $this->configure();
        Http::fake(['*' => Http::response(self::openMeteo())]);

        $response = $this->getJson('/api/weather')->assertOk();

        // The daily rows are bucketed on the zone the request names, and a UTC
        // day is 08:00 to 08:00 in Manila — "tomorrow's high" would straddle two
        // days. So the zone is the user's.
        Http::assertSent(fn ($request) => $request['timezone'] === 'Asia/Manila');

        // What comes back is that zone's wall clock with no offset. Read *in*
        // the zone it is an instant eight hours earlier; read as UTC it would be
        // a wrong instant dressed as a precise one.
        $this->assertSame('2026-09-06T06:00:00+00:00', $response->json('observed_at'));
    }

    #[Test]
    public function it_sends_the_hud_the_next_day_of_hours_and_a_week_of_days(): void
    {
        $this->configure();
        Http::fake(['*' => Http::response(self::openMeteo())]);
        $this->travelTo(CarbonImmutable::parse('2026-09-06 14:20', 'Asia/Manila'));

        $response = $this->getJson('/api/weather')->assertOk();

        // From the hour in progress, on the user's clock — not the server's,
        // which would start the strip eight hours ago.
        $hourly = $response->json('hourly');
        $this->assertCount(WeatherService::HUD_HOURS, $hourly);
        $this->assertSame('2026-09-06T14:00:00', $hourly[0]['time']);
        $this->assertSame('2026-09-07T13:00:00', $hourly[23]['time']);
        $this->assertSame('Light rain', $hourly[1]['condition']);

        $daily = $response->json('daily');
        $this->assertCount(WeatherService::FORECAST_DAYS, $daily);
        // Equals, not Same: JSON writes 80.0 as 80.
        $this->assertEquals([
            'date' => '2026-09-06',
            'condition' => 'Rain',
            'weather_code' => 63,
            'high_c' => 31.2,
            'low_c' => 24.8,
            'precipitation_chance' => 80.0,
            'precipitation_mm' => 12.4,
            'wind_max_kph' => 18.0,
            'uv_index' => 9.1,
            // Wall clock, like the calendar's times.
            'sunrise' => '2026-09-06T05:43:00',
            'sunset' => '2026-09-06T18:01:00',
        ], $daily[0]);
    }

    #[Test]
    public function an_unmapped_code_gets_a_word_rather_than_a_number(): void
    {
        config(['hud.weather.latitude' => 1, 'hud.weather.longitude' => 1]);
        Http::fake(['*' => Http::response(self::openMeteo(['weather_code' => 4]))]);

        $this->getJson('/api/weather')
            ->assertOk()
            ->assertJson(['condition' => 'Unsettled', 'weather_code' => 4]);
    }

    #[Test]
    public function it_caches_the_forecast(): void
    {
        config(['hud.weather.latitude' => 1, 'hud.weather.longitude' => 1]);
        Http::fake(['*' => Http::response(self::openMeteo())]);

        $this->getJson('/api/weather')->assertOk();
        $this->getJson('/api/weather')->assertOk();
        $this->getJson('/api/weather')->assertOk();

        // The panel is polled for as long as the tab is open; the upstream model
        // updates far less often than that.
        Http::assertSentCount(1);
    }

    #[Test]
    public function an_upstream_failure_is_a_state_of_the_panel_not_a_500(): void
    {
        config(['hud.weather.latitude' => 1, 'hud.weather.longitude' => 1]);
        Http::fake(['*' => Http::response('', 503)]);

        $response = $this->getJson('/api/weather')->assertOk();

        $this->assertTrue($response->json('configured'));
        $this->assertFalse($response->json('available'));

        // Cached too, briefly: without it an outage turns an open tab into a
        // retry loop against someone else's API for the rest of the day.
        $this->getJson('/api/weather')->assertOk();
        Http::assertSentCount(1);
    }

    #[Test]
    public function a_failure_is_cached_for_far_less_time_than_a_forecast(): void
    {
        config([
            'hud.weather.latitude' => 1,
            'hud.weather.longitude' => 1,
            'hud.weather.ttl' => 600,
            'hud.weather.failure_ttl' => 60,
        ]);
        Http::fake(['*' => Http::response('', 500)]);

        app(WeatherService::class)->current();

        $this->assertNotNull(Cache::get(WeatherService::CACHE_KEY));

        // Ten minutes of "unavailable" would outlast most outages.
        $this->travel(90)->seconds();
        $this->assertNull(Cache::get(WeatherService::CACHE_KEY));
    }

    // ── a place by name ───────────────────────────────────────────────────────

    #[Test]
    public function a_qualifier_chooses_among_the_matches_rather_than_being_sent(): void
    {
        Http::fake(['*geocoding*' => Http::response(['results' => [
            ['name' => 'Paris', 'admin1' => 'Île-de-France', 'country' => 'France', 'country_code' => 'FR', 'latitude' => 48.85, 'longitude' => 2.35, 'timezone' => 'Europe/Paris'],
            ['name' => 'Paris', 'admin1' => 'Texas', 'country' => 'United States', 'country_code' => 'US', 'latitude' => 33.66, 'longitude' => -95.55, 'timezone' => 'America/Chicago'],
        ]])]);

        $place = app(WeatherService::class)->place('Paris, Texas');

        // The geocoder matches on the name alone — "Paris, Texas" finds nothing
        // — so only the name is sent, and the rest picks the row.
        Http::assertSent(fn ($request) => $request['name'] === 'Paris');
        $this->assertSame('Paris, Texas, United States', $place['name']);
        $this->assertSame('America/Chicago', $place['timezone']);

        // Without one, the most populous wins, which is the geocoder's order.
        $this->assertSame('Europe/Paris', app(WeatherService::class)->place('Paris')['timezone']);
    }

    #[Test]
    public function a_place_nobody_has_heard_of_is_the_callers_to_fix(): void
    {
        Http::fake(['*geocoding*' => Http::sequence()
            ->push(['generationtime_ms' => 0.2])
            ->push(['results' => [
                ['name' => 'Atlantis', 'country' => 'United States', 'latitude' => 26.59, 'longitude' => -80.05, 'timezone' => 'America/New_York'],
            ]]),
        ]);

        try {
            app(WeatherService::class)->place('Atlantis');
            $this->fail('Expected a validation error.');
        } catch (ValidationException $e) {
            // A ValidationException is handed to the model as a correctable
            // mistake, not reported as a fault.
            $this->assertStringContainsString('No place called "Atlantis"', $e->getMessage());
        }

        // Not cached: a lookup that missed is asked again next time.
        $this->assertSame('America/New_York', app(WeatherService::class)->place('Atlantis')['timezone']);
    }

    #[Test]
    public function a_place_is_read_on_its_own_clock(): void
    {
        Http::fake(['*' => Http::response(self::openMeteo())]);

        $reading = app(WeatherService::class)->reading(48.85, 2.35, 'Europe/Paris');

        Http::assertSent(fn ($request) => $request['timezone'] === 'Europe/Paris');
        $this->assertSame('Europe/Paris', $reading['timezone']);
        // 14:00 in Paris in September is 12:00 UTC.
        $this->assertSame('2026-09-06T12:00:00+00:00', $reading['observed_at']);

        // And it does not land on the home key: the HUD must not start showing
        // Paris because somebody asked about it.
        $this->assertNull(Cache::get(WeatherService::CACHE_KEY));
    }
}
