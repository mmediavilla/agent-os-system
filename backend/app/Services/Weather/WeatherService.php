<?php

namespace App\Services\Weather;

use Carbon\CarbonImmutable;
use DateTimeZone;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Illuminate\Validation\ValidationException;
use Throwable;

/**
 * The weather — for the HUD's button and for the assistant.
 *
 * Open-Meteo, and the reason is the absence of a key rather than the forecast:
 * every alternative wants an account, and a key is a second secret to keep out
 * of the Expo bundle — for a number that is public information and that the
 * page could fetch itself. Routing it through Laravel anyway buys the cache,
 * which is the whole cost control: the HUD polls for as long as the tab is
 * open, and the upstream model updates far less often than that.
 *
 * **Three states, not two.** Unconfigured is not the same as unavailable, and
 * collapsing them would put "weather unavailable" on a machine that was simply
 * never told where it is. There is no default location and none is guessed: an
 * IP lookup to a third party is a request the user did not ask for, on a screen
 * whose whole premise is that it is always on.
 *
 * **A forecast, not just a reading.** Both times the assistant was asked about
 * the weather before `get_weather` existed, the question was about *tomorrow* —
 * so one request fetches the current conditions, every hour of the next week
 * and a row per day, and everything downstream slices that one cached answer.
 *
 * **Asked for on the user's clock.** Open-Meteo buckets its daily rows by the
 * `timezone` it is sent, and a UTC day is 08:00 to 08:00 for the owner of this
 * machine — "tomorrow's high" would straddle two days. So the request names
 * `agent.timezone` (or a looked-up place's own zone), and the timestamps that
 * come back are that zone's wall clock with no offset: hours and sunrises are
 * passed on as wall clock, the way the calendar's times are, and only
 * `observed_at` is turned into an instant — it was one before, and the HUD
 * formats it as one.
 *
 * A failure is cached too, briefly. Without that, an upstream outage turns an
 * open tab into a retry loop against someone else's API for the rest of the
 * day.
 */
final class WeatherService
{
    /**
     * The home forecast's cache key. A looked-up place gets its own beside it.
     *
     * Not `hud.weather`, which held the conditions-only payload: a reading in
     * that shape read by this code would be a forecast with no clock, for up
     * to ten minutes after the upgrade.
     */
    public const CACHE_KEY = 'hud.weather.forecast';

    /** Today and the six days after it — as far as anyone plans a run. */
    public const FORECAST_DAYS = 7;

    /** How many hours the HUD is sent, from the current one. */
    public const HUD_HOURS = 24;

    /** The calendar's wire format: wall clock, no offset, no `Z`. */
    public const WALL_CLOCK = 'Y-m-d\TH:i:s';

    /**
     * WMO weather interpretation codes, which is what Open-Meteo returns
     * instead of a description. Grouped rather than transcribed — the standard
     * distinguishes "slight" from "moderate" freezing drizzle, and a panel
     * three lines tall does not.
     *
     * @var array<int, string>
     */
    private const CONDITIONS = [
        0 => 'Clear',
        1 => 'Mainly clear',
        2 => 'Partly cloudy',
        3 => 'Overcast',
        45 => 'Fog',
        48 => 'Freezing fog',
        51 => 'Light drizzle',
        53 => 'Drizzle',
        55 => 'Heavy drizzle',
        56 => 'Freezing drizzle',
        57 => 'Freezing drizzle',
        61 => 'Light rain',
        63 => 'Rain',
        65 => 'Heavy rain',
        66 => 'Freezing rain',
        67 => 'Freezing rain',
        71 => 'Light snow',
        73 => 'Snow',
        75 => 'Heavy snow',
        77 => 'Snow grains',
        80 => 'Light showers',
        81 => 'Showers',
        82 => 'Violent showers',
        85 => 'Snow showers',
        86 => 'Heavy snow showers',
        95 => 'Thunderstorm',
        96 => 'Thunderstorm with hail',
        99 => 'Thunderstorm with hail',
    ];

