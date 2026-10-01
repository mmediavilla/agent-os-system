<?php

namespace App\Services\Diagnostics\Fixes;

use App\Agent\Support\SnapshotStore;
use App\Services\Diagnostics\Format;
use App\Services\Diagnostics\SoftFix;
use Illuminate\Support\Facades\Storage;

/**
 * Delete camera-frame **files** that no row points at. Never a row.
 *
 * Unreferenced by definition — no thread can show them and no turn replays
 * them — which is what makes deleting them soft, and why the dialog still names
 * it outright. `SnapshotStore::orphanFiles()` is the same list the check
 * counted. A file younger than `diagnostics.fixes.orphan_min_age_seconds` is
 * left alone: a frame's file is written a moment before its row, so a young
 * orphan may be a frame being saved right now.
 */
class PruneOrphanSnapshots extends Fix
{
    public static function fix(): SoftFix
    {
        return SoftFix::PruneOrphanSnapshots;
    }

    public function run(): string
    {
        $cutoff = now()->getTimestamp() - (int) config('diagnostics.fixes.orphan_min_age_seconds', 60);

        $old = array_values(array_filter(
            SnapshotStore::orphanFiles(),
            fn (string $path) => Storage::lastModified($path) <= $cutoff,
        ));

        if ($old === []) {
            return 'No frame file was orphaned by the time this ran.';
        }

        $bytes = array_sum(array_map(fn (string $path) => Storage::size($path), $old));

        Storage::delete($old);

        return (count($old) === 1 ? 'Deleted one frame file' : 'Deleted '.count($old).' frame files').' that no row pointed at, freeing '.Format::bytes($bytes).'.';
    }
}
