<?php

namespace Tests\Feature\Diagnostics;

use App\Http\Controllers\DiagnosticsController;
use App\Models\AgentRun;
use App\Models\CalendarFeed;
use App\Models\Conversation;
use App\Models\DiagnosticReport;
use App\Models\Snapshot;
use App\Services\Calendar\CalendarService;
use App\Services\Diagnostics\Checks\ConfigChecks;
use App\Services\Diagnostics\Fixes\CheckpointWal;
use App\Services\Diagnostics\Fixes\ClearConfigCache;
use App\Services\Diagnostics\Fixes\ClearStaleClaims;
use App\Services\Diagnostics\Fixes\PruneOrphanSnapshots;
use App\Services\Diagnostics\Fixes\RefreshCalendarFeeds;
use App\Services\Diagnostics\Fixes\ReleaseStuckRuns;
use App\Services\Diagnostics\Fixes\RestartQueueWorker;
use App\Services\Diagnostics\Fixes\RetryFailedJobs;
use App\Services\Diagnostics\Fixes\StartSchedulerTask;
use App\Services\Diagnostics\SoftFix;
use App\Services\Diagnostics\Troubleshooter;
use App\Services\System\Heartbeat;
use Illuminate\Database\Migrations\Migrator;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Process;
use Illuminate\Support\Facades\Storage;
use PHPUnit\Framework\Attributes\Test;
use RuntimeException;
use Tests\Feature\Calendar\CalendarTest;
use Tests\TestCase;

/**
 * Troubleshoot (18.2): what each soft fix does, and the rules around running
 * them — only what the dialog listed, only what is still needed, every outcome
 * on the report, and the report the state *after*.
 *
 * Nothing here starts a PowerShell, restarts a real task or clears the real
 * checkout's caches: Process is faked, and so is Artisan wherever a fix would
 * touch `bootstrap/cache`.
 */
class TroubleshootTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        Storage::fake();
        Http::fake(['*' => Http::response(CalendarTest::dentist())]);
        Process::fake();
        config(['diagnostics.fixes.wait_seconds' => 0, 'diagnostics.rate_limit' => 100]);

        // The checkout's own bootstrap/cache must neither be judged nor cleared
        // from the suite: Herd would load whatever it left there.
        $this->app->bind(ConfigChecks::class, fn () => new class(app(Migrator::class)) extends ConfigChecks
        {
            protected function cachedConfigPath(): string
            {
                return storage_path('framework/testing/no-such-config.php');
            }
        });
        $this->app->bind(ClearConfigCache::class, fn () => new class extends ClearConfigCache
        {
            public function run(): string
            {
                throw new RuntimeException('The suite may not clear the real config cache.');
            }
        });
    }

    private function stuckRun(): AgentRun
    {
        $conversation = Conversation::create(['title' => 'Stuck']);
        $run = AgentRun::create(['conversation_id' => $conversation->id, 'trigger' => 'message', 'status' => AgentRun::QUEUED]);
        $run->forceFill(['created_at' => now()->subMinutes(30)])->save();

        return $run;
    }

    private function failedJob(): void
    {
        DB::table('failed_jobs')->insert([
            'uuid' => 'x-'.uniqid(), 'connection' => 'database', 'queue' => 'default',
            'payload' => '{}', 'exception' => 'boom', 'failed_at' => now(),
        ]);
    }

    private function oldFile(string $path, int $ageSeconds = 600): void
    {
        Storage::put($path, 'jpeg');
        touch(Storage::path($path), time() - $ageSeconds);
    }

    /** A worker restart that believes it is on Windows, so Linux CI exercises it too. */
    private function workerOnWindows(): void
    {
        $this->app->bind(RestartQueueWorker::class, fn () => new class extends RestartQueueWorker
        {
            protected function windows(): bool
            {
                return true;
            }
        });
    }

    // ── The closed set ───────────────────────────────────────────────────────

    #[Test]
    public function every_soft_fix_has_exactly_one_class_and_a_place_in_the_run_order(): void
    {
        $fixes = array_map(fn (string $class) => $class::fix(), Troubleshooter::FIXES);

        $this->assertCount(count(SoftFix::cases()), $fixes);
        $this->assertEqualsCanonicalizing(SoftFix::cases(), $fixes);
        $this->assertSame(count($fixes), count(array_unique(array_map(fn (SoftFix $f) => $f->value, $fixes))));

        // The two orderings that matter: stuck runs are released before the
        // worker comes back, and the caches clear before anything reads them.
        $at = array_flip(array_map(fn (SoftFix $f) => $f->value, $fixes));
        $this->assertLessThan($at['restart_queue_worker'], $at['release_stuck_runs']);
        $this->assertSame(0, $at['clear_config_cache']);
    }

    // ── The endpoint ─────────────────────────────────────────────────────────

    #[Test]
    public function the_page_is_told_which_fixes_the_report_offers_in_the_order_they_run(): void
    {
        $this->failedJob();
        $this->stuckRun();

        $this->postJson('/api/diagnostics/run')
            ->assertCreated()
            ->assertJsonPath('latest.fixes', [
                ['key' => 'release_stuck_runs', 'label' => SoftFix::ReleaseStuckRuns->label()],
                ['key' => 'retry_failed_jobs', 'label' => SoftFix::RetryFailedJobs->label()],
            ])
            ->assertJsonPath('latest.outcomes', [])
            ->assertJsonPath('latest.fix_counts', null);
    }

    #[Test]
    public function troubleshoot_applies_the_confirmed_fixes_and_reports_the_state_after_them(): void
    {
        $run = $this->stuckRun();
        $diagnosis = $this->postJson('/api/diagnostics/run')->json('latest.id');

        $response = $this->postJson('/api/diagnostics/troubleshoot', ['report' => $diagnosis])->assertCreated();

        $response
            ->assertJsonPath('latest.kind', 'troubleshoot')
            ->assertJsonPath('latest.source', 'ui')
            ->assertJsonPath('latest.outcomes.0.key', 'release_stuck_runs')
            ->assertJsonPath('latest.outcomes.0.status', 'done')
            ->assertJsonPath('latest.fix_counts', ['done' => 1, 'failed' => 0, 'skipped' => 0])
            // Nothing left for a second press to do.
            ->assertJsonPath('latest.fixes', [])
            ->assertJsonCount(2, 'reports');

        // A full diagnosis of the state after, not only a list of what ran.
        $after = collect($response->json('latest.findings'))->keyBy('key');
        $this->assertSame('ok', $after['queue.stuck_runs']['severity']);
        $this->assertSame($response->json('latest.counts.total'), $after->count());

        $this->assertSame(AgentRun::FAILED, $run->refresh()->status);
        $this->assertSame(ReleaseStuckRuns::QUEUED_ERROR, $run->error);
        $this->assertNotNull($run->finished_at);
        $this->assertFalse(Cache::has(DiagnosticsController::CLAIM_KEY), 'The claim outlived the troubleshoot.');

        $markdown = DiagnosticReport::latest('id')->first()->markdown;
        $this->assertStringContainsString('# ProjectMC — Troubleshoot', $markdown);
        $this->assertStringContainsString('## What Troubleshoot did', $markdown);
        $this->assertStringContainsString('**Done** · '.SoftFix::ReleaseStuckRuns->label(), $markdown);
    }

    #[Test]
    public function a_confirmed_fix_no_longer_needed_is_skipped_and_one_newly_needed_is_not_run(): void
    {
        $run = $this->stuckRun();
        $diagnosis = $this->postJson('/api/diagnostics/run')->json('latest.id');

        // Between the dialog and the press: the run went away on its own, and an
        // orphaned frame appeared that the dialog never listed.
        $run->delete();
        $this->oldFile('snapshots/9/orphan.jpg');

        $response = $this->postJson('/api/diagnostics/troubleshoot', ['report' => $diagnosis])->assertCreated();

        $response
            ->assertJsonCount(1, 'latest.outcomes')
            ->assertJsonPath('latest.outcomes.0.key', 'release_stuck_runs')
            ->assertJsonPath('latest.outcomes.0.status', 'skipped')
            // The owner was never shown it, so it waits for the next press.
            ->assertJsonPath('latest.fixes.0.key', 'prune_orphan_snapshots');

        Storage::assertExists('snapshots/9/orphan.jpg');
    }

    #[Test]
    public function one_failing_fix_does_not_stop_the_next(): void
    {
        $this->stuckRun();
        $this->failedJob();
        $this->app->bind(RetryFailedJobs::class, fn () => new class extends RetryFailedJobs
        {
            public function run(): string
            {
                throw new RuntimeException('the queue is on fire');
            }
        });

        $diagnosis = $this->postJson('/api/diagnostics/run')->json('latest.id');

        $this->postJson('/api/diagnostics/troubleshoot', ['report' => $diagnosis])
            ->assertCreated()
            ->assertJsonPath('latest.outcomes.0.key', 'release_stuck_runs')
            ->assertJsonPath('latest.outcomes.0.status', 'done')
            ->assertJsonPath('latest.outcomes.1.key', 'retry_failed_jobs')
            ->assertJsonPath('latest.outcomes.1.status', 'failed')
            ->assertJsonPath('latest.outcomes.1.detail', 'the queue is on fire')
            ->assertJsonPath('latest.fix_counts', ['done' => 1, 'failed' => 1, 'skipped' => 0]);
    }

    #[Test]
    public function troubleshoot_refuses_with_a_sentence_and_writes_nothing(): void
    {
        $this->postJson('/api/diagnostics/troubleshoot', [])->assertUnprocessable()->assertJsonValidationErrors('report');
        $this->postJson('/api/diagnostics/troubleshoot', ['report' => 999])->assertUnprocessable();

        // A report with nothing a soft fix can do.
        $clean = $this->postJson('/api/diagnostics/run')->json('latest.id');
        $this->postJson('/api/diagnostics/troubleshoot', ['report' => $clean])
            ->assertUnprocessable()
            ->assertJsonPath('message', fn (string $m) => str_contains($m, 'offers no fix'));

        // Diagnose's claim is Troubleshoot's too.
        $this->stuckRun();
        $offering = $this->postJson('/api/diagnostics/run')->json('latest.id');
        Cache::add(DiagnosticsController::CLAIM_KEY, true, 60);

        $this->postJson('/api/diagnostics/troubleshoot', ['report' => $offering])
            ->assertStatus(409)
            ->assertJsonPath('message', fn (string $m) => str_contains($m, 'already running'));

        $this->assertSame(0, DiagnosticReport::where('kind', 'troubleshoot')->count());
        $this->assertSame(AgentRun::QUEUED, AgentRun::sole()->status);
    }

    // ── Each fix ─────────────────────────────────────────────────────────────

    #[Test]
    public function release_stuck_runs_frees_spoken_turns_and_leaves_fresh_work_alone(): void
    {
        $conversation = Conversation::create(['title' => 'Voice']);
        $voice = AgentRun::create([
            'conversation_id' => $conversation->id, 'trigger' => AgentRun::TRIGGER_VOICE,
            'status' => AgentRun::RUNNING, 'started_at' => now()->subMinutes(10),
        ]);
        $fresh = AgentRun::create(['conversation_id' => $conversation->id, 'trigger' => 'message', 'status' => AgentRun::QUEUED]);
        $stuck = $this->stuckRun();

        $detail = app(ReleaseStuckRuns::class)->run();

        $this->assertSame('Released one message no worker picked up and one spoken turn left running; their threads take messages again.', $detail);
        $this->assertSame(AgentRun::FAILED, $voice->refresh()->status);
        $this->assertSame(AgentRun::FAILED, $stuck->refresh()->status);
        $this->assertSame(AgentRun::QUEUED, $fresh->refresh()->status);
    }

    #[Test]
    public function prune_deletes_old_orphan_files_and_never_a_row_or_a_young_file(): void
    {
        $conversation = Conversation::create(['title' => 'Frames']);
        $this->oldFile('snapshots/1/kept.jpg');
        Snapshot::create(['conversation_id' => $conversation->id, 'path' => 'snapshots/1/kept.jpg', 'media_type' => 'image/jpeg', 'bytes' => 4]);
        $this->oldFile('snapshots/1/orphan.jpg');
        // Written a moment ago: perhaps a frame whose row is being saved right now.
        $this->oldFile('snapshots/1/young.jpg', 5);

        $detail = app(PruneOrphanSnapshots::class)->run();

        $this->assertSame('Deleted one frame file that no row pointed at, freeing 4 B.', $detail);
        Storage::assertMissing('snapshots/1/orphan.jpg');
        Storage::assertExists('snapshots/1/kept.jpg');
        Storage::assertExists('snapshots/1/young.jpg');
        $this->assertSame(1, Snapshot::count());
    }

    #[Test]
    public function clear_stale_claims_removes_only_what_has_expired(): void
    {
        $this->assertNotNull(app(ClearStaleClaims::class)->unavailable(), 'The array store has no rows to clear.');

        config(['cache.default' => 'database']);
        $now = now()->getTimestamp();
        DB::table('cache')->insert([
            ['key' => 'old', 'value' => 's:1:"x";', 'expiration' => $now - 60],
            ['key' => 'live-claim', 'value' => 'b:1;', 'expiration' => $now + 600],
        ]);
        DB::table('cache_locks')->insert(['key' => 'old-lock', 'owner' => 'gone', 'expiration' => $now - 60]);

        $fix = app(ClearStaleClaims::class);
        $this->assertNull($fix->unavailable());
        $this->assertSame('Removed 1 expired cache row and 1 expired lock.', $fix->run());

        $this->assertSame(['live-claim'], DB::table('cache')->pluck('key')->all());
        $this->assertSame(0, DB::table('cache_locks')->count());
    }

    #[Test]
    public function clear_config_cache_clears_the_three_caches(): void
    {
        // Never the real checkout's bootstrap/cache — Herd would load the result.
        Artisan::shouldReceive('call')->once()->with('config:clear')->andReturn(0);
        Artisan::shouldReceive('call')->once()->with('route:clear')->andReturn(0);
        Artisan::shouldReceive('call')->once()->with('event:clear')->andReturn(0);

        $this->assertStringStartsWith('Cleared the cached configuration', (new ClearConfigCache)->run());
    }

    #[Test]
    public function retry_failed_jobs_puts_them_back_on_the_queue(): void
    {
        $this->failedJob();
        $this->failedJob();
        Artisan::shouldReceive('call')->once()->with('queue:retry', ['id' => ['all']])->andReturn(0);

        $this->assertSame('Put 2 failed jobs back on the queue.', app(RetryFailedJobs::class)->run());
    }

    #[Test]
    public function refresh_calendar_feeds_reads_the_failing_ones_again_rather_than_forgetting_them(): void
    {
        $failing = CalendarFeed::create(['url' => 'https://example.com/a.ics', 'name' => 'Home', 'color' => 'peacock']);
        Cache::put("calendar.feed.{$failing->id}.attempt", ['ok' => false, 'message' => 'The calendar did not answer.'], 60);
        Cache::put("calendar.feed.{$failing->id}.reading", ['fetched_at' => now()->subHour()->toIso8601String(), 'skipped' => 0, 'events' => []]);

        $this->assertSame('Read the failing calendar again, and it answered.', app(RefreshCalendarFeeds::class)->run());

        $state = app(CalendarService::class)->present($failing);
        $this->assertSame('ok', $state['status']);
        // A real read, not a forgotten failure: the reading is new.
        $this->assertTrue(now()->subMinute()->lt($state['fetched_at']));
        Http::assertSentCount(1);
    }

    #[Test]
    public function checkpoint_wal_says_what_it_did(): void
    {
        // A checkpoint cannot run inside a transaction, and the suite runs every
        // test in one — so step out of it for this call, as a request is.
        DB::commit();

        try {
            $this->assertStringStartsWith('Checkpointed ', app(CheckpointWal::class)->run());
        } finally {
            DB::beginTransaction();
        }
    }

    #[Test]
    public function restart_queue_worker_stops_then_starts_the_task_and_waits_for_its_first_job(): void
    {
        $this->workerOnWindows();

        // The queue is `sync` here, so the heartbeat job runs at once.
        $detail = app(RestartQueueWorker::class)->run();

        $this->assertSame('Restarted the task; the worker ran its first job within 0s.', $detail);
        $this->assertNotNull(Heartbeat::lastAt(Heartbeat::QUEUE));
        Process::assertRan(fn ($process) => str_contains(
            implode(' ', (array) $process->command),
            'Stop-ScheduledTask -TaskName "ProjectMC queue worker"; Start-ScheduledTask -TaskName "ProjectMC queue worker"',
        ));
    }

    #[Test]
    public function a_started_scheduler_that_does_not_tick_in_time_says_so(): void
    {
        $this->app->bind(StartSchedulerTask::class, fn () => new class extends StartSchedulerTask
        {
            protected function windows(): bool
            {
                return true;
            }
        });

        $this->assertStringContainsString('had not ticked by the end of the wait', app(StartSchedulerTask::class)->run());
        Process::assertRan(fn ($process) => str_contains(implode(' ', (array) $process->command), 'Start-ScheduledTask -TaskName "ProjectMC scheduler"'));
    }

    #[Test]
    public function task_scheduler_refusing_fails_the_fix_with_its_own_sentence(): void
    {
        Process::fake(['*' => Process::result(output: '', errorOutput: "Access is denied.\r\nAt line:1 char:1", exitCode: 1)]);
        $this->workerOnWindows();

        $this->expectExceptionMessage('Task Scheduler refused: Access is denied.');

        app(RestartQueueWorker::class)->run();
    }

    #[Test]
    public function task_fixes_are_unavailable_off_windows(): void
    {
        $this->app->bind(RestartQueueWorker::class, fn () => new class extends RestartQueueWorker
        {
            protected function windows(): bool
            {
                return false;
            }
        });

        $this->assertStringStartsWith('Not Windows', app(RestartQueueWorker::class)->unavailable());
    }

    // ── php artisan troubleshoot ─────────────────────────────────────────────

    #[Test]
    public function the_command_lists_asks_and_applies(): void
    {
        $run = $this->stuckRun();

        $this->assertSame(0, Artisan::call('troubleshoot', ['--dry-run' => true]));
        $this->assertStringContainsString(SoftFix::ReleaseStuckRuns->label(), Artisan::output());

        // No terminal to ask in, and no --force: nothing runs.
        $this->assertSame(0, Artisan::call('troubleshoot', ['--no-interaction' => true]));
        $this->assertStringContainsString('Nothing was run.', Artisan::output());
        $this->assertSame(AgentRun::QUEUED, $run->refresh()->status);
        $this->assertSame(0, DiagnosticReport::count());

        // `:memory:` is never in WAL, so a problem remains and it exits 1.
        $this->assertSame(1, Artisan::call('troubleshoot', ['--force' => true]));
        $this->assertStringContainsString('## What Troubleshoot did', Artisan::output());
        $this->assertSame(AgentRun::FAILED, $run->refresh()->status);

        $report = DiagnosticReport::sole();
        $this->assertSame(['troubleshoot', 'cli'], [$report->kind, $report->source]);
        $this->assertStringContainsString('from php artisan troubleshoot', $report->markdown);
    }

    #[Test]
    public function the_command_has_nothing_to_do_when_nothing_offers_a_fix(): void
    {
        $this->assertSame(0, Artisan::call('troubleshoot', ['--force' => true]));
        $this->assertStringContainsString('Nothing to fix', Artisan::output());
        $this->assertSame(0, DiagnosticReport::count());
    }
}
