<?php

namespace App\Services\Diagnostics;

use App\Models\DiagnosticReport;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;

/**
 * The one writer of a diagnostic report's row and its `.md` — `DocumentStore`'s
 * rule on a disk, so a row and its file cannot drift apart.
 *
 * The row is written first and the file second: a file with no row is an
 * orphan nothing lists, while a row with no file still draws on the page and
 * only loses its download.
 */
final class ReportStore
{
    public const DIRECTORY = 'diagnostics';

    public static function save(Report $report): DiagnosticReport
    {
        $markdown = MarkdownReport::render($report);

        $row = DiagnosticReport::create([
            'kind' => $report->kind,
            'source' => $report->source,
            'ran_at' => $report->ranAt,
            'problems' => $report->count(Severity::Problem),
            'warnings' => $report->count(Severity::Warn),
            'passed' => $report->count(Severity::Ok),
            'findings' => array_map(fn (Finding $f) => $f->toArray(), $report->findings),
            'outcomes' => $report->kind === Report::KIND_TROUBLESHOOT
                ? array_map(fn (FixOutcome $o) => $o->toArray(), $report->outcomes)
                : null,
            'markdown' => $markdown,
        ]);

        $path = self::DIRECTORY.'/'.Str::ulid().'.md';
        Storage::put($path, $markdown);

        $row->forceFill(['path' => $path, 'bytes' => strlen($markdown)])->save();

        self::prune();

        return $row;
    }

    /** Keep the newest `diagnostics.retention`; the rest go, files with them. */
    public static function prune(): void
    {
        $keep = DiagnosticReport::query()
            ->orderByDesc('ran_at')
            ->orderByDesc('id')
            ->limit((int) config('diagnostics.retention'))
            ->pluck('id');

        DiagnosticReport::query()
            ->whereNotIn('id', $keep)
            ->get()
            ->each(fn (DiagnosticReport $old) => $old->delete());
    }

    /** Called from the model's `deleting` hook. A missing file is the goal, not an error. */
    public static function discard(DiagnosticReport $report): void
    {
        if ($report->path && Storage::exists($report->path)) {
            Storage::delete($report->path);
        }
    }
}
