<?php

return [

    /*
    |--------------------------------------------------------------------------
    | Third Party Services
    |--------------------------------------------------------------------------
    |
    | This file is for storing the credentials for third party services such
    | as Mailgun, Postmark, AWS and more. This file provides the de facto
    | location for this type of information, allowing packages to have
    | a conventional file to locate the various service credentials.
    |
    */

    'postmark' => [
        'key' => env('POSTMARK_API_KEY'),
    ],

    'resend' => [
        'key' => env('RESEND_API_KEY'),
    ],

    'ses' => [
        'key' => env('AWS_ACCESS_KEY_ID'),
        'secret' => env('AWS_SECRET_ACCESS_KEY'),
        'region' => env('AWS_DEFAULT_REGION', 'us-east-1'),
    ],

    'slack' => [
        'notifications' => [
            'bot_user_oauth_token' => env('SLACK_BOT_USER_OAUTH_TOKEN'),
            'channel' => env('SLACK_BOT_USER_DEFAULT_CHANNEL'),
        ],
    ],

    /*
     * Google sign-in — an OAuth client of type Web, made in Google Cloud Console.
     *
     * The redirect is `localhost`, not `projectmc-app.test`, because Google
     * refuses `.test` redirect URIs outright. Expo already serves localhost:8082,
     * and the page it serves there forwards the code to the app's own origin
     * (see `Services\Auth\GoogleSignIn`). It must match the client's authorised
     * redirect URI to the character.
     */
    'google' => [
        'client_id' => env('GOOGLE_CLIENT_ID'),
        'client_secret' => env('GOOGLE_CLIENT_SECRET'),
        'redirect' => env('GOOGLE_REDIRECT_URI', 'http://localhost:8082/auth/callback'),
    ],

    /*
     * Two models, because the two workloads price out differently.
     *
     * `model` runs the weekly insight: one call a week over three weeks of
     * training, where depth is the whole point and the cost is noise — Opus.
     *
     * `agent_model` runs the tool loop, where a single question can be a dozen
     * round-trips and the transcript is re-sent on every one — Sonnet.
     *
     * Their token ceilings are separate for a sharper reason: a turn that emits
     * thinking *and* a tool call needs room for both, and the 1024 that suffices
     * for a 200-word assessment truncates such a turn mid-JSON. That surfaces as
     * intermittently corrupt tool calls rather than as an obvious limit error,
     * so the agent gets its own floor of 8192 and never inherits the shared one.
     */
    'anthropic' => [
        'key' => env('ANTHROPIC_API_KEY'),
        'model' => env('ANTHROPIC_MODEL', 'claude-opus-5'),
        'max_tokens' => (int) env('ANTHROPIC_MAX_TOKENS', 1024),
        'agent_model' => env('ANTHROPIC_AGENT_MODEL', 'claude-sonnet-5'),
        'agent_max_tokens' => (int) env('ANTHROPIC_AGENT_MAX_TOKENS', 8192),
        'effort' => env('ANTHROPIC_EFFORT', 'high'), // low | medium | high | xhigh | max

        // Whether a streamed turn carries readable thinking. `omitted` returns
        // a signature and no text, which is cheaper to store and re-send but
        // leaves the Assistant screen showing nothing at all for the seconds
        // before the first word of the answer. `summarized` is what the orb and
        // the live transcript have to work with, so it is the default here even
        // though the insight path (which never streams) has no use for it.
        'thinking_display' => env('ANTHROPIC_THINKING_DISPLAY', 'summarized'), // summarized | omitted
    ],

];
