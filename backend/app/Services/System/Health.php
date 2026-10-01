<?php

namespace App\Services\System;

use App\Services\AnthropicSwitch;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;
use Throwable;

/**
 * The four readings `GET /api/health` reports, as something more than one
 * caller can take.
 *
 * They lived privately on `HealthController` until the diagnostics (18.0)
 * needed the same numbers. Two computations of "is the worker up" would be two
 * answers that disagree for a poll at a time, so the controller and the checks
 * both read these. Nothing here was changed on the way out; `HealthTest` is the
 * proof, unchanged.
 */
final class Health
{
    /**
     * @return array<string, mixed>
     */
    public static function database(): array
    {
        $started = hrtime(true);

        try {
            DB::connection()->select('select 1');
        } catch (Throwable $e) {
            return ['state' => 'down', 'detail' => $e->getMessage()];
        }

        $latency = round((hrtime(true) - $started) / 1_000_000, 2);
        $driver = DB::connection()->getDriverName();

        $detail = [
            'state' => 'up',
            'driver' => $driver,
            'latency_ms' => $latency,
            'journal_mode' => null,
            'size_bytes' => null,
        ];

        if ($driver !== 'sqlite') {
            return $detail;
        }

        // WAL is not a preference here: it is what lets the run stream read the
        // database in a loop while a queue worker writes to it, so a SQLite
        // connection that is *not* in WAL is worth seeing on the panel.
        $detail['journal_mode'] = strtolower((string) (DB::connection()->select('pragma journal_mode')[0]->journal_mode ?? ''));

        $path = DB::connection()->getDatabaseName();
        if (is_string($path) && is_file($path)) {
            $detail['size_bytes'] = filesize($path) ?: null;
        }

        return $detail;
    }

    /**
     * @return array{state: string, last_beat_at: string|null, age_seconds: int|null}
     */
    public static function heartbeat(string $key): array
    {
        $last = Heartbeat::lastAt($key);
        $grace = (int) config('hud.health.heartbeat_grace', 150);

        if ($last === null) {
            // Never, not late. A machine where the tasks were never registered
            // should read differently from one where they stopped an hour ago,
            // because the fix is different — see the Task Scheduler section of
            // CLAUDE.md.
            return ['state' => 'unknown', 'last_beat_at' => null, 'age_seconds' => null];
        }

        $age = (int) max(0, CarbonImmutable::now()->diffInSeconds($last, true));

        return [
            'state' => $age <= $grace ? 'up' : 'down',
            'last_beat_at' => $last->toIso8601String(),
            'age_seconds' => $age,
        ];
    }

    /**
     * How much work is waiting, when the queue is one this can count.
     *
     * @return array{pending: int|null}
     */
    public static function backlog(): array
    {
        if (config('queue.default') !== 'database') {
            return ['pending' => null];
        }

        try {
            $table = config('queue.connections.database.table', 'jobs');

            return ['pending' => DB::table($table)->count()];
        } catch (Throwable) {
            return ['pending' => null];
        }
    }

    /**
     * The assistant: configured, and switched on.
     *
     * Two separate questions with one row to say them in. `down` is a machine
     * missing its API key, which is a setup that was never finished; `off` is
     * the switch on the Settings screen, which is a choice. They are not
     * collapsed for the same reason a heartbeat that has never happened is
     * `unknown` rather than `down` — the fix is different, and a single failed
     * state would send someone editing `.env` to undo a tap.
     *
     * @return array<string, mixed>
     */
    public static function assistant(): array
    {
        return AnthropicSwitch::state();
    }
}
