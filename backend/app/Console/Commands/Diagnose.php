<?php

namespace App\Console\Commands;

use App\Services\Diagnostics\Diagnoser;
use App\Services\Diagnostics\Finding;
use App\Services\Diagnostics\MarkdownReport;
use App\Services\Diagnostics\Report;
use App\Services\Diagnostics\ReportStore;
use App\Services\Diagnostics\Severity;
use Illuminate\Console\Command;
use Throwable;

/**
 * The Diagnose button, for when the HUD will not load.
 *
 * The same checks and the same report; the report is saved like one from the
 * page (source `cli`), so it is the one Stats shows next. A database too broken
 * to save into still gets its report printed — that is exactly the machine this
 * command exists for.
 *
 * Exits 1 when anything is a problem, so a script can ask.
 */
class Diagnose extends Command
{
    protected $signature = 'diagnose
        {--json : Print the findings as JSON instead of the report}
        {--no-save : Print only; write no row and no file}';

    protected $description = 'Run every diagnostic check and print the report (free — no model call)';

    public function handle(Diagnoser $diagnoser): int
    {
        $report = $diagnoser->run(Report::SOURCE_CLI);
        $saved = null;
        $error = null;

        if (! $this->option('no-save')) {
            try {
                $saved = ReportStore::save($report);
            } catch (Throwable $e) {
                $error = $e->getMessage();
            }
        }

        if ($this->option('json')) {
            $this->line((string) json_encode([
                'id' => $saved?->id,
                'verdict' => $report->verdict(),
                'findings' => array_map(fn (Finding $f) => $f->toArray(), $report->findings),
            ], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
        } else {
            $this->line(MarkdownReport::render($report));
        }

        if ($saved !== null) {
            $this->info("Saved as report #{$saved->id} (storage/app/private/{$saved->path}).");
        } elseif ($error !== null) {
            $this->warn("Not saved: {$error}");
        }

        return $report->count(Severity::Problem) > 0 ? self::FAILURE : self::SUCCESS;
    }
}
