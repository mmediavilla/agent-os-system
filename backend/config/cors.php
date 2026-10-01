<?php

return [

    /*
    |--------------------------------------------------------------------------
    | Cross-Origin Resource Sharing (CORS) Configuration
    |--------------------------------------------------------------------------
    |
    | Here you may configure your settings for cross-origin resource sharing
    | or "CORS". This determines what cross-origin operations may execute
    | in web browsers. You are free to adjust these settings as needed.
    |
    | To learn more: https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS
    |
    */

    'paths' => ['api/*', 'sanctum/csrf-cookie'],

    'allowed_methods' => ['*'],

    /*
     * A closed list: the Expo app on Herd, the same app on the port Herd
     * proxies, and one slot for the agent's own front end.
     *
     * That slot is env-driven and empty by default because the thing that fills
     * it does not exist yet — the desktop shell is the last phase, and the MCP
     * host driving the tools before then is not a browser and never sends an
     * Origin. Hardcoding a guess at the shell's dev port would be a permanently
     * allowed origin nothing checks.
     */
    'allowed_origins' => array_values(array_filter([
        'https://projectmc-app.test',
        'http://localhost:8082',
        env('AGENT_ALLOWED_ORIGIN'),
    ])),

    'allowed_origins_patterns' => [],

    'allowed_headers' => ['*'],

    'exposed_headers' => [],

    'max_age' => 0,

    'supports_credentials' => false,

];
