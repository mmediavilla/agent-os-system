<?php

namespace App\Services\Diagnostics;

use App\Services\Diagnostics\Fixes\CheckpointWal;
use App\Services\Diagnostics\Fixes\ClearConfigCache;
use App\Services\Diagnostics\Fixes\ClearStaleClaims;
use App\Services\Diagnostics\Fixes\Fix;
use App\Services\Diagnostics\Fixes\PruneOrphanSnapshots;
use App\Services\Diagnostics\Fixes\RefreshCalendarFeeds;
use App\Services\Diagnostics\Fixes\ReleaseStuckRuns;
use App\Services\Diagnostics\Fixes\RestartQueueWorker;
use App\Services\Diagnostics\Fixes\RetryFailedJobs;
use App\Services\Diagnostics\Fixes\StartSchedulerTask;
use Illuminate\Contracts\Container\Container;
use Throwable;

/**
 * Troubleshoot: apply the soft fixes the owner confirmed, then check again.
 *
 * **What runs is what was confirmed *and* is still needed.** The confirmed
 * list comes from the report the dialog was drawn from, which may be half an
 * hour old, so a fresh check pass runs first and a confirmed fix it no longer
 * asks for is `skipped` — `OpenOnThisMachine`'s rule that a parked call is
 * checked against the live state. The reverse never happens: a fix the fresh
 * pass wants and the dialog did not list is not run, because nothing may run
 * that the owner was not shown. It is on the report that follows, for next
 * time.
 *
 * **The report is a full diagnosis of the state after the fixes**, with what
 * each fix did beside it. The page shows the newest report whatever its kind,
 * so a troubleshoot report holding only its outcomes would empty the findings
 * the owner was just looking at.
 *
 * **One fix failing never stops the next.** Every confirmed fix gets an
 * outcome, and every outcome is on the report.
 */
final class Troubleshooter
{
    /**
     * The closed set, in the order it runs — the whole of Troubleshoot's
     * authority. Caches first, so what follows reads fresh configuration; stuck
     * runs released before the worker comes back, so a message left an hour is
     * released rather than answered an hour late; the two tasks last, so a
     * restarted worker starts on the jobs just re-queued.
     *
     * @var list<class-string<Fix>>
     */
    public const FIXES = [
        ClearConfigCache::class,
        ClearStaleClaims::class,
        ReleaseStuckRuns::class,
        RetryFailedJobs::class,
        CheckpointWal::class,
        PruneOrphanSnapshots::class,
        RefreshCalendarFeeds::class,
        StartSchedulerTask::class,
        RestartQueueWorker::class,
    ];

    public function __construct(
        private readonly Container $container,
        private readonly Diagnoser $diagnoser,
    ) {}

    /**
     * The fixes a report offers that can run on this machine, in the order they
     * would run — what the confirm dialog lists.
     *
     * @return list<SoftFix>
     */
    public function offered(Report $report): array
    {
        $wanted = [];

        foreach ($report->attention() as $finding) {
            if ($finding->fix !== null) {
                $wanted[$finding->fix->value] = true;
            }
        }

        $offered = [];

        foreach (self::FIXES as $class) {
            $fix = $class::fix();

            if (isset($wanted[$fix->value]) && $this->make($class)->unavailable() === null) {
                $offered[] = $fix;
            }
        }

        return $offered;
    }

    /**
     * @param  list<SoftFix>  $confirmed  what the owner was shown and agreed to
     */
    public function run(array $confirmed, string $source): Report
    {
        $needed = array_flip(array_map(
            fn (SoftFix $fix) => $fix->value,
            $this->offered($this->diagnoser->run($source)),
        ));

        $outcomes = [];

        foreach (self::FIXES as $class) {
            $fix = $class::fix();

            if (! in_array($fix, $confirmed, true)) {
                continue;
            }

            $outcomes[] = isset($needed[$fix->value])
                ? $this->apply($this->make($class))
                : new FixOutcome($fix, FixOutcome::SKIPPED, 'The checks run just before found nothing for it to do.');
        }

        $after = $this->diagnoser->run($source, Report::KIND_TROUBLESHOOT);

        return new Report($after->kind, $after->source, $after->ranAt, $after->findings, $outcomes);
    }

    private function apply(Fix $fix): FixOutcome
    {
        $why = $fix->unavailable();

        if ($why !== null) {
            return new FixOutcome($fix::fix(), FixOutcome::SKIPPED, $why);
        }

        try {
            return new FixOutcome($fix::fix(), FixOutcome::DONE, $fix->run());
        } catch (Throwable $e) {
            report($e);

            return new FixOutcome($fix::fix(), FixOutcome::FAILED, $e->getMessage() !== '' ? $e->getMessage() : get_class($e));
        }
    }

    /** @param  class-string<Fix>  $class */
    private function make(string $class): Fix
    {
        return $this->container->make($class);
    }
}
