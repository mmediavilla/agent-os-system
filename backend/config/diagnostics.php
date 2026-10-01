<?php

/*
|--------------------------------------------------------------------------
| Diagnostics
|--------------------------------------------------------------------------
|
| What Stats' Diagnose button and `php artisan diagnose` judge, and where each
| line is drawn. Every check is free and read-only and none calls a model: a
| diagnosis has to work when the Anthropic key is missing or the switch is off,
| which is exactly when someone is diagnosing.
|
| Nothing here is an `.env` setting on purpose. These are judgements about this
| app, written down once with their reasons; a knob per threshold would be a
| dozen lines of `.env.example` nobody would ever change.
|
*/

return [

    // A report is a few kilobytes and a `.md` beside it. Twenty is a month of
    // pressing it daily, and the newest is the only one the page draws.
    'retention' => 20,

    // `set_time_limit` for a run inside a Herd request. Herd's 30s is wall
    // clock on Windows, and a run shells out to PowerShell (~500ms a start)
    // and resolves every calendar's host.
    'time_limit' => 60,

    // Troubleshoot is two check passes and the fixes between them, and a
    // restarted task is waited on until its heartbeat moves — so it gets more.
    'troubleshoot_time_limit' => 120,

    // Six presses a minute is a person; more is a stuck client, and each run
    // starts a PowerShell and resolves every calendar's host.
    'rate_limit' => 6,

    'database' => [
        // A `-wal` file is transient and checkpointed on its own as connections
        // close; past this it is a sign nothing has checkpointed in a while.
        'wal_warn_bytes' => 64 * 1024 * 1024,
    ],

    'queue' => [
        // Jobs waiting. The heartbeat job is one a minute, so a healthy idle
        // machine sits at zero or one.
        'backlog_warn' => 20,

        // A chat run is picked up within `--sleep` (1s) of being queued by a
        // live worker. Five minutes `queued` is a worker that is not there.
        'stuck_minutes' => 5,
    ],

    'machine' => [
        // A sample older than this is not judged. It is only refreshed while the
        // core menu or Stats is open, so an old one is normal, not a fault.
        'judge_within_seconds' => 600,
        'cpu_warn_percent' => 90,
        'memory_warn_percent' => 90,
        'disk_warn_percent' => 90,
        'disk_problem_percent' => 97,
    ],

    'sign_in' => [
        // Every live session expiring inside this window means being signed out
        // everywhere at once, soon.
        'expiring_days' => 7,
    ],

    'calendar' => [
        // A feed failing for longer than this is not a blip; it is most often a
        // reset secret address, which only the owner can fix.
        'stale_hours' => 24,
    ],

    'agent' => [
        // A write parked on an approval card this long is a thread nobody can
        // type into (a message while one is pending is a 409).
        'pending_action_hours' => 24,
    ],

    'storage' => [
        'log_warn_bytes' => 50 * 1024 * 1024,

        // Expired rows in the `cache` table. Laravel removes one only when it is
        // read again, so crashed claims and one-off keys pile up.
        'expired_cache_warn' => 500,
    ],

    'scheduler' => [
        // The two Windows tasks `scripts/register-runtime-tasks.ps1` creates.
        // Keyed so Troubleshoot can name the one it starts; the checks read
        // them in this order.
        'tasks' => [
            'scheduler' => 'ProjectMC scheduler',
            'worker' => 'ProjectMC queue worker',
        ],
        'probe_timeout' => 15,
    ],

    'fixes' => [
        // How long a restarted task is waited on for its heartbeat to move. A
        // worker boots and runs its first job in a few seconds; past this the
        // report says it did not answer, which is the truth to act on.
        'wait_seconds' => 15,

        // A frame's file is written a moment before its row, so a file this
        // young with no row may be one being saved right now. Left alone.
        'orphan_min_age_seconds' => 60,
    ],

    'frontend' => [
        // The Expo dev server behind Herd's proxy. A 502 is Expo not running.
        'url' => env('APP_WEB_URL', 'https://projectmc-app.test'),
        'timeout' => 4,
    ],

];