    /**
     * `GET /api/weather`: the home forecast, with the hours cut down to the
     * next day's worth — the HUD draws a strip, not a week of rows.
     *
     * @return array<string, mixed>
     */
    public function current(): array
    {
        $reading = $this->home();

        if ($reading['available']) {
            $reading['hourly'] = self::hoursFrom(
                $reading['hourly'],
                CarbonImmutable::now($reading['timezone']),
                self::HUD_HOURS,
            );
        }

        return $reading;
    }

    /**
     * Where the user is: the configured coordinates, on the user's clock.
     *
     * @return array<string, mixed>
     */
    public function home(): array
    {
        $latitude = config('hud.weather.latitude');
        $longitude = config('hud.weather.longitude');

        if ($latitude === null || $longitude === null || $latitude === '' || $longitude === '') {
            return [
                'configured' => false,
                'available' => false,
                'message' => 'Set WEATHER_LATITUDE and WEATHER_LONGITUDE to show the weather here.',
            ];
        }

        $reading = $this->reading((float) $latitude, (float) $longitude, (string) config('agent.timezone'), self::CACHE_KEY);

        // Added on the way out rather than cached with the forecast, so renaming
        // the place does not wait ten minutes to show.
        return $reading['available']
            ? ['configured' => true, 'available' => true, 'label' => config('hud.weather.label')] + $reading
            : ['configured' => true] + $reading;
    }

    /**
     * One place's forecast, cached.
     *
     * `$key` is only for the home reading, which keeps the key it has always
     * had; a looked-up place is keyed by where it is and whose clock it is read
     * on, rounded to about a kilometre so "Baguio" and "Baguio City" share one.
     *
     * @return array<string, mixed>
     */
    public function reading(float $latitude, float $longitude, string $timezone, ?string $key = null): array
    {
        $key ??= self::CACHE_KEY.'.'.md5(round($latitude, 2).','.round($longitude, 2).','.$timezone);

        $cached = Cache::get($key);

        if (is_array($cached)) {
            return $cached;
        }

        $payload = $this->fetch($latitude, $longitude, $timezone);

        Cache::put(
            $key,
            $payload,
            (int) config($payload['available'] ? 'hud.weather.ttl' : 'hud.weather.failure_ttl'),
        );

        return $payload;
    }

    /**
     * A place by name, for "what's it like in Baguio?".
     *
     * Open-Meteo's geocoder, which is keyless like the forecast. It matches on
     * the place's own name only — "Paris, France" finds nothing — so anything
     * after a comma is used to choose among the matches rather than sent. This
     * is a lookup the user asked for by naming the place, which is what
     * separates it from guessing where they are.
     *
     * Throws a `ValidationException` when nothing matches: that is the model's
     * spelling to fix, and the tool layer hands it back as a correctable error
     * rather than reporting it as a fault.
     *
     * @return array{name: string, latitude: float, longitude: float, timezone: string}
     */
    public function place(string $query): array
    {
        [$name, $qualifier] = array_pad(array_map('trim', explode(',', $query, 2)), 2, '');

        $key = self::CACHE_KEY.'.place.'.md5(mb_strtolower($name.'|'.$qualifier));
        $found = Cache::get($key);

        if (! is_array($found)) {
            $found = $this->geocode($name, $qualifier);

            // A week: towns do not move. A miss is not cached, so a place added
            // to the index — or a lookup that failed in transit — is found next time.
            if ($found !== null) {
                Cache::put($key, $found, 604_800);
            }
        }

        if ($found === null) {
            throw ValidationException::withMessages([
                'place' => "No place called \"{$query}\" was found. Try the town or city on its own, or add its country after a comma.",
            ]);
        }

        return $found;
    }

    /**
     * The hours from the one in progress, `$count` of them.
     *
     * Rows are wall clock on the forecast's own zone, so `$now` has to be read
     * on the same one — and the same format compares as a string.
     *
     * @param  list<array<string, mixed>>  $hourly
     * @return list<array<string, mixed>>
     */
    public static function hoursFrom(array $hourly, CarbonImmutable $now, int $count): array
    {
        $from = $now->startOfHour()->format(self::WALL_CLOCK);

        return array_slice(
            array_values(array_filter($hourly, fn (array $h) => $h['time'] >= $from)),
            0,
            $count,
        );
    }

