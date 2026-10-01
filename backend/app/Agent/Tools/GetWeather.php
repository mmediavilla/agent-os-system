<?php

namespace App\Agent\Tools;

use App\Agent\CapabilityGroup;
use App\Services\Weather\WeatherService;
use Carbon\CarbonImmutable;

/**
 * The weather, for the model — where the user is, or anywhere they name.
 *
 * It exists because the assistant was asked "what's the weather for tomorrow?"
 * twice and answered that it had no way to know, while the HUD it runs behind
 * had the answer on screen. It reads the same cached forecast the HUD's button
 * does, so the two never disagree and a question costs no upstream call the
 * button had not already made.
 *
 * **The current time is in the result.** The system prompt carries today's
 * date and nothing finer, and "will it rain this evening?" asked at 19:00 is a
 * different question from the same words at 09:00.
 */
class GetWeather extends BaseTool
{
    private const DEFAULT_DAYS = 3;

    /** Hours given when no day is named: this afternoon and this evening, from the morning. */
    private const DEFAULT_HOURS = 12;

    public function __construct(private readonly WeatherService $weather) {}

    public function name(): string
    {
        return 'get_weather';
    }

    public function group(): CapabilityGroup
    {
        return CapabilityGroup::Core;
    }

    public function description(): string
    {
        return <<<'TEXT'
        The weather: the conditions right now, the coming hours one by one, and a forecast for
        each day up to a week ahead. With no `place` it reads where the user is — the location
        this app is set to — which is what "the weather", "outside" and "can I run outdoors"
        mean. Name a place to read somewhere else.

        Call it again for every weather question rather than answering from an earlier result:
        the forecast moves, and it is re-read every ten minutes.

        Pass `date` to read one day hour by hour — "tomorrow morning", "Saturday afternoon".
        Without it, the hours are the next twelve. `now` is the current time at the place, so
        "this evening" can be resolved against it. Times are the place's local wall clock —
        quote them as they come, with no timezone. Temperatures are °C, wind km/h, rain mm;
        `precipitation_chance` is a percentage.

        The forecast runs seven days from today. A day past that is unknown, not fine weather —
        say so rather than guessing.
        TEXT;
    }

    public function inputSchema(): array
    {
        return $this->object([
            'place' => $this->string('A town or city to read instead of the user\'s own location — "Baguio", or "Paris, France" when the name alone is ambiguous. Omit it for where the user is.'),
            'days' => $this->integer('How many days of the daily forecast to include, starting today. Default '.self::DEFAULT_DAYS.', maximum '.WeatherService::FORECAST_DAYS.'.'),
            'date' => $this->string('A day to read hour by hour (YYYY-MM-DD), from today to six days ahead. Omit it for the next '.self::DEFAULT_HOURS.' hours.'),
        ]);
    }

    public function handle(array $input): array
    {
        $input = $this->validate($input, [
            'place' => ['nullable', 'string', 'max:120'],
            'days' => ['nullable', 'integer'],
            'date' => ['nullable', 'date_format:Y-m-d'],
        ]);

        $placeName = trim((string) ($input['place'] ?? ''));

        if ($placeName !== '') {
            // Throws when nothing matches — the model's spelling to fix.
            $place = $this->weather->place($placeName);
            $reading = $this->weather->reading($place['latitude'], $place['longitude'], $place['timezone']);
            $where = ['place' => $place['name'], 'timezone' => $place['timezone']];
        } else {
            $reading = $this->weather->home();

            if (! $reading['configured']) {
                return [
                    'available' => false,
                    'reason' => 'No location is set for the user, so there is no local forecast. It is set in the API\'s .env (WEATHER_LATITUDE and WEATHER_LONGITUDE). A place can still be read by name.',
                ];
            }

            // Absent rather than invented when no label is set: "your location"
            // is honest, a guessed city name is not.
            $where = ['place' => $reading['label'] ?? null];
        }

        if (! $reading['available']) {
            return [
                'available' => false,
                'reason' => 'The forecast could not be fetched just now. Say so rather than guessing; it is retried within a minute.',
            ];
        }

        $now = CarbonImmutable::now($reading['timezone']);
        $today = $now->toDateString();
        $notes = [];

        $days = max(1, min((int) ($input['days'] ?? self::DEFAULT_DAYS), WeatherService::FORECAST_DAYS));
        $lastDay = $now->addDays($days - 1)->toDateString();

        if (isset($input['date'])) {
            $date = $input['date'];
            $hourly = array_values(array_filter($reading['hourly'], fn (array $h) => str_starts_with($h['time'], $date)));

            // The day asked about is always in the daily rows too, however few
            // days were asked for — "Saturday" with the default three would
            // otherwise come back as hours with no summary.
            if ($date > $lastDay) {
                $lastDay = $date;
            }

            $lastForecast = $reading['daily'] === []
                ? $today
                : $reading['daily'][array_key_last($reading['daily'])]['date'];

            if ($date < $today) {
                $notes[] = "{$date} has already passed; only today onward is forecast here.";
            } elseif ($date > $lastForecast) {
                $notes[] = "The forecast runs to {$lastForecast}; {$date} is past it and unknown.";
            }
        } else {
            $hourly = WeatherService::hoursFrom($reading['hourly'], $now, self::DEFAULT_HOURS);
        }

        $daily = array_values(array_filter(
            $reading['daily'],
            fn (array $d) => $d['date'] >= $today && $d['date'] <= $lastDay,
        ));

        return array_filter([
            ...$where,
            'now' => $now->format('Y-m-d\TH:i'),
            'current' => self::compact([
                'condition' => $reading['condition'],
                'temperature_c' => $reading['temperature_c'],
                'feels_like_c' => $reading['apparent_c'],
                'humidity' => $reading['humidity'],
                'precipitation_chance' => $reading['precipitation_chance'],
                'wind_kph' => $reading['wind_kph'],
                'wind_from' => $reading['wind_from'],
            ]),
            'hourly' => array_map(fn (array $h) => self::compact([
                'time' => $h['time'],
                'condition' => $h['condition'],
                'temperature_c' => $h['temperature_c'],
                'precipitation_chance' => $h['precipitation_chance'],
            ]), $hourly),
            'daily' => array_map(fn (array $d) => self::compact([
                'date' => $d['date'],
                // Named, because a model working out the weekday of a date
                // gets it wrong often enough to say "Friday" about a Saturday.
                'day' => CarbonImmutable::parse($d['date'])->format('l'),
                'condition' => $d['condition'],
                'high_c' => $d['high_c'],
                'low_c' => $d['low_c'],
                'precipitation_chance' => $d['precipitation_chance'],
                'precipitation_mm' => $d['precipitation_mm'],
                'wind_max_kph' => $d['wind_max_kph'],
                'uv_index' => $d['uv_index'],
                'sunrise' => $d['sunrise'],
                'sunset' => $d['sunset'],
            ]), $daily),
            'notes' => $notes ?: null,
        ], fn ($v) => $v !== null && $v !== []);
    }

    /**
     * Nulls dropped: every row is re-sent on each later turn of the loop, and
     * a column of empty values is noise the model is paying to read.
     *
     * @param  array<string, mixed>  $row
     * @return array<string, mixed>
     */
    private static function compact(array $row): array
    {
        return array_filter($row, fn ($v) => $v !== null);
    }
}
