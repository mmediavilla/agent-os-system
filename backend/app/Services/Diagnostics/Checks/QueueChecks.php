<?php

namespace App\Services\Diagnostics\Checks;

use App\Models\AgentRun;
use App\Services\Diagnostics\Finding;
use App\Services\Diagnostics\Format;
use App\Services\Diagnostics\SoftFix;
use App\Services\System\Health;
use App\Services\System\Heartbeat;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * The queue worker: alive, keeping up, and not leaving work behind.
 *
 * The heartbeat is `/api/health`'s own reading. The rest is what health never
 * looked at — failed jobs, and chat runs a dead worker left `queued`, which is
 * the symptom the owner actually sees ("nothing I send is answered").
 */
class QueueChecks extends Check
{
    private const REGISTER = 'From an elevated PowerShell in the project folder, run: powershell -ExecutionPolicy Bypass -File backend\scripts\register-runtime-tasks.ps1';

    public static function group(): string
    {
        return 'queue';
    }

    public static function title(): string
    {
        return 'Queue worker';
    }

    public function run(): array
    {
        $beat = Health::heartbeat(Heartbeat::QUEUE);

        return [
            $this->heartbeat($beat),
            $this->backlog($beat['state']),
            $this->failedJobs(),
            $this->stuckRuns(),
        ];
    }

    /**
     * @param  array{state: string, last_beat_at: string|null, age_seconds: int|null}  $beat
     */
    private function heartbeat(array $beat): Finding
    {
        $title = 'Queue worker heartbeat';

        return match ($beat['state']) {
            'up' => $this->ok('heartbeat', $title, 'The worker ran its heartbeat job recently.', ['last beat: '.Format::age((int) $beat['age_seconds']).' ago']),
            'down' => $this->problem(
                'heartbeat',
                $title,
                'The worker has not run a job in '.Format::age((int) $beat['age_seconds']).'. Chat messages sit at "queued" until it is back.',
                ['last beat: '.Format::age((int) $beat['age_seconds']).' ago', 'grace: '.config('hud.health.heartbeat_grace').'s'],
                fix: SoftFix::RestartQueueWorker,
            ),
            default => $this->problem(
                'heartbeat',
                $title,
                'No worker has ever run a job on this machine, which usually means the Windows tasks were never registered.',
                ['last beat: never'],
                manual: self::REGISTER,
            ),
        };
    }

    private function backlog(string $state): Finding
    {
        $pending = Health::backlog()['pending'];
        $title = 'Jobs waiting';

        if ($pending === null) {
            return $this->ok('backlog', $title, 'The queue is not one this can count.', ['queue: '.config('queue.default')]);
        }

        $evidence = ["pending: {$pending}"];

        if ($pending > (int) config('diagnostics.queue.backlog_warn')) {
            return $this->warn(
                'backlog',
                $title,
                $state === 'up'
                    ? 'Work is piling up behind a worker that is alive, which is a worker stuck on something.'
                    : 'Work is piling up with no worker to run it.',
                $evidence,
                fix: SoftFix::RestartQueueWorker,
            );
        }

        return $this->ok('backlog', $title, 'The queue is keeping up.', $evidence);
    }

    private function failedJobs(): Finding
    {
        $title = 'Failed jobs';
        $table = config('queue.failed.table', 'failed_jobs');

        if (! Schema::hasTable($table)) {
            return $this->ok('failed_jobs', $title, 'Failed jobs are not recorded on this checkout.', ["{$table}: missing"]);
        }

        $count = DB::table($table)->count();

        if ($count === 0) {
            return $this->ok('failed_jobs', $title, 'No job has failed.', ['failed: 0']);
        }

        $newest = DB::table($table)->orderByDesc('failed_at')->first(['failed_at']);

        return $this->warn(
            'failed_jobs',
            $title,
            $count === 1 ? 'One job failed and was not retried.' : "{$count} jobs failed and were not retried.",
            ["failed: {$count}", 'newest: '.($newest->failed_at ?? 'unknown')],
            fix: SoftFix::RetryFailedJobs,
        );
    }

    private function stuckRuns(): Finding
    {
        $minutes = (int) config('diagnostics.queue.stuck_minutes');
        $title = 'Chat runs waiting for the worker';

        $stuck = AgentRun::query()
            ->where('status', AgentRun::QUEUED)
            ->where('created_at', '<', now()->subMinutes($minutes))
            ->get(['id', 'conversation_id', 'created_at']);

        if ($stuck->isEmpty()) {
            return $this->ok('stuck_runs', $title, "No run has been queued for longer than {$minutes} minutes.", ['stuck: 0']);
        }

        $oldest = (int) now()->diffInSeconds($stuck->min('created_at'), true);

        return $this->problem(
            'stuck_runs',
            $title,
            $stuck->count() === 1
                ? 'One message has been waiting for a worker since '.Format::age($oldest).' ago, and its thread refuses anything new until it ends.'
                : "{$stuck->count()} messages have been waiting for a worker, the oldest for ".Format::age($oldest).', and each locks its thread.',
            ["stuck: {$stuck->count()}", 'threads: '.$stuck->pluck('conversation_id')->unique()->implode(', ')],
            fix: SoftFix::ReleaseStuckRuns,
        );
    }
}
