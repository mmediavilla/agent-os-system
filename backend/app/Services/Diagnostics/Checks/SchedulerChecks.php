<?php

namespace App\Services\Diagnostics\Checks;

use App\Services\Diagnostics\Finding;
use App\Services\Diagnostics\Format;
use App\Services\Diagnostics\SoftFix;
use App\Services\System\Health;
use App\Services\System\Heartbeat;
use Illuminate\Support\Facades\Process;
use Throwable;

/**
 * The scheduler's heartbeat, and the two Windows tasks behind it and the worker.
 *
 * The heartbeat alone reads `unknown` for two machines that need different
 * fixes: one where the tasks were never registered, and one where they were and
 * are disabled. Asking Task Scheduler is what tells them apart. It costs a
 * PowerShell start (~500ms), which is why this is a press and never a poll.
 */
class SchedulerChecks extends Check
{
    private const REGISTER = 'From an elevated PowerShell in the project folder, run: powershell -ExecutionPolicy Bypass -File backend\scripts\register-runtime-tasks.ps1';

    /** An array even for one task, which `ConvertTo-Json` would otherwise unwrap. */
    private const COMMAND = 'ConvertTo-Json -Compress -InputObject @(Get-ScheduledTask -TaskName "ProjectMC*" -ErrorAction SilentlyContinue '
        .'| ForEach-Object { [pscustomobject]@{ name = $_.TaskName; state = [string]$_.State } })';

    public static function group(): string
    {
        return 'scheduler';
    }

    public static function title(): string
    {
        return 'Scheduler';
    }

    public function run(): array
    {
        return [
            $this->heartbeat(Health::heartbeat(Heartbeat::SCHEDULER)),
            ...$this->tasks(),
        ];
    }

    /**
     * @param  array{state: string, last_beat_at: string|null, age_seconds: int|null}  $beat
     */
    private function heartbeat(array $beat): Finding
    {
        $title = 'Scheduler heartbeat';

        return match ($beat['state']) {
            'up' => $this->ok('heartbeat', $title, 'The scheduler ticked recently.', ['last tick: '.Format::age((int) $beat['age_seconds']).' ago']),
            'down' => $this->problem(
                'heartbeat',
                $title,
                'The scheduler has not ticked in '.Format::age((int) $beat['age_seconds']).', so the morning nudge, fact extraction and the worker\'s heartbeat have all stopped.',
                ['last tick: '.Format::age((int) $beat['age_seconds']).' ago'],
                fix: SoftFix::StartSchedulerTask,
            ),
            default => $this->problem(
                'heartbeat',
                $title,
                'The scheduler has never ticked on this machine, which usually means the Windows tasks were never registered.',
                ['last tick: never'],
                manual: self::REGISTER,
            ),
        };
    }

    /**
     * One finding per task the app expects.
     *
     * @return list<Finding>
     */
    private function tasks(): array
    {
        if (! $this->windows()) {
            return [$this->ok('tasks', 'Windows tasks', 'Not Windows, so there are no scheduled tasks to look at.', ['platform: '.PHP_OS_FAMILY])];
        }

        $found = $this->probe();

        if ($found === null) {
            return [$this->warn(
                'tasks',
                'Windows tasks',
                'Task Scheduler could not be asked, so whether the tasks exist is unknown.',
                [],
                manual: 'In PowerShell, run: Get-ScheduledTask -TaskName "ProjectMC*" | Select-Object TaskName, State',
            )];
        }

        $findings = [];

        foreach (array_values(config('diagnostics.scheduler.tasks')) as $i => $name) {
            $key = 'task_'.($i + 1);
            $state = $found[$name] ?? null;

            $findings[] = match (true) {
                $state === null => $this->problem($key, $name, 'This task is not registered, so nothing starts it.', ['state: missing'], manual: self::REGISTER),
                $state === 'Disabled' => $this->problem($key, $name, 'This task is registered but disabled, so Windows never starts it.', ['state: Disabled'], manual: "In PowerShell, run: Enable-ScheduledTask -TaskName \"{$name}\""),
                in_array($state, ['Ready', 'Running', 'Queued'], true) => $this->ok($key, $name, 'Registered and enabled.', ["state: {$state}"]),
                default => $this->warn($key, $name, 'Task Scheduler reports a state this app does not recognise.', ["state: {$state}"], manual: "In Task Scheduler, open \"{$name}\" and check its last run result."),
            };
        }

        return $findings;
    }

    protected function windows(): bool
    {
        return PHP_OS_FAMILY === 'Windows';
    }

    /**
     * @return array<string, string>|null task name → state, or null when Task Scheduler could not be asked
     */
    private function probe(): ?array
    {
        try {
            $result = Process::timeout((int) config('diagnostics.scheduler.probe_timeout', 15))
                ->run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', self::COMMAND]);
        } catch (Throwable) {
            return null;
        }

        return $result->successful() ? self::parse($result->output()) : null;
    }

    /**
     * @return array<string, string>|null
     */
    public static function parse(string $output): ?array
    {
        $rows = json_decode(trim($output), true);

        if (! is_array($rows)) {
            return null;
        }

        // One object rather than a list still arrives from an older PowerShell.
        if (isset($rows['name'])) {
            $rows = [$rows];
        }

        $tasks = [];

        foreach ($rows as $row) {
            if (is_array($row) && isset($row['name'], $row['state'])) {
                $tasks[(string) $row['name']] = (string) $row['state'];
            }
        }

        return $tasks;
    }
}
