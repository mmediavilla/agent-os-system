<?php

namespace App\Services\Diagnostics\Checks;

use App\Agent\Support\SnapshotStore;
use App\Models\Document;
use App\Models\Snapshot;
use App\Services\Diagnostics\Finding;
use App\Services\Diagnostics\Format;
use App\Services\Diagnostics\SoftFix;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Storage;

/**
 * What the private disk and the log hold, and what has come apart.
 *
 * A camera frame is a row and a file, and either can outlive the other: a
 * thread deleted by hand leaves files, a storage folder never copied leaves
 * rows. Files with no row are safe to delete (18.2); rows with no file are
 * reported and left, since the transcript already reads without them.
 */
class StorageChecks extends Check
{
    public static function group(): string
    {
        return 'storage';
    }

    public static function title(): string
    {
        return 'Storage';
    }

    public function run(): array
    {
        return [
            $this->snapshots(),
            $this->documents(),
            $this->log(),
            $this->cache(),
        ];
    }

    private function snapshots(): Finding
    {
        $title = 'Camera frames';
        $rows = Snapshot::query()->pluck('path')->filter()->all();

        $orphanFiles = SnapshotStore::orphanFiles();
        $onDisk = array_flip(Storage::allFiles(SnapshotStore::DIRECTORY));
        $missing = count(array_filter($rows, fn (string $path) => ! isset($onDisk[$path])));

        $evidence = [
            'frames: '.count($rows),
            'on disk: '.Format::bytes((int) Snapshot::query()->sum('bytes')),
            'files with no row: '.count($orphanFiles),
            "rows with no file: {$missing}",
        ];

        if ($orphanFiles !== []) {
            return $this->warn('snapshots', $title, 'Some frame files belong to no conversation and take disk for nothing.', $evidence, fix: SoftFix::PruneOrphanSnapshots);
        }

        if ($missing > 0) {
            return $this->warn('snapshots', $title, 'Some frames\' files are gone, so those pictures show as missing in their threads.', $evidence, manual: 'Nothing to run: copy storage/app/private/snapshots back from wherever it was, or leave it.');
        }

        return $this->ok('snapshots', $title, 'Every frame has its file and every file its frame.', $evidence);
    }

    /**
     * A readout, never a fault: how much of the private disk filed documents
     * take. It was the old Stats storage card's line, and an `ok` finding
     * carrying it is how it survived the rework (18.1). A record with nothing
     * uploaded takes no disk, so only documents with a file are counted.
     */
    private function documents(): Finding
    {
        $filed = Document::query()->whereNotNull('file_path');

        return $this->ok('documents', 'Filed documents', 'What the filed documents take on the private disk.', [
            'with a file: '.(clone $filed)->count(),
            'on disk: '.Format::bytes((int) $filed->sum('size_bytes')),
        ]);
    }

    private function log(): Finding
    {
        $path = storage_path('logs/laravel.log');
        $title = 'Application log';

        if (! is_file($path)) {
            return $this->ok('log', $title, 'There is no log file.', ['laravel.log: none']);
        }

        $size = (int) filesize($path);
        $evidence = ['laravel.log: '.Format::bytes($size)];

        if ($size > (int) config('diagnostics.storage.log_warn_bytes')) {
            return $this->warn('log', $title, 'The log has grown large enough to be slow to open and search.', $evidence, manual: 'Delete backend/storage/logs/laravel.log; Laravel starts a new one.');
        }

        return $this->ok('log', $title, 'The log is a reasonable size.', $evidence);
    }

    /**
     * Only a database cache store keeps expired rows to count. `Cache::add`
     * claims a crashed job never released live here too.
     */
    private function cache(): Finding
    {
        $title = 'Cache';
        $store = config('cache.default');

        if (config("cache.stores.{$store}.driver") !== 'database') {
            return $this->ok('cache', $title, 'The cache is not kept in the database, so there is nothing to count.', ["store: {$store}"]);
        }

        $table = config("cache.stores.{$store}.table", 'cache');
        $expired = DB::table($table)->where('expiration', '<', now()->getTimestamp())->count();
        $evidence = ['rows: '.DB::table($table)->count(), "expired: {$expired}"];

        if ($expired > (int) config('diagnostics.storage.expired_cache_warn')) {
            return $this->warn('cache', $title, 'Expired cache rows are piling up; Laravel only removes one when it is read again.', $evidence, fix: SoftFix::ClearStaleClaims);
        }

        return $this->ok('cache', $title, 'The cache is tidy.', $evidence);
    }
}
