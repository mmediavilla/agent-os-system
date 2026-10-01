<?php

namespace App\Services\Diagnostics\Checks;

use App\Services\Diagnostics\Finding;
use App\Services\Diagnostics\Format;
use App\Services\Diagnostics\SoftFix;
use App\Services\System\Health;
use Illuminate\Support\Facades\DB;

/**
 * The database answers, and the three settings that keep a reader and the
 * worker from locking each other out are the ones the *live* connection uses.
 *
 * `DatabaseConfigTest` pins those three in config, which is all the suite can
 * do (`:memory:`). This reads them off the connection that is actually open,
 * which is the one a stale config cache or an older PHP would have changed.
 */
class DatabaseChecks extends Check
{
    public static function group(): string
    {
        return 'database';
    }

    public static function title(): string
    {
        return 'Database';
    }

    public function run(): array
    {
        $db = Health::database();

        if ($db['state'] !== 'up') {
            return [$this->problem(
                'reachable',
                'Database reachable',
                'The database did not answer a query, so nothing that reads or writes a row can work.',
                [(string) ($db['detail'] ?? 'no answer')],
                manual: 'Check that DB_DATABASE in backend/.env names database/database.sqlite and that the file exists.',
            )];
        }

        $findings = [$this->ok('reachable', 'Database reachable', 'The database answered a query.', [
            "driver: {$db['driver']}",
            "latency: {$db['latency_ms']} ms",
        ])];

        if ($db['driver'] !== 'sqlite') {
            return $findings;
        }

        $findings[] = $this->journalMode((string) $db['journal_mode']);
        $findings[] = $this->busyTimeout();
        $findings[] = $this->transactionMode();
        $findings[] = $this->files();

        return $findings;
    }

    private function journalMode(string $mode): Finding
    {
        $title = 'Write-ahead log';

        if ($mode === 'wal') {
            return $this->ok('journal_mode', $title, 'The database is in WAL, so the run stream can read while the worker writes.', ['journal_mode: wal']);
        }

        return $this->problem(
            'journal_mode',
            $title,
            "The database is in {$mode} mode, not WAL: a reader and the worker take turns on a whole-file lock, and the loser gets \"database is locked\".",
            ["journal_mode: {$mode}", 'configured: '.(config('database.connections.sqlite.journal_mode') ?? 'nothing')],
            manual: 'Put journal_mode back to WAL in config/database.php, then run php artisan config:clear.',
        );
    }

    private function busyTimeout(): Finding
    {
        $row = (array) DB::selectOne('pragma busy_timeout');
        $timeout = (int) (reset($row) ?: 0);
        $title = 'Busy timeout';

        if ($timeout > 0) {
            return $this->ok('busy_timeout', $title, 'A write that finds the database busy waits rather than failing at once.', ["busy_timeout: {$timeout} ms"]);
        }

        return $this->problem(
            'busy_timeout',
            $title,
            'The connection has no busy timeout, so any write that meets another one fails at once with "database is locked".',
            ['busy_timeout: 0'],
            manual: 'Put busy_timeout back in config/database.php, then run php artisan config:clear.',
        );
    }

    /**
     * Laravel begins `IMMEDIATE` only on PHP 8.4 and later; below that PDO's
     * own deferred `BEGIN` comes back, and so does `SQLITE_BUSY_SNAPSHOT`.
     */
    private function transactionMode(): Finding
    {
        $mode = strtoupper((string) (DB::connection()->getConfig('transaction_mode') ?? 'DEFERRED'));
        $honoured = PHP_VERSION_ID >= 80400;
        $title = 'Transactions begin IMMEDIATE';
        $evidence = ["transaction_mode: {$mode}", 'PHP '.PHP_VERSION];

        if ($mode === 'IMMEDIATE' && $honoured) {
            return $this->ok('transaction_mode', $title, 'Writers queue for the lock instead of failing on a stale read snapshot.', $evidence);
        }

        return $this->problem(
            'transaction_mode',
            $title,
            $honoured
                ? "Transactions begin {$mode}. One that reads before it writes fails at once with \"database is locked\" whenever another write lands between the two."
                : 'This PHP is older than 8.4, where Laravel ignores transaction_mode, so every transaction begins DEFERRED.',
            $evidence,
            manual: $honoured
                ? 'Put transaction_mode back to IMMEDIATE in config/database.php, then run php artisan config:clear.'
                : 'Run the app on Herd\'s PHP 8.4.',
        );
    }

    private function files(): Finding
    {
        $path = DB::connection()->getDatabaseName();
        $title = 'Database files';

        if (! is_string($path) || ! is_file($path)) {
            return $this->ok('files', $title, 'The database is not a file on this disk.', ['database: '.(is_string($path) ? $path : 'unknown')]);
        }

        $size = (int) filesize($path);
        $wal = is_file("{$path}-wal") ? (int) filesize("{$path}-wal") : 0;
        $evidence = ['size: '.Format::bytes($size), 'wal: '.Format::bytes($wal)];
        $floor = (int) config('diagnostics.database.wal_warn_bytes');

        if ($wal > $floor) {
            return $this->warn(
                'files',
                $title,
                'The write-ahead log is larger than it should get, which usually means nothing has checkpointed it in a while.',
                $evidence,
                fix: SoftFix::CheckpointWal,
            );
        }

        return $this->ok('files', $title, 'The database and its write-ahead log are a normal size.', $evidence);
    }
}
