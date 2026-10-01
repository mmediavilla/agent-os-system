<?php

return [

    /*
    |--------------------------------------------------------------------------
    | Agent API token
    |--------------------------------------------------------------------------
    |
    | The shared secret guarding POST /api/mcp, and nothing else. It is a
    | *machine* credential, not a user login: nothing about it populates
    | `$request->user()`. That used to matter a great deal, because every
    | ownership rule read `$request->user()?->id` against rows whose `user_id`
    | was null, so authenticating a user here would have silently repartitioned
    | the whole database. Since the owner backfill nothing reads the request for
    | an owner at all — `Owner::id()` answers from the database — so this is now
    | a statement about what the token *means* rather than a hazard being
    | avoided.
    |
    | The app's own chat routes carried this token once, and do not any more.
    | Every `EXPO_PUBLIC_*` value is inlined into the web bundle, so a token the
    | page could send is one anyone loading the page can read; since Phase 14
    | `/api/agent/*` sits behind the owner's Google sign-in instead. A checkout
    | with nothing set here still has a working assistant — only MCP goes dark.
    |
    | Unset means the MCP route is closed, not open — see ApiToken. Generate
    | one with:  php -r "echo bin2hex(random_bytes(32));"
    |
    */

    'token' => env('AGENT_API_TOKEN'),

    /*
    |--------------------------------------------------------------------------
    | Requests per minute
    |--------------------------------------------------------------------------
    |
    | Applied as the `agent` rate limiter. A tool-calling endpoint is not a
    | normal read: a client stuck in a retry loop against it spends real money
    | on the model's side of the conversation, so the ceiling is deliberately
    | far below what a human driving a chat can reach.
    |
    */

    'rate_limit' => (int) env('AGENT_RATE_LIMIT', 30),

    /*
    |--------------------------------------------------------------------------
    | Loop ceiling
    |--------------------------------------------------------------------------
    |
    | How many model calls one user message may cost before AgentRunner stops
    | asking and makes the model answer with what it has. Each iteration is a
    | paid round trip that re-sends the whole transcript, so a model stuck
    | alternating between two tools is expensive long before it is wrong.
    |
    | Hitting the ceiling is not an error: the run comes back with a real answer
    | and a `max_iterations` status, because throwing here would charge for a
    | dozen calls and then show a 500.
    |
    */

    'max_iterations' => (int) env('AGENT_MAX_ITERATIONS', 12),

    /*
    |--------------------------------------------------------------------------
    | Watching a run
    |--------------------------------------------------------------------------
    |
    | A queued run writes its progress to `agent_run_events`, and both ways of
    | watching it — the SSE stream and the polling endpoint — read that same
    | log. The stream is a long-lived request, which on this stack means one
    | PHP-FPM child held open for its whole duration, so it is deliberately
    | short-lived and lets the browser reconnect: `EventSource` does that by
    | itself, carrying `Last-Event-ID`, and resuming costs one indexed query.
    |
    | `max_seconds` therefore has to stay comfortably under the web server's own
    | read timeout, or the connection is cut in a way the client cannot tell
    | apart from a crash. `poll_ms` is how often the stream looks for new
    | events: it is the floor on how stale the display can be, and also how
    | often the streaming request touches the database while a worker is
    | writing to it.
    |
    */

    'stream' => [
        'poll_ms' => (int) env('AGENT_STREAM_POLL_MS', 250),
        'max_seconds' => (int) env('AGENT_STREAM_MAX_SECONDS', 110),

        // What the browser is told to wait before reconnecting a dropped
        // stream. Only ever read by EventSource.
        'retry_ms' => (int) env('AGENT_STREAM_RETRY_MS', 1500),
    ],

    /*
    |--------------------------------------------------------------------------
    | Camera snapshots
    |--------------------------------------------------------------------------
    |
    | The HUD's camera panel is a monitor and costs nothing: the preview never
    | leaves the browser. Pressing Capture is what spends money, and these three
    | numbers are the whole of what stops it spending more than was intended.
    |
    | `max_kb` is a size the *encoder* should never exceed — the client
    | downscales before it uploads — so exceeding it is a bug rather than a
    | large photograph, and the answer is 413 rather than a silent resize on
    | this side. Anthropic downsamples anything over 1568px on its own, so a
    | bigger frame buys tokens and no detail.
    |
    | `replay` is the one worth understanding. An image is not paid for once: it
    | goes back up with the transcript on every later turn of every later loop,
    | at roughly eleven hundred tokens a time. Carrying only the most recent few
    | keeps a long conversation from getting quietly more expensive with every
    | picture in it; the ones dropped say so in the transcript rather than
    | vanishing, so the model knows it is not being shown something.
    |
    | `per_day` is not sized for a person — nobody presses a button forty times
    | — but for the failure where something other than a person is pressing it.
    | The window is `agent.timezone`'s day, not the server's.
    |
    */

    'snapshots' => [
        'per_day' => (int) env('AGENT_SNAPSHOTS_PER_DAY', 25),
        'max_kb' => (int) env('AGENT_SNAPSHOT_MAX_KB', 1500),
        'replay' => (int) env('AGENT_SNAPSHOT_REPLAY', 3),
    ],

    /*
    |--------------------------------------------------------------------------
    | The spoken conversation
    |--------------------------------------------------------------------------
    |
    | Answering a question that was asked out loud. ElevenLabs' agent does
    | speech to text, text to speech and turn-taking, and calls a client tool
    | for anything about the user; that tool posts to `POST /api/voice/turn`,
    | which is the tool loop over the reads alone. Which voice it speaks in, and
    | which TTS model, are settings on the agent in the ElevenLabs dashboard —
    | nothing on this side chooses a voice any more.
    |
    | The turn endpoint needs no key at all — 9.0 was deliberately provable with
    | no ElevenLabs account — but it does need a ceiling of its own. A voice turn
    | spends what a typed message spends, because it *is* a typed message with a
    | microphone in front of it, so it wants an `agent`-shaped limit — but not
    | the same bucket, or a spoken question costs a typed one its slot while
    | both are being used in the same thread by the same person.
    |
    | The key below is for the other half: `GET /api/voice/token` mints the
    | short-lived WebRTC token the page opens a session with, for the same
    | reason the Anthropic key never reaches the browser — every EXPO_PUBLIC_*
    | value is inlined into the web bundle, so a key the page could send is a
    | key anyone loading the app can read. The browser is handed a token scoped
    | to one conversation and never a credential.
    |
    | A key needs `convai_write` on it for that call. A key with only the
    | text-to-speech scopes authenticates fine and is refused here, which reads
    | as a broken feature rather than a missing permission unless the message is
    | passed through — so it is.
    |
    */

    'voice' => [

        'rate_limit' => (int) env('VOICE_RATE_LIMIT', 20),

        'key' => env('ELEVENLABS_API_KEY'),

        // Created in the ElevenLabs dashboard, not here. Everything about the
        // agent that is not a secret — its router prompt, its LLM, pre-tool
        // speech, how long it waits on our loop — is a setting over there,
        // because that is where the thing runs. What this side owns is *which*
        // agent, and the key that proves we may open a session with it.
        'agent_id' => env('ELEVENLABS_AGENT_ID'),

        'token_endpoint' => env(
            'ELEVENLABS_TOKEN_ENDPOINT',
            'https://api.elevenlabs.io/v1/convai/conversation/token',
        ),

        // Short on purpose. Somebody is standing there having just pressed
        // Talk, and a token that has not arrived in a few seconds is better
        // reported than waited on.
        'token_timeout' => (int) env('ELEVENLABS_TOKEN_TIMEOUT', 8),

        // Where the plan's allowance is read (`VoiceCredits`). Needs
        // `user_read` on the key, which the token call does not.
        'subscription_endpoint' => env(
            'ELEVENLABS_SUBSCRIPTION_ENDPOINT',
            'https://api.elevenlabs.io/v1/user/subscription',
        ),

        // The weather's pair: a reading is good for ten minutes, a failure is
        // remembered for one so an outage is not a retry loop.
        'credits_ttl' => 600,
        'credits_failure_ttl' => 60,

        // Under this share of the plan left, Diagnose warns.
        'credits_warn_ratio' => 0.1,

    ],

    /*
    |--------------------------------------------------------------------------
    | The clock the user lives on
    |--------------------------------------------------------------------------
    |
    | `config('app.timezone')` is UTC and always will be — every timestamp in
    | the database is stored in it — and that is the wrong clock for two of the
    | assistant's questions: when "before breakfast" is, and what day "today"
    | is. The owner of this machine is eight hours ahead of the server it runs
    | on, so a UTC "today" is *yesterday's* date for the first eight hours of
    | every morning.
    |
    | That was survivable while the assistant only read a training log, where
    | being a day out shows up as a slightly wrong window. It stopped being
    | survivable in 7.3b: an assistant that can put something on a calendar for
    | "tomorrow" needs today's date to be today's date.
    |
    | One setting for both. It was named PROACTIVE_TIMEZONE first, when the
    | nudge's schedule was the only thing that cared, and that spelling is still
    | honoured so an existing `.env` needs no edit.
    |
    */

    'timezone' => env('AGENT_TIMEZONE', env('PROACTIVE_TIMEZONE', 'UTC')),

    /*
    |--------------------------------------------------------------------------
    | Proactive nudges
    |--------------------------------------------------------------------------
    |
    | The one scheduled thing in the app. `GenerateProactiveInsights` runs a
    | deterministic, zero-cost trigger check every morning and calls the model
    | only when one fires, so the switch below is not a cost control — it is
    | there because "the app talks to me unprompted" is a preference, and it
    | should be revocable without editing a schedule.
    |
    | The time is read on `agent.timezone` above rather than on the app's UTC,
    | for the reason given there — "before breakfast" is a local hour.
    |
    */

    'proactive' => [
        'enabled' => filter_var(env('PROACTIVE_INSIGHTS_ENABLED', true), FILTER_VALIDATE_BOOL),
        'time' => env('PROACTIVE_TIME', '07:00'),
    ],

    /*
    |--------------------------------------------------------------------------
    | Reaching this machine
    |--------------------------------------------------------------------------
    |
    | The places `open_on_this_machine` is allowed to open. This list is the
    | whole of that tool's authority: the model picks a key out of it and can
    | never name a path of its own, so widening what the assistant can reach
    | means editing this file rather than trusting a description.
    |
    | It is off by default, and off means the tool is not registered at all —
    | it never appears in `tools/list`, never reaches a request's `tools`, and
    | is not mentioned in the system prompt. Same shape as the MCP token:
    | absent configuration closes the door rather than leaving it open. The
    | targets below are written out regardless, so turning it on is one line in
    | `.env` and not an afternoon of deciding what to allow.
    |
    | `open` is handed to the shell exactly as a double-click would be, so a
    | folder, a file, an executable and an https URL are all the same kind of
    | entry. It carries no arguments yet: "open the editor" works, "open the
    | editor on this file" is the next increment and wants a second key.
    |
    | The two folders are derived rather than written out, so they are right in
    | any checkout. Anything machine-specific comes from the environment
    | instead, and drops out of the list when it is unset.
    |
    */

    'local' => [

        // Revocable without deleting the list. "The assistant can open things on
        // my computer" is a preference, and a preference should be one switch.
        'enabled' => filter_var(env('LOCAL_ACTIONS_ENABLED', false), FILTER_VALIDATE_BOOL),

        'targets' => [

            'project_folder' => [
                'label' => 'The ProjectMC source folder, in a file explorer',
                'open' => dirname(base_path()),
            ],

            'backend_logs' => [
                'label' => 'The Laravel log folder, where laravel.log is written',
                'open' => storage_path('logs'),
            ],

            'life_os' => [
                'label' => 'The ProjectMC web app, in the default browser',
                'open' => env('APP_WEB_URL', 'https://projectmc-app.test'),
            ],

            'editor' => [
                'label' => 'The code editor',
                'open' => env('LOCAL_ACTIONS_EDITOR'),
            ],

        ],

    ],

];
