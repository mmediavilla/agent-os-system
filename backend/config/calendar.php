<?php

return [

    /*
    |--------------------------------------------------------------------------
    | Calendars, read through their iCal addresses
    |--------------------------------------------------------------------------
    |
    | No OAuth and no developer project anywhere: each calendar — Google's
    | secret address, iCloud's public link, any provider's published feed — is
    | pasted once into Settings and stored encrypted in `calendar_feeds`. The
    | server fetches it, expands the recurrences, and serves wall-clock rows —
    | the address itself never leaves the backend. Which addresses it will
    | fetch at all is `App\Services\Calendar\FeedAddress`'s rule, not config.
    |
    | A feed is fetched at most once per `ttl` and a failure is remembered for
    | `failure_ttl`, the same pair the weather uses and for the same reason: the
    | HUD polls for as long as the tab is open, and an outage must not turn that
    | into a retry loop against the provider. A failed fetch keeps the last
    | reading.
    |
    */

    'ttl' => (int) env('CALENDAR_TTL', 300),

    'failure_ttl' => (int) env('CALENDAR_FAILURE_TTL', 60),

    'timeout' => (int) env('CALENDAR_TIMEOUT', 8),

    /*
    | How far either side of today a fetch reads.
    |
    | A Google feed carries every event the calendar has ever held, and
    | parsing all of it costs roughly 40MB of memory per megabyte of feed —
    | measured, and a decade of a busy calendar is several megabytes against a
    | 128MB limit. So one-off events wholly outside this span are dropped from
    | the text before it is parsed, and only this span is expanded and cached.
    | A question about a date outside it is answered as "outside what is read",
    | never as an empty day.
    */

    'past_days' => (int) env('CALENDAR_PAST_DAYS', 365),

    'future_days' => (int) env('CALENDAR_FUTURE_DAYS', 365),

    /*
    | Opening Google Calendar on this machine, from voice.
    |
    | `show_google_calendar` is offered to the spoken assistant only, and only
    | where `LOCAL_ACTIONS_ENABLED` is on — see the tool for why it is the one
    | ungated effect in the app. It opens `url` and nothing else, in a new tab
    | of the default browser; the model picks a view and a date, never an
    | address.
    */

    'open' => [
        'url' => 'https://calendar.google.com/calendar/r',
    ],

];
