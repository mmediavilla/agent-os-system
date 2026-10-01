<?php

namespace App\Services\Diagnostics\Fixes;

use App\Services\Diagnostics\SoftFix;
use App\Services\System\Heartbeat;
use Carbon\CarbonImmutable;

/**
 * Start the scheduler's task once, now, rather than waiting for Windows to.
 *
 * Offered only when the tick has stopped but the task is registered — a missing
 * or disabled task is a *Needs you* line, because registering or enabling one
 * needs an elevated shell. The task's run is one `schedule:run`, which stamps
 * the scheduler's heartbeat inline, so the heartbeat moving is the proof.
 */
class StartSchedulerTask extends TaskFix
{
    public static function fix(): SoftFix
    {
        return SoftFix::StartSchedulerTask;
    }

    protected function task(): string
    {
        return (string) config('diagnostics.scheduler.tasks.scheduler');
    }

    protected function heartbeat(): string
    {
        return Heartbeat::SCHEDULER;
    }

    public function run(): string
    {
        $since = CarbonImmutable::now();

        $this->powershell('Start-ScheduledTask -TaskName '.self::quoted($this->task()));

        $took = $this->awaitBeat($since);

        return $took === null
            ? 'Started the task, but the scheduler had not ticked by the end of the wait; the checks below say whether it did.'
            : "Started the task; the scheduler ticked within {$took}s.";
    }
}
