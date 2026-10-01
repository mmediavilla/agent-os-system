<?php

namespace App\Services\Diagnostics\Fixes;

use App\Services\Diagnostics\SoftFix;
use Illuminate\Support\Facades\Artisan;

/**
 * Delete the cached configuration, routes and events, so the next request reads
 * `.env` and the route files again.
 *
 * A cache, not source: nothing is lost that the next request does not rebuild.
 * It is the landmine that once pointed a `migrate` meant for a test database at
 * the live one, because a cached config makes every `env()` read a no-op.
 */
class ClearConfigCache extends Fix
{
    public static function fix(): SoftFix
    {
        return SoftFix::ClearConfigCache;
    }

    public function run(): string
    {
        foreach (['config:clear', 'route:clear', 'event:clear'] as $command) {
            if (Artisan::call($command) !== 0) {
                throw new \RuntimeException("php artisan {$command} did not succeed: ".trim(Artisan::output()));
            }
        }

        // The worker loaded its configuration when it started, and keeps it.
        return 'Cleared the cached configuration, routes and events; requests read .env again, and the queue worker does from its next restart.';
    }
}
