<?php

namespace App\Services\Diagnostics\Fixes;

use App\Services\Diagnostics\SoftFix;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\DB;
use RuntimeException;

/**
 * `queue:retry all` — put every recorded failure back on the queue.
 *
 * Work already asked for, not new work. Some of it may spend money when it
 * runs (a morning nudge, an automation's greeting), which is why the dialog
 * names this fix rather than folding it into "tidy up".
 */
class RetryFailedJobs extends Fix
{
    public static function fix(): SoftFix
    {
        return SoftFix::RetryFailedJobs;
    }

    public function run(): string
    {
        $table = (string) config('queue.failed.table', 'failed_jobs');
        $count = DB::table($table)->count();

        if ($count === 0) {
            return 'No job had failed by the time this ran.';
        }

        if (Artisan::call('queue:retry', ['id' => ['all']]) !== 0) {
            throw new RuntimeException('php artisan queue:retry all did not succeed: '.trim(Artisan::output()));
        }

        return $count === 1 ? 'Put the failed job back on the queue.' : "Put {$count} failed jobs back on the queue.";
    }
}
