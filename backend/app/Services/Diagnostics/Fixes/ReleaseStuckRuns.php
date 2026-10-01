<?php

namespace App\Services\Diagnostics\Fixes;

use App\Agent\Streaming\EventLog;
use App\Agent\Streaming\RunDispatcher;
use App\Models\AgentRun;
use App\Services\Diagnostics\SoftFix;

/**
 * Fail the runs that can no longer finish, so their threads take messages
 * again: spoken turns whose request died, and messages queued so long ago that
 * no worker is coming for them.
 *
 * The same lines as the checks that found them — `VOICE_MAX_SECONDS` + 30s, and
 * `diagnostics.queue.stuck_minutes` — so what is released is what the report
 * listed. A queued run is ended through `RunDispatcher::finish()`, the row and
 * then the closing event, so a page still watching it stops; `RunAgentTurn`
 * skips any run that is no longer `queued`, so a worker that turns up later
 * cannot answer it into a thread that has moved on.
 *
 * Runs before the worker is restarted, for that reason: a message left an hour
 * is released, not answered an hour late.
 */
class ReleaseStuckRuns extends Fix
{
    public const QUEUED_ERROR = 'No worker picked this message up, so Troubleshoot released it to unlock the thread. Send it again.';

    public static function fix(): SoftFix
    {
        return SoftFix::ReleaseStuckRuns;
    }

    public function run(): string
    {
        $voice = RunDispatcher::releaseStrandedVoice();

        $queued = AgentRun::query()
            ->where('status', AgentRun::QUEUED)
            ->where('created_at', '<', now()->subMinutes((int) config('diagnostics.queue.stuck_minutes')))
            ->get();

        foreach ($queued as $run) {
            RunDispatcher::finish($run, new EventLog($run), AgentRun::FAILED, self::QUEUED_ERROR);
        }

        $parts = [];
        if ($queued->isNotEmpty()) {
            $parts[] = $queued->count() === 1 ? 'one message no worker picked up' : "{$queued->count()} messages no worker picked up";
        }
        if ($voice > 0) {
            $parts[] = $voice === 1 ? 'one spoken turn left running' : "{$voice} spoken turns left running";
        }

        return $parts === []
            ? 'Nothing was stuck by the time this ran.'
            : 'Released '.implode(' and ', $parts).'; their threads take messages again.';
    }
}
