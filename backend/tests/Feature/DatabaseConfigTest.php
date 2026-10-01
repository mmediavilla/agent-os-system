<?php

namespace Tests\Feature;

use Tests\TestCase;

/**
 * The SQLite connection's three concurrency settings, pinned.
 *
 * **This is a pin, not a reproduction, and it cannot be anything else.** The
 * suite runs on `:memory:` with `CACHE_STORE=array` (phpunit.xml), so there is
 * no file for a second connection to contend over and no cache write to lose —
 * the failure these settings exist to prevent is unreachable from in here. It
 * was measured outside the suite instead: 300 read-then-write transactions
 * against a concurrent writer gave `DEFERRED` 38 ok / 262 locked and
 * `IMMEDIATE` 300 ok / 0 locked.
 *
 * What that leaves worth asserting is the thing that would actually rot: all
 * three values are Laravel defaults or near-defaults, so a future tidy-up has
 * every reason to drop them and no local evidence that it must not.
 * `transaction_mode` is the likeliest casualty, because `DEFERRED` is both
 * SQLite's default and the more permissive-sounding word — and losing it puts
 * the busy timeout beyond reach without changing anything visible, since
 * `SQLITE_BUSY_SNAPSHOT` never calls the busy handler.
 */
class DatabaseConfigTest extends TestCase
{
    public function test_sqlite_begins_transactions_immediately(): void
    {
        // Not DEFERRED: a transaction that reads before it writes would take
        // its snapshot at the SELECT and fail outright on the upgrade.
        $this->assertSame('IMMEDIATE', config('database.connections.sqlite.transaction_mode'));
    }

    public function test_sqlite_is_in_wal_with_a_busy_timeout(): void
    {
        $this->assertSame('WAL', config('database.connections.sqlite.journal_mode'));
        $this->assertGreaterThan(0, (int) config('database.connections.sqlite.busy_timeout'));
    }
}
