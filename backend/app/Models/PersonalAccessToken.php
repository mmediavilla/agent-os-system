<?php

namespace App\Models;

use Laravel\Sanctum\PersonalAccessToken as SanctumToken;

/**
 * A signed-in browser, and where it was last seen from.
 *
 * Sanctum writes `last_used_at` on every authenticated request. Here that is
 * every 5s machine poll and every 15s health poll while the HUD is open — a
 * steady writer against a WAL database whose readers and writers already
 * contend (see *Platform traps* in CLAUDE.md), spent on a column nobody reads
 * more precisely than "a minute ago". So a touch that changes nothing but the
 * time is dropped while the stored one is under a minute old, and the one that
 * does land records the address it came from.
 */
class PersonalAccessToken extends SanctumToken
{
    /** How stale `last_used_at` may be before a request writes it again. */
    public const TOUCH_SECONDS = 60;

    protected $table = 'personal_access_tokens';

    protected static function booted(): void
    {
        static::updating(function (self $token) {
            $dirty = array_keys($token->getDirty());

            if (array_diff($dirty, ['last_used_at', 'updated_at']) !== []) {
                return null;
            }

            $previous = $token->getOriginal('last_used_at');

            if ($previous !== null && $previous->gt(now()->subSeconds(self::TOUCH_SECONDS))) {
                return false;
            }

            if (app()->bound('request')) {
                $token->ip_address = request()->ip();
            }

            return null;
        });
    }
}
