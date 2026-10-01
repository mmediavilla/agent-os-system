<?php

namespace App\Services\Diagnostics\Fixes;

use App\Services\System\Heartbeat;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\Process;
use RuntimeException;

/**
 * A fix that asks Task Scheduler to start one of the two tasks
 * `register-runtime-tasks.ps1` created — never to create, enable or change one,
 * which needs an elevated shell and is the owner's to run.
 *
 * **Then it waits for proof.** Starting a task is not the same as the thing
 * running, and the report written straight after is judged on the heartbeats;
 * without the wait, a worker restarted a second ago would still read "down" on
 * the very report that restarted it. The wait is bounded
 * (`diagnostics.fixes.wait_seconds`) and ends as soon as the heartbeat moves.
 */
abstract class TaskFix extends Fix
{
    /** The task's name, read from `diagnostics.scheduler.tasks` so there is one copy. */
    abstract protected function task(): string;

    /** The heartbeat that proves the task's work is running again. */
    abstract protected function heartbeat(): string;

    public function unavailable(): ?string
    {
        return $this->windows() ? null : 'Not Windows, so there is no scheduled task to start.';
    }

    /** Overridable, so a test on Linux CI can stand in for Windows. */
    protected function windows(): bool
    {
        return PHP_OS_FAMILY === 'Windows';
    }

    /**
     * @param  string  $script  PowerShell, run with `-ErrorAction Stop` semantics so a refusal fails the fix
     */
    protected function powershell(string $script): void
    {
        $result = Process::timeout((int) config('diagnostics.scheduler.probe_timeout', 15))
            ->run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', '$ErrorActionPreference = "Stop"; '.$script]);

        if (! $result->successful()) {
            $error = trim($result->errorOutput()) ?: trim($result->output());

            // The first line is Task Scheduler's sentence; the rest is PowerShell's position report.
            throw new RuntimeException('Task Scheduler refused: '.(strtok($error, "\r\n") ?: 'exit code '.$result->exitCode()));
        }
    }

    /**
     * Wait for the heartbeat to move past `$since`, and say how long it took.
     *
     * @return int|null seconds until it moved, or null if it did not within the wait
     */
    protected function awaitBeat(CarbonImmutable $since): ?int
    {
        $wait = (int) config('diagnostics.fixes.wait_seconds', 15);
        $started = microtime(true);
        // A stamp is ISO 8601 to the second, so compare on the second.
        $since = $since->startOfSecond();

        do {
            $last = Heartbeat::lastAt($this->heartbeat());

            if ($last !== null && $last->greaterThanOrEqualTo($since)) {
                return (int) round(microtime(true) - $started);
            }

            if (microtime(true) - $started >= $wait) {
                return null;
            }

            usleep(500_000);
        } while (true);
    }

    protected static function quoted(string $name): string
    {
        return '"'.str_replace('"', '`"', $name).'"';
    }
}
