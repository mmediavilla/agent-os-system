<?php

namespace App\Models;

use App\Models\Concerns\BelongsToOwner;
use App\Services\Diagnostics\Finding;
use App\Services\Diagnostics\FixOutcome;
use App\Services\Diagnostics\Report;
use App\Services\Diagnostics\ReportStore;
use App\Services\Diagnostics\SoftFix;
use App\Services\Diagnostics\Troubleshooter;
use App\Support\SignedUrl;
use Illuminate\Database\Eloquent\Model;

/**
 * One stored diagnosis or troubleshoot: its findings, what its fixes did, its
 * markdown, and the `.md` on disk.
 *
 * Written once by {@see ReportStore} and never edited, which is what lets its
 * file be served `immutable` with no version in the URL — a camera frame's
 * argument, not an equipment photo's.
 */
class DiagnosticReport extends Model
{
    use BelongsToOwner;

    protected $fillable = [
        'user_id',
        'kind',
        'source',
        'ran_at',
        'problems',
        'warnings',
        'passed',
        'findings',
        'outcomes',
        'markdown',
    ];

    protected $casts = [
        'ran_at' => 'immutable_datetime',
        'problems' => 'integer',
        'warnings' => 'integer',
        'passed' => 'integer',
        'findings' => 'array',
        'outcomes' => 'array',
        'bytes' => 'integer',
    ];

    protected static function booted(): void
    {
        // Through the model, so pruning takes each file with its row — a
        // database cascade fires no events (`Snapshot`'s precedent).
        static::deleting(function (DiagnosticReport $report): void {
            ReportStore::discard($report);
        });
    }

    /** Back to the structure it was rendered from. */
    public function report(): Report
    {
        return new Report(
            kind: $this->kind,
            source: $this->source,
            ranAt: $this->ran_at,
            findings: array_map(fn (array $f) => Finding::fromArray($f), $this->findings ?? []),
            outcomes: array_values(array_filter(array_map(fn (array $o) => FixOutcome::fromArray($o), $this->outcomes ?? []))),
        );
    }

    /**
     * The row as the list of past reports reads it — no findings.
     *
     * @return array<string, mixed>
     */
    public function summary(): array
    {
        $report = $this->report();
        $outcomes = $report->outcomes;

        return [
            'id' => $this->id,
            'kind' => $this->kind,
            'source' => $this->source,
            'ran_at' => $this->ran_at->toIso8601String(),
            'verdict' => $report->verdict(),
            'counts' => [
                'problems' => $this->problems,
                'warnings' => $this->warnings,
                'passed' => $this->passed,
                'total' => $this->problems + $this->warnings + $this->passed,
            ],
            // Null on a diagnosis, which runs nothing.
            'fix_counts' => $this->kind !== Report::KIND_TROUBLESHOOT ? null : [
                'done' => count(array_filter($outcomes, fn (FixOutcome $o) => $o->status === FixOutcome::DONE)),
                'failed' => count(array_filter($outcomes, fn (FixOutcome $o) => $o->status === FixOutcome::FAILED)),
                'skipped' => count(array_filter($outcomes, fn (FixOutcome $o) => $o->status === FixOutcome::SKIPPED)),
            ],
            'file_url' => $this->path === null ? null : SignedUrl::file('diagnostics.file', ['report' => $this->id]),
            'bytes' => $this->bytes,
        ];
    }

    /**
     * The row as the page draws it: the summary, every finding in order, what
     * Troubleshoot did, and **the fixes it would apply now** — in run order,
     * which is what the confirm dialog lists, so the page keeps no copy of the
     * order or of which fixes can run on this machine.
     *
     * @return array<string, mixed>
     */
    public function payload(): array
    {
        $report = $this->report();

        return $this->summary() + [
            'findings' => array_map(fn (Finding $f) => $f->toArray(), $report->findings),
            'outcomes' => array_map(fn (FixOutcome $o) => $o->toArray(), $report->outcomes),
            'fixes' => array_map(
                fn (SoftFix $fix) => ['key' => $fix->value, 'label' => $fix->label()],
                app(Troubleshooter::class)->offered($report),
            ),
        ];
    }
}
