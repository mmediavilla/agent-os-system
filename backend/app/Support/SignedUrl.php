<?php

namespace App\Support;

use DateTimeInterface;
use Illuminate\Support\Facades\URL;

/**
 * URLs for the reads a browser makes without `fetch` — two `<img>` tags, an
 * `EventSource`, and (16.0) a document opened in a tab or an `<embed>` — which
 * therefore cannot send the bearer token.
 *
 * Each is minted inside a response that did pass the gate, so holding one is
 * proof of that, for as long as it lasts.
 */
final class SignedUrl
{
    /** How long a run's stream may be joined after its URL was handed out. */
    public const STREAM_MINUTES = 30;

    /**
     * A picture's URL, good until the end of the next UTC day.
     *
     * Not "a day from now": that would change the URL on every read, and a
     * changed URL is a new download, which is exactly what the pictures'
     * `immutable` caching exists to avoid. Pinned to a day boundary, every read
     * in one day mints the same URL, and a picture is fetched again about once
     * a day. A HUD left open overnight keeps a working URL for at least 24h.
     */
    public static function picture(string $route, array $parameters): string
    {
        return URL::temporarySignedRoute($route, self::pictureExpiry(), $parameters);
    }

    public static function pictureExpiry(): DateTimeInterface
    {
        return now()->utc()->addDay()->endOfDay();
    }

    /**
     * A filed document's URL, on the same day boundary and for the same reason:
     * every read in one day mints the same URL, so the browser can be told the
     * bytes are `immutable` and a twenty-megabyte scan is fetched once.
     *
     * A separate name rather than a second caller of {@see self::picture()},
     * because "picture" is what the two `<img>` routes are and a PDF is not
     * one — the rule they share is the expiry, which is written down once.
     */
    public static function file(string $route, array $parameters): string
    {
        return URL::temporarySignedRoute($route, self::pictureExpiry(), $parameters);
    }

    /**
     * A run's event stream. Short, because a run is watched while it happens;
     * a client that finds it expired falls back to polling `GET /runs/{id}`.
     */
    public static function stream(int|string $runId): string
    {
        return URL::temporarySignedRoute('agent.runs.stream', now()->addMinutes(self::STREAM_MINUTES), ['run' => $runId]);
    }
}
