<?php

namespace Tests\Feature\Agent;

use App\Agent\ToolRegistry;
use App\Services\Weather\WeatherService;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Illuminate\Validation\ValidationException;
use Tests\Feature\Hud\WeatherTest;
use Tests\TestCase;

/**
 * `get_weather` — the forecast the HUD's button shows, for the model.
 *
 * It exists because "what's the weather for tomorrow?" was answered twice with
 * "I've no way to check the weather". So the tests are mostly about tomorrow:
 * that a named day comes back hour by hour and summarised, on the user's
 * clock, and that a day past the forecast is said to be unknown.
 */
class GetWeatherTest extends TestCase
{
    protected function setUp(): void
    {
        parent::setUp();

        config([
            'agent.timezone' => 'Asia/Manila',
            'hud.weather.latitude' => 14.6,
            'hud.weather.longitude' => 121.0,
            'hud.weather.label' => 'Manila',
        ]);

        // 10:20 on the 6th in Manila, 02:20 UTC — a morning where the server's
        // date and the user's still agree, and the hour is theirs.
        $this->travelTo(CarbonImmutable::parse('2026-09-06 10:20', 'Asia/Manila'));
    }

    private function weather(array $input = []): array
    {
        return app(ToolRegistry::class)->get('get_weather')->handle($input);
    }

    public function test_it_reads_where_the_user_is_with_the_time_there(): void
    {
        Http::fake(['*' => Http::response(WeatherTest::openMeteo())]);

        $result = $this->weather();

        $this->assertSame('Manila', $result['place']);
        // The system prompt carries the date and nothing finer; "this evening"
        // needs the hour.
        $this->assertSame('2026-09-06T10:20', $result['now']);
        $this->assertSame([
            'condition' => 'Partly cloudy',
            'temperature_c' => 28.6,
            'feels_like_c' => 33.9,
            'humidity' => 78.0,
            'precipitation_chance' => 40.0,
            'wind_kph' => 11.4,
            'wind_from' => 'SW',
        ], $result['current']);

        // The next twelve hours, from the one in progress.
        $this->assertCount(12, $result['hourly']);
        $this->assertSame('2026-09-06T10:00:00', $result['hourly'][0]['time']);
        $this->assertSame('Light rain', $result['hourly'][5]['condition']);

        // Three days by default, each with its weekday named.
        $this->assertSame(['2026-09-06', '2026-09-07', '2026-09-08'], array_column($result['daily'], 'date'));
        $this->assertSame('Sunday', $result['daily'][0]['day']);
    }

    public function test_tomorrow_comes_back_hour_by_hour_and_summarised(): void
    {
        Http::fake(['*' => Http::response(WeatherTest::openMeteo())]);

        $result = $this->weather(['date' => '2026-09-07', 'days' => 1]);

        // Every hour of that day, on the user's clock — not the hours of a UTC
        // day that starts at 08:00 here.
        $this->assertCount(24, $result['hourly']);
        $this->assertSame('2026-09-07T00:00:00', $result['hourly'][0]['time']);
        $this->assertSame('2026-09-07T23:00:00', $result['hourly'][23]['time']);

        // The day asked about is in the summary even though one day was asked
        // for, so "tomorrow" never comes back as hours with no high and low.
        $this->assertContains('2026-09-07', array_column($result['daily'], 'date'));
        $this->assertArrayNotHasKey('notes', $result);
    }

    public function test_a_day_past_the_forecast_is_unknown_rather_than_empty(): void
    {
        Http::fake(['*' => Http::response(WeatherTest::openMeteo())]);

        $result = $this->weather(['date' => '2026-09-20']);

        $this->assertArrayNotHasKey('hourly', $result);
        $this->assertStringContainsString('2026-09-20 is past it and unknown', $result['notes'][0]);
    }

    public function test_days_is_clamped_to_the_week_the_forecast_covers(): void
    {
        Http::fake(['*' => Http::response(WeatherTest::openMeteo())]);

        $this->assertCount(WeatherService::FORECAST_DAYS, $this->weather(['days' => 30])['daily']);
        $this->assertCount(1, $this->weather(['days' => 0])['daily']);
    }

    public function test_it_reads_the_same_cached_forecast_as_the_hud(): void
    {
        Http::fake(['*' => Http::response(WeatherTest::openMeteo())]);

        $this->getJson('/api/weather')->assertOk();
        $this->weather();
        $this->weather(['date' => '2026-09-07']);

        // One upstream call between the button and the assistant, so the two
        // can never disagree about the same ten minutes.
        Http::assertSentCount(1);
    }

    public function test_a_named_place_is_looked_up_and_read_on_its_own_clock(): void
    {
        Http::fake([
            '*geocoding*' => Http::response(['results' => [
                ['name' => 'Baguio', 'admin1' => 'Cordillera', 'country' => 'Philippines', 'latitude' => 16.41, 'longitude' => 120.59, 'timezone' => 'Asia/Manila'],
            ]]),
            '*' => Http::response(WeatherTest::openMeteo(['temperature_2m' => 19.5])),
        ]);

        $result = $this->weather(['place' => 'Baguio']);

        $this->assertSame('Baguio, Cordillera, Philippines', $result['place']);
        $this->assertSame('Asia/Manila', $result['timezone']);
        $this->assertSame(19.5, $result['current']['temperature_c']);

        // Somewhere else is not where the user is: the HUD's reading is untouched.
        $this->assertNull(Cache::get(WeatherService::CACHE_KEY));
    }

    public function test_an_unknown_place_is_a_mistake_the_model_can_correct(): void
    {
        Http::fake(['*geocoding*' => Http::response(['results' => []])]);

        $attempt = app(ToolRegistry::class)->attempt('get_weather', ['place' => 'Atlantis']);

        // A correctable error, in words, rather than a fault reported and an
        // empty forecast the model might read as fine weather.
        $this->assertTrue($attempt['is_error']);
        $this->assertStringContainsString('No place called "Atlantis" was found', $attempt['text']);
    }

    public function test_with_no_home_location_it_says_where_to_set_one(): void
    {
        config(['hud.weather.latitude' => null, 'hud.weather.longitude' => null]);
        Http::fake(['*' => Http::response(WeatherTest::openMeteo())]);

        $result = $this->weather();

        // Not configured is said, with where to set it — and nothing guessed.
        $this->assertFalse($result['available']);
        $this->assertStringContainsString('WEATHER_LATITUDE', $result['reason']);
        Http::assertNothingSent();
    }

    public function test_an_outage_is_said_rather_than_guessed_around(): void
    {
        Http::fake(['*' => Http::response('', 503)]);

        $result = $this->weather();

        $this->assertFalse($result['available']);
        $this->assertStringContainsString('could not be fetched', $result['reason']);
    }

    public function test_a_bad_date_is_refused(): void
    {
        $this->expectException(ValidationException::class);

        $this->weather(['date' => 'tomorrow']);
    }

    public function test_the_spoken_assistant_can_ask_too(): void
    {
        // A read, so it is in the voice registry by the same declaration that
        // keeps the writes out.
        $this->assertTrue(app(ToolRegistry::class)->readOnly()->has('get_weather'));
    }
}
