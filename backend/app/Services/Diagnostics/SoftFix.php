<?php

namespace App\Services\Diagnostics;

/**
 * The closed set of fixes a finding may offer — the whole of Troubleshoot's
 * authority, `open_on_this_machine`'s rule.
 *
 * The keys are stored inside reports, so **the set is append-only**: renaming
 * one would leave old reports naming a fix that no longer exists. Each has one
 * class in `Fixes\` that runs it, listed in run order by `Troubleshooter::FIXES`
 * (a test holds the two to one-for-one).
 *
 * What is deliberately not here — registering the Windows tasks, any `.env`
 * edit, `migrate`, restarting Herd, starting Expo, re-pasting a calendar
 * address — is reported as a *manual* sentence with the command instead.
 */
enum SoftFix: string
{
    case RestartQueueWorker = 'restart_queue_worker';
    case StartSchedulerTask = 'start_scheduler_task';
    case ClearConfigCache = 'clear_config_cache';
    case RetryFailedJobs = 'retry_failed_jobs';
    case RefreshCalendarFeeds = 'refresh_calendar_feeds';
    case ReleaseStuckRuns = 'release_stuck_runs';
    case CheckpointWal = 'checkpoint_wal';
    case PruneOrphanSnapshots = 'prune_orphan_snapshots';
    case ClearStaleClaims = 'clear_stale_claims';

    /** The sentence the confirm dialog and the report show. */
    public function label(): string
    {
        return match ($this) {
            self::RestartQueueWorker => 'Restart the queue worker task.',
            self::StartSchedulerTask => 'Start the scheduler task.',
            self::ClearConfigCache => 'Clear the cached configuration, routes and events.',
            self::RetryFailedJobs => 'Retry every failed job.',
            self::RefreshCalendarFeeds => 'Re-read the failing calendars on the next look.',
            self::ReleaseStuckRuns => 'Fail the runs that can no longer finish, unlocking their threads.',
            self::CheckpointWal => 'Checkpoint the database\'s write-ahead log.',
            self::PruneOrphanSnapshots => 'Delete camera-frame files that no row points at.',
            self::ClearStaleClaims => 'Remove expired cache rows and abandoned claims.',
        };
    }
}
