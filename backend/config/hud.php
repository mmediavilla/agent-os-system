<?php

return [

    /*
    |--------------------------------------------------------------------------
    | This machine
    |--------------------------------------------------------------------------
    |
    | CPU and memory are the one thing on the HUD that PHP cannot answer for
    | itself on Windows: there is no `sys_getloadavg`, the COM extension is not
    | loaded in Herd's build, and `ffi.enable` is `preload`, so FFI is a CLI-only
    | door. What is left is a subprocess, and a cold `powershell.exe` costs
    | roughly half a second — measured — which is not a price a screen that is
    | left open all day should pay on every poll.
    |
    | So the probe never runs inside the request. `GET /api/system/stats` serves
    | whatever the last sample said and queues a fresh one when that sample is
    | older than `sample_ttl`; the response carries `age_seconds` so the client
    | can say how stale it is rather than pretend. `dispatch_ttl` is the guard on
    | that: it is claimed atomically, so a HUD polling every few seconds against
    | a dead queue worker enqueues one job, not one per poll.
    |
    | Disk is *not* in the sample. `disk_free_space()` is a stat() call and costs
    | nothing, so it is computed inline and is always current — which is also
    | what puts something on the panel before the first sample lands.
    |
    */

    'system' => [
        'sample_ttl' => (int) env('HUD_SAMPLE_TTL', 10),
        'dispatch_ttl' => (int) env('HUD_SAMPLE_DISPATCH_TTL', 20),

        // How long the probe may take before it is abandoned. A hung subprocess
        // holding a queue worker is worse than a missing gauge.
        'probe_timeout' => (int) env('HUD_SAMPLE_TIMEOUT', 15),

        // Which volume the disk gauge reports. Null means the one the
        // application is installed on, which is the honest default for a Life OS
        // that runs on one machine.
        'disk_path' => env('HUD_DISK_PATH'),
    ],

    /*
    |--------------------------------------------------------------------------
    | Weather
    |--------------------------------------------------------------------------
    |
    | Open-Meteo, because it is the only forecast API worth the panel that needs
    | no account and no key: a key would be a second secret to keep out of the
    | Expo bundle for a number that is public information.
    |
    | Unset coordinates mean the panel is *not configured* rather than broken,
    | and it says so — there is no sensible default location and guessing one
    | from an IP address is a request to a third party the user did not ask for.
    |
    | The assistant reads the same forecast through `get_weather`, and can name
    | another place; that is the one geocoding request, made because the user
    | named the place.
    |
    */

    'weather' => [
        'latitude' => env('WEATHER_LATITUDE'),
        'longitude' => env('WEATHER_LONGITUDE'),

        // What to call the place. Only a label — the home location is never
        // geocoded.
        'label' => env('WEATHER_LABEL'),

        'endpoint' => env('WEATHER_ENDPOINT', 'https://api.open-meteo.com/v1/forecast'),

        // Open-Meteo's own geocoder, keyless like the forecast.
        'geocoding_endpoint' => env('WEATHER_GEOCODING_ENDPOINT', 'https://geocoding-api.open-meteo.com/v1/search'),

        // Ten minutes. The upstream model updates far less often than that, and
        // the HUD polls for as long as the tab is open.
        'ttl' => (int) env('WEATHER_TTL', 600),

        // A failed call is cached too, briefly. Without it an outage turns a
        // screen left open all day into a retry loop against someone else's API.
        'failure_ttl' => (int) env('WEATHER_FAILURE_TTL', 60),

        'timeout' => (int) env('WEATHER_TIMEOUT', 6),
    ],

    /*
    |--------------------------------------------------------------------------
    | Backing services
    |--------------------------------------------------------------------------
    |
    | The queue worker and the scheduler are the two things Herd does not run,
    | and the two things whose absence is silent: a queued run sits at `queued`
    | forever, and the proactive check simply never fires. Neither has a status
    | to ask for, so both are asked to prove they are alive — the scheduler
    | stamps a cache key every minute, and the same tick queues a job that
    | stamps another. A heartbeat older than the grace below means down.
    |
    | The grace is generous on purpose: `schedule:run` is a once-a-minute tick
    | and the worker sleeps between polls, so anything under two minutes reports
    | a healthy machine as broken at least once an hour.
    |
    */

    'health' => [
        'heartbeat_grace' => (int) env('HUD_HEARTBEAT_GRACE', 150),
    ],

];