    /**
     * @return array{name: string, latitude: float, longitude: float, timezone: string}|null
     */
    private function geocode(string $name, string $qualifier): ?array
    {
        if ($name === '') {
            return null;
        }

        try {
            $response = Http::timeout((int) config('hud.weather.timeout', 6))
                ->get(config('hud.weather.geocoding_endpoint'), [
                    'name' => $name,
                    'count' => 10,
                    'language' => 'en',
                    'format' => 'json',
                ]);
        } catch (Throwable) {
            return null;
        }

        $results = $response->successful() ? ($response->json('results') ?? []) : [];

        if (! is_array($results) || $results === []) {
            return null;
        }

        // The geocoder ranks by population, which is right for "Paris" and why
        // "Paris, Texas" needs the qualifier to win.
        $wanted = mb_strtolower($qualifier);
        $match = $results[0];

        if ($wanted !== '') {
            foreach ($results as $result) {
                $haystack = mb_strtolower(implode(' ', array_filter([
                    $result['country'] ?? null,
                    $result['country_code'] ?? null,
                    $result['admin1'] ?? null,
                    $result['admin2'] ?? null,
                ])));

                if (str_contains($haystack, $wanted)) {
                    $match = $result;
                    break;
                }
            }
        }

        if (! isset($match['latitude'], $match['longitude'])) {
            return null;
        }

        return [
            'name' => implode(', ', array_unique(array_filter([
                $match['name'] ?? $name,
                $match['admin1'] ?? null,
                $match['country'] ?? null,
            ]))),
            'latitude' => (float) $match['latitude'],
            'longitude' => (float) $match['longitude'],
            'timezone' => $this->validZone($match['timezone'] ?? null) ?? 'UTC',
        ];
    }

    /**
     * @return array<string, mixed>
     */
    private function fetch(float $latitude, float $longitude, string $timezone): array
    {
        try {
            $response = Http::timeout((int) config('hud.weather.timeout', 6))
                ->get(config('hud.weather.endpoint'), [
                    'latitude' => $latitude,
                    'longitude' => $longitude,
                    'current' => 'temperature_2m,apparent_temperature,relative_humidity_2m,'
                        .'precipitation_probability,weather_code,wind_speed_10m,wind_direction_10m,is_day',
                    'hourly' => 'temperature_2m,precipitation_probability,weather_code,is_day',
                    'daily' => 'weather_code,temperature_2m_max,temperature_2m_min,'
                        .'precipitation_probability_max,precipitation_sum,wind_speed_10m_max,'
                        .'uv_index_max,sunrise,sunset',
                    'forecast_days' => self::FORECAST_DAYS,

                    // The user's zone, not UTC: the daily rows are bucketed on
                    // it. Every timestamp that comes back is that zone's wall
                    // clock with no offset, which is read *in* the zone below —
                    // never handed to a parser that would assume UTC.
                    'timezone' => $timezone,
                ]);

            if (! $response->successful()) {
                return $this->unavailable('The weather service answered '.$response->status().'.');
            }

            return $this->present($response->json(), new DateTimeZone($timezone));
        } catch (Throwable $e) {
            return $this->unavailable($e->getMessage());
        }
    }

    /**
     * @param  array<string, mixed>|null  $body
     * @return array<string, mixed>
     */
    private function present(?array $body, DateTimeZone $zone): array
    {
        $current = $body['current'] ?? null;

        if (! is_array($current)) {
            return $this->unavailable('The weather service returned no current conditions.');
        }

        $code = self::code($current['weather_code'] ?? null);

        return [
            'available' => true,
            'timezone' => $zone->getName(),
            'observed_at' => isset($current['time'])
                ? CarbonImmutable::parse($current['time'], $zone)->utc()->toIso8601String()
                : null,
            'condition' => self::condition($code),
            'weather_code' => $code,
            'is_day' => isset($current['is_day']) ? (bool) $current['is_day'] : null,
            'temperature_c' => self::number($current['temperature_2m'] ?? null),
            'apparent_c' => self::number($current['apparent_temperature'] ?? null),
            'humidity' => self::number($current['relative_humidity_2m'] ?? null),
            'precipitation_chance' => self::number($current['precipitation_probability'] ?? null),
            'wind_kph' => self::number($current['wind_speed_10m'] ?? null),
            'wind_from' => isset($current['wind_direction_10m'])
                ? self::compass((float) $current['wind_direction_10m'])
                : null,
            'hourly' => $this->hourly($body['hourly'] ?? null, $zone),
            'daily' => $this->daily($body['daily'] ?? null, $zone),
        ];
    }

