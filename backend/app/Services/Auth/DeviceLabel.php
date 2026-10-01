<?php

namespace App\Services\Auth;

/**
 * "Chrome on Windows" from a user-agent string — the name a session is listed
 * under in Profile.
 *
 * Deliberately coarse. It only has to tell one of the owner's browsers from
 * another, and a full parser is a dependency that goes stale for a label. The
 * raw string is stored beside it for anything finer.
 */
final class DeviceLabel
{
    /** Checked in order: Edge and Opera also say "Chrome", and Chrome says "Safari". */
    private const BROWSERS = [
        'Edg/' => 'Edge',
        'OPR/' => 'Opera',
        'Firefox/' => 'Firefox',
        'Chrome/' => 'Chrome',
        'Safari/' => 'Safari',
    ];

    /** iOS and Android before the desktops whose names they also contain. */
    private const SYSTEMS = [
        'iPhone' => 'iPhone',
        'iPad' => 'iPad',
        'Android' => 'Android',
        'Windows' => 'Windows',
        'Mac OS X' => 'macOS',
        'CrOS' => 'ChromeOS',
        'Linux' => 'Linux',
    ];

    public static function from(?string $userAgent): string
    {
        $ua = (string) $userAgent;

        $browser = self::first(self::BROWSERS, $ua);
        $system = self::first(self::SYSTEMS, $ua);

        return match (true) {
            $browser !== null && $system !== null => "{$browser} on {$system}",
            $browser !== null => $browser,
            $system !== null => $system,
            default => 'Unknown device',
        };
    }

    /** @param  array<string, string>  $table */
    private static function first(array $table, string $ua): ?string
    {
        foreach ($table as $needle => $label) {
            if (str_contains($ua, $needle)) {
                return $label;
            }
        }

        return null;
    }
}
