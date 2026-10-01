<?php

namespace App\Services\Diagnostics\Fixes;

use App\Services\Diagnostics\Format;
use App\Services\Diagnostics\SoftFix;
use Illuminate\Support\Facades\DB;
use RuntimeException;

/**
 * `pragma wal_checkpoint(TRUNCATE)`: copy the write-ahead log back into the
 * database and cut the `-wal` file to nothing.
 *
 * No schema change and no data change — the log is a transient file SQLite
 * already checkpoints on its own as connections close. A reader holding a
 * snapshot makes the checkpoint stop short (`busy`), which is reported as a
 * failure rather than claimed as done.
 */
class CheckpointWal extends Fix
{
    public static function fix(): SoftFix
    {
        return SoftFix::CheckpointWal;
    }

    public function unavailable(): ?string
    {
        return DB::connection()->getDriverName() === 'sqlite' ? null : 'The database is not SQLite, so there is no write-ahead log to checkpoint.';
    }

    public function run(): string
    {
        $row = (array) DB::selectOne('pragma wal_checkpoint(TRUNCATE)');
        [$busy, $pages] = array_values($row) + [0, 0];

        if ((int) $busy !== 0) {
            throw new RuntimeException('Another connection was reading, so the checkpoint stopped short; try again when the app is idle.');
        }

        $path = DB::connection()->getDatabaseName();
        $wal = is_string($path) && is_file("{$path}-wal") ? (int) filesize("{$path}-wal") : 0;

        return 'Checkpointed '.max(0, (int) $pages).' pages; the write-ahead log is '.Format::bytes($wal).' now.';
    }
}
