<?php

namespace App\Services;

use App\Models\Setting;
use App\Services\Fitness\ProactiveTriggers;
use Throwable;

/**
 * The fitness settings that live on the server: the morning nudge, and how
 * the stats are calculated.
 *
 * **Rows, not `localStorage`, for `AnthropicSwitch`'s reason.** The nudge is
 * decided at 07:00 by the scheduler and written by a queue worker, neither of
 * which has a browser. Units and the default stats range stay in the browser
 * because nothing without one reads them; whether, when and about what the app
 * speaks unprompted is read by nothing *but* the machine.
 *
 * **The e1RM formula and the week's first day are rows for the same reason.**
 * They change numbers the 07:00 check, the assistant's `get_fitness_stats` and
 * the dashboard all read from one `FitnessStatsService` payload; kept in a
 * browser, the nudge would call a week a drop that Home drew as normal.
 *
 * **`.env` is the default, not a second switch.** `PROACTIVE_INSIGHTS_ENABLED`
 * and `PROACTIVE_TIME` answer until someone saves a choice in Fitness →
 * Settings, and from then on the row answers. A stored value that no longer
 * fits its closed set — a hand-edited row, a trigger since renamed — falls back
 * the same way rather than failing a tick.
 *
 * **The schedule reads this through `orConfig()`.** `schedule:run` builds the
 * schedule every minute, including on a fresh checkout whose `settings` table
 * does not exist yet; a heartbeat that stopped because a migration had not run
 * would report a missing table as a dead scheduler.
 */
final class FitnessSettings
{
    public const NUDGES_ENABLED = 'fitness.nudges.enabled';

    public const NUDGES_TIME = 'fitness.nudges.time';

    public const NUDGES_TRIGGERS = 'fitness.nudges.triggers';

    public const E1RM_FORMULA = 'fitness.e1rm_formula';

    public const WEEK_START = 'fitness.week_start';

    /** The first is the default. */
    public const E1RM_FORMULAS = ['epley', 'brzycki'];

    /** The first is the default. */
    public const WEEK_STARTS = ['monday', 'sunday'];

    /** 24-hour HH:MM, which is what `dailyAt()` takes. */
    public const TIME_PATTERN = '/^([01]\d|2[0-3]):[0-5]\d$/';

    public static function nudgesEnabled(): bool
    {
        return Setting::bool(self::NUDGES_ENABLED, (bool) config('agent.proactive.enabled'));
    }

    public static function nudgeTime(): string
    {
        $stored = Setting::value(self::NUDGES_TIME);

        return is_string($stored) && preg_match(self::TIME_PATTERN, $stored)
            ? $stored
            : (string) config('agent.proactive.time');
    }

    /**
     * The triggers allowed to speak, in priority order.
     *
     * An empty list is a real answer — every trigger switched off — and is not
     * confused with "never set", which is all four.
     *
     * @return list<string>
     */
    public static function nudgeTriggers(): array
    {
        $stored = Setting::value(self::NUDGES_TRIGGERS);

        if (! is_array($stored)) {
            return ProactiveTriggers::KEYS;
        }

        return array_values(array_intersect(ProactiveTriggers::KEYS, $stored));
    }

    public static function e1rmFormula(): string
    {
        return self::oneOf(self::E1RM_FORMULA, self::E1RM_FORMULAS);
    }

    public static function weekStart(): string
    {
        return self::oneOf(self::WEEK_START, self::WEEK_STARTS);
    }

    /** A stored member of `$set`, or its first member. */
    private static function oneOf(string $key, array $set): string
    {
        $stored = Setting::value($key);

        return in_array($stored, $set, true) ? $stored : $set[0];
    }

    /**
     * Drop the fired triggers someone switched off.
     *
     * Applied to `ProactiveTriggers::check()`'s result rather than inside it, so
     * `check()` stays a pure function of the stats payload.
     *
     * @param  list<array{key: string}>  $fired
     * @return list<array>
     */
    public static function allowed(array $fired): array
    {
        $on = self::nudgeTriggers();

        return array_values(array_filter($fired, fn (array $t) => in_array($t['key'], $on, true)));
    }

    /**
     * Partial update: only the keys given are written.
     *
     * @param  array{enabled?: bool, time?: string, triggers?: list<string>}  $nudges  already validated
     */
    public static function updateNudges(array $nudges): void
    {
        if (array_key_exists('enabled', $nudges)) {
            Setting::put(self::NUDGES_ENABLED, (bool) $nudges['enabled']);
        }

        if (array_key_exists('time', $nudges)) {
            Setting::put(self::NUDGES_TIME, $nudges['time']);
        }

        if (array_key_exists('triggers', $nudges)) {
            // Stored in priority order and de-duplicated, whatever order came in.
            Setting::put(self::NUDGES_TRIGGERS, array_values(array_intersect(ProactiveTriggers::KEYS, $nudges['triggers'])));
        }
    }

    /**
     * Partial update, like the nudges.
     *
     * @param  array{e1rm_formula?: string, week_start?: string}  $calculations  already validated
     */
    public static function updateCalculations(array $calculations): void
    {
        if (array_key_exists('e1rm_formula', $calculations)) {
            Setting::put(self::E1RM_FORMULA, $calculations['e1rm_formula']);
        }

        if (array_key_exists('week_start', $calculations)) {
            Setting::put(self::WEEK_START, $calculations['week_start']);
        }
    }

    /**
     * @return array{e1rm_formula: string, week_start: string}
     */
    public static function calculations(): array
    {
        return [
            'e1rm_formula' => self::e1rmFormula(),
            'week_start' => self::weekStart(),
        ];
    }

    /**
     * @return array{nudges: array{enabled: bool, time: string, triggers: list<string>, timezone: string}, calculations: array{e1rm_formula: string, week_start: string}}
     */
    public static function state(): array
    {
        return [
            'nudges' => [
                'enabled' => self::nudgesEnabled(),
                'time' => self::nudgeTime(),
                'triggers' => self::nudgeTriggers(),
                // Read-only: the time is on the user's clock, and the screen
                // says which one rather than assuming the browser's.
                'timezone' => (string) config('agent.timezone'),
            ],
            'calculations' => self::calculations(),
        ];
    }

    /**
     * A setting as the schedule reads it: the row, or `.env` if the table
     * cannot be read at all.
     *
     * @template T
     *
     * @param  callable(): T  $read
     * @return T
     */
    public static function orConfig(callable $read, mixed $fallback): mixed
    {
        try {
            return $read();
        } catch (Throwable) {
            return $fallback;
        }
    }
}
