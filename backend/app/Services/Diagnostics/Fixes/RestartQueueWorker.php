<?php

namespace App\Services\Diagnostics\Fixes;

use App\Jobs\RecordQueueHeartbeat;
use App\Services\Diagnostics\SoftFix;
use App\Services\System\Heartbeat;
use Carbon\CarbonImmutable;

/**
 * Stop and start the queue worker's task — what CLAUDE.md says to do after a
 * backend change, and what brings back a worker that died.
 *
 * Stopping first matters: the task is `IgnoreNew`, so starting it while a stuck
 * worker is still alive does nothing at all. A job the old worker was in the
 * middle of dies with it, which is the documented cost of the manual restart
 * too.
 *
 * A heartbeat job is queued straight after, so the new worker's first job is
 * the proof — rather than waiting up to a minute for the scheduler's.
 */
class RestartQueueWorker extends TaskFix
{
    public static function fix(): SoftFix
    {
        return SoftFix::RestartQueueWorker;
    }

    protected function task(): string
    {
        return (string) config('diagnostics.scheduler.tasks.worker');
    }

    protected function heartbeat(): string
    {
        return Heartbeat::QUEUE;
    }

    public function run(): string
    {
        $name = self::quoted($this->task());
        $since = CarbonImmutable::now();

        $this->powershell("Stop-ScheduledTask -TaskName {$name}; Start-ScheduledTask -TaskName {$name}");

        RecordQueueHeartbeat::dispatch();

        $took = $this->awaitBeat($since);

        return $took === null
            ? 'Restarted the task, but the worker had not run a job by the end of the wait; the checks below say whether it came back.'
            : "Restarted the task; the worker ran its first job within {$took}s.";
    }
}