    /**
     * Open-Meteo sends columns — one array per variable — and everything
     * downstream wants rows.
     *
     * @return list<array<string, mixed>>
     */
    private function hourly(mixed $columns, DateTimeZone $zone): array
    {
        $rows = [];

        foreach (self::column($columns, 'time') as $i => $time) {
            $code = self::code($columns['weather_code'][$i] ?? null);

            $rows[] = [
                'time' => self::wall($time, $zone),
                'condition' => self::condition($code),
                'weather_code' => $code,
                'is_day' => isset($columns['is_day'][$i]) ? (bool) $columns['is_day'][$i] : null,
                'temperature_c' => self::number($columns['temperature_2m'][$i] ?? null),
                'precipitation_chance' => self::number($columns['precipitation_probability'][$i] ?? null),
            ];
        }

        return $rows;
    }

    /**
     * @return list<array<string, mixed>>
     */
    private function daily(mixed $columns, DateTimeZone $zone): array
    {
        $rows = [];

        foreach (self::column($columns, 'time') as $i => $date) {
            $code = self::code($columns['weather_code'][$i] ?? null);

            $rows[] = [
                'date' => substr((string) $date, 0, 10),
                'condition' => self::condition($code),
                'weather_code' => $code,
                'high_c' => self::number($columns['temperature_2m_max'][$i] ?? null),
                'low_c' => self::number($columns['temperature_2m_min'][$i] ?? null),
                'precipitation_chance' => self::number($columns['precipitation_probability_max'][$i] ?? null),
                'precipitation_mm' => self::number($columns['precipitation_sum'][$i] ?? null),
                'wind_max_kph' => self::number($columns['wind_speed_10m_max'][$i] ?? null),
                'uv_index' => self::number($columns['uv_index_max'][$i] ?? null),
                'sunrise' => isset($columns['sunrise'][$i]) ? self::wall($columns['sunrise'][$i], $zone) : null,
                'sunset' => isset($columns['sunset'][$i]) ? self::wall($columns['sunset'][$i], $zone) : null,
            ];
        }

        return $rows;
    }

    /**
     * @return array<string, mixed>
     */
    private function unavailable(string $message): array
    {
        return ['available' => false, 'message' => $message];
    }

    /** @return array<int, mixed> */
    private static function column(mixed $columns, string $name): array
    {
        return is_array($columns) && is_array($columns[$name] ?? null) ? $columns[$name] : [];
    }

    /** A zone-less timestamp, read in the zone it was asked for, back out as wall clock. */
    private static function wall(mixed $time, DateTimeZone $zone): string
    {
        return CarbonImmutable::parse((string) $time, $zone)->format(self::WALL_CLOCK);
    }

    private function validZone(mixed $zone): ?string
    {
        return is_string($zone) && in_array($zone, DateTimeZone::listIdentifiers(), true) ? $zone : null;
    }

    private static function code(mixed $value): ?int
    {
        return is_numeric($value) ? (int) $value : null;
    }

    private static function condition(?int $code): ?string
    {
        return $code !== null ? (self::CONDITIONS[$code] ?? 'Unsettled') : null;
    }

    private static function number(mixed $value): ?float
    {
        return is_numeric($value) ? round((float) $value, 1) : null;
    }

    /** Degrees the wind is coming *from*, as the eight points anyone reads. */
    private static function compass(float $degrees): string
    {
        $points = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

        return $points[(int) round((($degrees % 360) + 360) % 360 / 45) % 8];
    }
}
