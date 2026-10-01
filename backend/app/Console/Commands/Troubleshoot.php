<?php

namespace App\Console\Commands;

use App\Http\Controllers\DiagnosticsController;
use App\Services\Diagnostics\Diagnoser;
use App\Services\Diagnostics\MarkdownReport;
use App\Services\Diagnostics\Report;
use App\Services\Diagnostics\ReportStore;
use App\Services\Diagnostics\Severity;
use App\Services\Diagnostics\Troubleshooter;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Cache;
use Throwable;

/**
 * The Troubleshoot button, for when the HUD will not load.
 *
 * Diagnoses, lists the soft fixes that diagnosis offers — the page's confirm
 * dialog, as text — and asks before running them. `--dry-run` stops after the
 * list; `--force` answers yes, which is also the only way it runs without a
 * terminal to ask in. The report is saved like the page's (source `cli`).
 *
 * It takes the same claim as the page, so the two cannot run at once — unless
 * the cache itself cannot be reached, which is exactly the broken machine this
 * command is for, so then it runs without one.
 *
 * Exits 1 when a problem remains afterwards.
 */
class Troubleshoot extends Command
{
    protected $signature = 'troubleshoot
        {--dry-run : List the fixes the checks offer, and run nothing}
        {--force : Apply them without asking}';

    protected $description = 'Apply the soft fixes the diagnostic checks offer, then check again (free — no model call)';

    public function handle(Diagnoser $diagnoser, Troubleshooter $troubleshooter): int
    {
        $offered = $troubleshooter->offered($diagnoser->run(Report::SOURCE_CLI));

        if ($offered === []) {
            $this->info('Nothing to fix: no finding offers a soft fix. Run php artisan diagnose for the whole report.');

            return self::SUCCESS;
        }

        $this->line('Troubleshoot would:');
        foreach ($offered as $fix) {
            $this->line("  - {$fix->label()} ({$fix->value})");
        }
        $this->line('Nothing else will be touched.');

        if ($this->option('dry-run')) {
            return self::SUCCESS;
        }

        if (! $this->option('force') && ! $this->confirm('Apply these?', false)) {
            $this->line('Nothing was run.');

            return self::SUCCESS;
        }

        $limit = (int) config('diagnostics.troubleshoot_time_limit');

        try {
            $claimed = Cache::add(DiagnosticsController::CLAIM_KEY, true, $limit);
        } catch (Throwable) {
            $claimed = null;
        }

        if ($claimed === false) {
            $this->error('A diagnosis or troubleshoot is already running.');

            return self::FAILURE;
        }

        try {
            $report = $troubleshooter->run($offered, Report::SOURCE_CLI);
        } finally {
            if ($claimed) {
                Cache::forget(DiagnosticsController::CLAIM_KEY);
            }
        }

        $this->line(MarkdownReport::render($report));

        try {
            $saved = ReportStore::save($report);
            $this->info("Saved as report #{$saved->id} (storage/app/private/{$saved->path}).");
        } catch (Throwable $e) {
            $this->warn("Not saved: {$e->getMessage()}");
        }

        return $report->count(Severity::Problem) > 0 ? self::FAILURE : self::SUCCESS;
    }
}
