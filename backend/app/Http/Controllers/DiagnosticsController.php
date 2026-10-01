<?php

namespace App\Http\Controllers;

use App\Models\DiagnosticReport;
use App\Services\Diagnostics\Diagnoser;
use App\Services\Diagnostics\Report;
use App\Services\Diagnostics\ReportStore;
use App\Services\Diagnostics\Troubleshooter;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Storage;
use Symfony\Component\HttpFoundation\StreamedResponse;

/**
 * The Stats page's Diagnose and Troubleshoot buttons, and the reports they write.
 *
 * **Read on open and after a run, never polled** (Facts' and Profile's rule):
 * a diagnosis is a press, and it shells out to PowerShell and resolves every
 * calendar's host — the cost is fine once, and would not be every few seconds.
 *
 * **A run is synchronous, in this request.** It is free and deterministic, and
 * the page redraws from the answer; queueing it would put the queue worker's
 * own diagnosis behind the queue worker.
 */
class DiagnosticsController extends Controller
{
    /** Claimed for the length of a run, so a double press runs once. */
    public const CLAIM_KEY = 'diagnostics.running';

    /** GET /api/diagnostics — the newest report, whatever its kind, and the list. */
    public function index(): JsonResponse
    {
        return response()->json($this->state());
    }

    /** POST /api/diagnostics/run — run every check, store the report, answer as `index` does. */
    public function run(Diagnoser $diagnoser): JsonResponse
    {
        $limit = (int) config('diagnostics.time_limit');

        // Herd's 30s is wall clock on Windows (see *Platform traps*), and a run
        // starts a PowerShell and resolves every calendar's host.
        set_time_limit($limit);

        if (! Cache::add(self::CLAIM_KEY, true, $limit)) {
            return $this->busy();
        }

        try {
            ReportStore::save($diagnoser->run(Report::SOURCE_UI));
        } finally {
            Cache::forget(self::CLAIM_KEY);
        }

        return response()->json($this->state(), 201);
    }

    /**
     * POST /api/diagnostics/troubleshoot — `{ report }`: apply the soft fixes
     * that report offers, then check again, and answer as `index` does.
     *
     * **The report id is what makes the confirm dialog binding.** The fixes are
     * re-derived from that stored report — the one the dialog was drawn from —
     * so the page cannot name a fix of its own, and `Troubleshooter` runs only
     * those the fresh checks still ask for.
     *
     * **In this request, never on the worker**: a worker cannot restart itself,
     * and it has no desktop. So the limit is raised well past Herd's 30s wall
     * clock — two check passes, a PowerShell per task, and a bounded wait for
     * each restarted task's heartbeat. It shares Diagnose's claim, so a press
     * of either while the other runs is refused.
     */
    public function troubleshoot(Request $request, Troubleshooter $troubleshooter): JsonResponse
    {
        $data = $request->validate([
            'report' => ['required', 'integer', 'exists:diagnostic_reports,id'],
        ]);

        $limit = (int) config('diagnostics.troubleshoot_time_limit');
        set_time_limit($limit);

        $confirmed = $troubleshooter->offered(DiagnosticReport::findOrFail($data['report'])->report());

        if ($confirmed === []) {
            return response()->json(['message' => 'That report offers no fix to apply. Diagnose again to see what is wrong now.'], 422);
        }

        if (! Cache::add(self::CLAIM_KEY, true, $limit)) {
            return $this->busy();
        }

        try {
            ReportStore::save($troubleshooter->run($confirmed, Report::SOURCE_UI));
        } finally {
            Cache::forget(self::CLAIM_KEY);
        }

        return response()->json($this->state(), 201);
    }

    private function busy(): JsonResponse
    {
        return response()->json(['message' => 'A diagnosis or troubleshoot is already running. Its report will be on the page when it finishes.'], 409);
    }

    /**
     * GET /api/diagnostics/{report}/file — signed; the `.md`, as a download.
     *
     * Written once and never edited, so it is `immutable` with no version in
     * the URL.
     */
    public function file(DiagnosticReport $report): StreamedResponse
    {
        abort_if(! $report->path || ! Storage::exists($report->path), 404);

        $stamp = $report->ran_at->setTimezone((string) config('agent.timezone', 'UTC'))->format('Y-m-d-Hi');

        return Storage::download($report->path, "projectmc-{$report->kind}-{$stamp}.md", [
            'Content-Type' => 'text/markdown; charset=UTF-8',
            'Cache-Control' => 'private, max-age=31536000, immutable',
        ]);
    }

    /**
     * `latest` is null on a checkout that has never diagnosed — "not yet run",
     * never an empty report, which would read as a clean bill of health.
     *
     * @return array<string, mixed>
     */
    private function state(): array
    {
        $reports = DiagnosticReport::query()
            ->orderByDesc('ran_at')
            ->orderByDesc('id')
            ->limit((int) config('diagnostics.retention'))
            ->get();

        return [
            'latest' => $reports->first()?->payload(),
            'reports' => $reports->map(fn (DiagnosticReport $r) => $r->summary())->values()->all(),
            'groups' => collect(Diagnoser::groups())
                ->map(fn (string $title, string $key) => ['key' => $key, 'title' => $title])
                ->values()
                ->all(),
        ];
    }
}
