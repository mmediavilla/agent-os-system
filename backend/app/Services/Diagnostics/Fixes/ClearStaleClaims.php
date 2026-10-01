<?php

namespace App\Services\Diagnostics\Fixes;

use App\Services\Diagnostics\SoftFix;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Delete the cache rows and locks whose time is up.
 *
 * Laravel's database store removes an expired row only when that key is read
 * again, so one-off keys and the `Cache::add` claims a crashed job never
 * released pile up. **Only expired rows go**: a live claim cannot be told from
 * one whose owner died, and it expires on its own clock — deleting it would
 * let the work it guards run twice. That includes this Troubleshoot's own claim.
 */
class ClearStaleClaims extends Fix
{
    public static function fix(): SoftFix
    {
        return SoftFix::ClearStaleClaims;
    }

    public function unavailable(): ?string
    {
        return $this->store() === null ? 'The cache is not kept in the database, so there are no rows to clear.' : null;
    }

    public function run(): string
    {
        ['table' => $table, 'locks' => $locks] = $this->store();
        $now = now()->getTimestamp();

        $rows = DB::table($table)->where('expiration', '<', $now)->delete();
        $claims = Schema::hasTable($locks) ? DB::table($locks)->where('expiration', '<', $now)->delete() : 0;

        return "Removed {$rows} expired cache ".($rows === 1 ? 'row' : 'rows')." and {$claims} expired ".($claims === 1 ? 'lock' : 'locks').'.';
    }

    /**
     * @return array{table: string, locks: string}|null
     */
    private function store(): ?array
    {
        $store = config('cache.default');

        if (config("cache.stores.{$store}.driver") !== 'database') {
            return null;
        }

        return [
            // Laravel's own config sets both to null when the `.env` names neither.
            'table' => (string) (config("cache.stores.{$store}.table") ?: 'cache'),
            'locks' => (string) (config("cache.stores.{$store}.lock_table") ?: 'cache_locks'),
        ];
    }
}
