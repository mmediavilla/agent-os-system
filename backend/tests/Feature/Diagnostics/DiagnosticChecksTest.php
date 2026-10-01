<?php

namespace Tests\Feature\Diagnostics;

use App\Models\AgentAction;
use App\Models\AgentRun;
use App\Models\Automation;
use App\Models\CalendarFeed;
use App\Models\Conversation;
use App\Models\Document;
use App\Models\Setting;
use App\Services\AssistantSettings;
use App\Services\Diagnostics\Checks\AgentStateChecks;
use App\Services\Diagnostics\Checks\AssistantChecks;
use App\Services\Diagnostics\Checks\CalendarChecks;
use App\Services\Diagnostics\Checks\ConfigChecks;
use App\Services\Diagnostics\Checks\DatabaseChecks;
use App\Services\Diagnostics\Checks\FrontendChecks;
use App\Services\Diagnostics\Checks\QueueChecks;
use App\Services\Diagnostics\Checks\SchedulerChecks;
use App\Services\Diagnostics\Checks\SignInChecks;
use App\Services\Diagnostics\Checks\StorageChecks;
use App\Services\Diagnostics\Diagnoser;
use App\Services\Diagnostics\Finding;
use App\Services\Diagnostics\Report;
use App\Services\Diagnostics\Severity;
use App\Services\Diagnostics\SoftFix;
use App\Services\System\Heartbeat;
use Illuminate\Database\Migrations\Migrator;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Process;
use Illuminate\Support\Facades\Storage;
use PHPUnit\Framework\Attributes\Test;
use RuntimeException;
use Tests\TestCase;

/**
 * What each check judges, from states set up on purpose. Every one is free: no
 * test here reaches a model, the network, DNS or Task Scheduler.
 */
class DiagnosticChecksTest extends TestCase
{
    use RefreshDatabase;

    /** What the fake web app answers; a later `Http::fake` would lose to the first. */
    private int $webStatus = 200;

    protected function setUp(): void
    {
        parent::setUp();

        Storage::fake();
        Http::fake(['*' => fn () => Http::response('', $this->webStatus)]);
        // Nothing may start a real PowerShell from the suite. An empty answer
        // reads as "Task Scheduler could not be asked".
        Process::fake();
        config(['services.anthropic.key' => 'test-key']);
    }

    // ── The report as a whole ────────────────────────────────────────────────

    #[Test]
    public function every_finding_keeps_the_contract_the_page_relies_on(): void
    {
        $report = app(Diagnoser::class)->run(Report::SOURCE_CLI);
        $keys = array_map(fn (Finding $f) => $f->key, $report->findings);

        $this->assertSame(count($keys), count(array_unique($keys)), 'Two findings share a key.');

        foreach ($report->findings as $finding) {
            // An `ok` carries its evidence: All checks is where the old cards'
            // numbers live now.
            if ($finding->severity === Severity::Ok) {
                $this->assertNotEmpty($finding->evidence, "{$finding->key} passed with nothing to show.");
            } else {
                $this->assertTrue(($finding->fix === null) !== ($finding->manual === null), "{$finding->key} must offer a soft fix or a manual step.");
            }

            $this->assertStringStartsWith($finding->group.'.', $finding->key);
            $this->assertArrayHasKey($finding->group, Diagnoser::groups());
        }
    }

    #[Test]
    public function a_group_that_throws_costs_its_own_lines_and_nothing_else(): void
    {
        $this->app->bind(StorageChecks::class, fn () => new class extends StorageChecks
        {
            public function run(): array
            {
                throw new RuntimeException('disk on fire');
            }
        });

        $findings = collect(app(Diagnoser::class)->run(Report::SOURCE_CLI)->findings)->keyBy('key');

        $this->assertSame(Severity::Problem, $findings['storage.unavailable']->severity);
        $this->assertStringContainsString('disk on fire', $findings['storage.unavailable']->evidence[0]);
        $this->assertTrue($findings->has('frontend.web'), 'The checks after the broken one still ran.');
    }

    // ── Database ─────────────────────────────────────────────────────────────

    #[Test]
    public function the_live_connection_is_what_the_database_checks_read(): void
    {
        $f = $this->findings(DatabaseChecks::class);

        $this->assertSame(Severity::Ok, $f['database.reachable']->severity);
        $this->assertSame(Severity::Ok, $f['database.busy_timeout']->severity);
        $this->assertSame(Severity::Ok, $f['database.transaction_mode']->severity);

        // `:memory:` cannot be in WAL, and the check says so rather than
        // trusting the config that asks for it.
        $this->assertSame(Severity::Problem, $f['database.journal_mode']->severity);
        $this->assertContains('journal_mode: memory', $f['database.journal_mode']->evidence);
    }

    // ── Queue and scheduler ──────────────────────────────────────────────────

    #[Test]
    public function a_worker_never_seen_needs_registering_and_a_dead_one_a_restart(): void
    {
        $never = $this->findings(QueueChecks::class)['queue.heartbeat'];
        $this->assertSame(Severity::Problem, $never->severity);
        $this->assertNull($never->fix);
        $this->assertStringContainsString('register-runtime-tasks.ps1', $never->manual);

        Cache::forever(Heartbeat::QUEUE, now()->subMinutes(10)->toIso8601String());
        $dead = $this->findings(QueueChecks::class)['queue.heartbeat'];
        $this->assertSame(SoftFix::RestartQueueWorker, $dead->fix);

        Heartbeat::beat(Heartbeat::QUEUE);
        $this->assertSame(Severity::Ok, $this->findings(QueueChecks::class)['queue.heartbeat']->severity);
    }

    #[Test]
    public function failed_jobs_and_runs_left_queued_are_offered_their_fixes(): void
    {
        DB::table('failed_jobs')->insert([
            'uuid' => 'x-1', 'connection' => 'database', 'queue' => 'default',
            'payload' => '{}', 'exception' => 'boom', 'failed_at' => now(),
        ]);

        $conversation = Conversation::create(['title' => 'Stuck']);
        AgentRun::create(['conversation_id' => $conversation->id, 'trigger' => 'message', 'status' => AgentRun::QUEUED])
            ->forceFill(['created_at' => now()->subMinutes(30)])->save();
        // Queued a moment ago: a live worker has not had time yet, so not stuck.
        AgentRun::create(['conversation_id' => $conversation->id, 'trigger' => 'message', 'status' => AgentRun::QUEUED]);

        $f = $this->findings(QueueChecks::class);

        $this->assertSame(SoftFix::RetryFailedJobs, $f['queue.failed_jobs']->fix);
        $this->assertSame(Severity::Problem, $f['queue.stuck_runs']->severity);
        $this->assertSame(SoftFix::ReleaseStuckRuns, $f['queue.stuck_runs']->fix);
        $this->assertContains('stuck: 1', $f['queue.stuck_runs']->evidence);
    }

    #[Test]
    public function task_scheduler_tells_never_registered_from_disabled(): void
    {
        Process::fake([
            '*' => Process::result(json_encode([['name' => 'ProjectMC scheduler', 'state' => 'Disabled']])),
        ]);

        $this->app->bind(SchedulerChecks::class, fn () => new class extends SchedulerChecks
        {
            protected function windows(): bool
            {
                return true;
            }
        });

        $f = $this->findings(SchedulerChecks::class);

        $this->assertSame(Severity::Problem, $f['scheduler.task_1']->severity);
        $this->assertStringContainsString('Enable-ScheduledTask', $f['scheduler.task_1']->manual);
        $this->assertContains('state: missing', $f['scheduler.task_2']->evidence);
        $this->assertStringContainsString('register-runtime-tasks.ps1', $f['scheduler.task_2']->manual);
    }

    #[Test]
    public function task_scheduler_output_is_read_as_a_list_either_way(): void
    {
        $this->assertSame(['ProjectMC scheduler' => 'Ready'], SchedulerChecks::parse('{"name":"ProjectMC scheduler","state":"Ready"}'));
        $this->assertSame([], SchedulerChecks::parse('[]'));
        $this->assertNull(SchedulerChecks::parse('Access is denied.'));
    }

    // ── Assistant and sign-in ────────────────────────────────────────────────

    #[Test]
    public function the_assistant_is_judged_on_what_is_set_never_by_calling_it(): void
    {
        config(['services.anthropic.key' => null, 'agent.voice.key' => 'k', 'agent.voice.agent_id' => null]);
        Setting::put(AssistantSettings::CHAT_MODEL, 'claude-retired-4');
        Setting::put('anthropic.enabled', false);

        $f = $this->findings(AssistantChecks::class);

        $this->assertSame(Severity::Problem, $f['assistant.key']->severity);
        // Off is a decision, not a fault.
        $this->assertSame(Severity::Ok, $f['assistant.switch']->severity);
        $this->assertSame(Severity::Warn, $f['assistant.voice']->severity);
        $this->assertSame(Severity::Warn, $f['assistant.settings']->severity);
        $this->assertStringContainsString('claude-retired-4', implode(' ', $f['assistant.settings']->evidence));
    }

    #[Test]
    public function sign_in_settings_are_named_and_never_quoted(): void
    {
        config(['services.google.client_id' => 'secret-client-id', 'services.google.client_secret' => null, 'auth.owner_email' => 'me@example.com']);

        $f = $this->findings(SignInChecks::class)['sign_in.settings'];

        $this->assertSame(Severity::Problem, $f->severity);
        $this->assertStringContainsString('GOOGLE_CLIENT_SECRET', $f->manual);
        $this->assertStringNotContainsString('secret-client-id', json_encode($f->toArray()));
        $this->assertStringNotContainsString('me@example.com', json_encode($f->toArray()));
    }

    // ── Calendars ────────────────────────────────────────────────────────────

    #[Test]
    public function a_calendar_failing_briefly_is_refreshed_and_one_failing_for_a_day_needs_you(): void
    {
        $blip = CalendarFeed::create(['url' => 'https://example.com/a.ics', 'name' => 'Home', 'color' => 'peacock']);
        $dead = CalendarFeed::create(['url' => 'https://example.com/b.ics', 'name' => 'Work', 'color' => 'tomato']);
        $off = CalendarFeed::create(['url' => 'https://example.com/c.ics', 'name' => 'Old', 'color' => 'sage', 'enabled' => false]);

        Cache::put("calendar.feed.{$blip->id}.attempt", ['ok' => false, 'message' => 'The calendar did not answer.']);
        Cache::put("calendar.feed.{$blip->id}.reading", ['fetched_at' => now()->subHour()->toIso8601String(), 'skipped' => 0, 'events' => []]);
        Cache::put("calendar.feed.{$dead->id}.attempt", ['ok' => false, 'message' => 'The address was not found.']);
        Cache::put("calendar.feed.{$dead->id}.reading", ['fetched_at' => now()->subDays(3)->toIso8601String(), 'skipped' => 0, 'events' => []]);

        $f = $this->findings(CalendarChecks::class);

        $this->assertSame(SoftFix::RefreshCalendarFeeds, $f["calendar.feed_{$blip->id}"]->fix);
        $this->assertSame(Severity::Problem, $f["calendar.feed_{$dead->id}"]->severity);
        $this->assertStringContainsString('paste', $f["calendar.feed_{$dead->id}"]->manual);
        $this->assertSame(Severity::Ok, $f["calendar.feed_{$off->id}"]->severity);

        // The address is a credential; nothing quotes it.
        $this->assertStringNotContainsString('example.com', json_encode(array_map(fn (Finding $x) => $x->toArray(), $f)));
    }

    #[Test]
    public function a_calendar_address_that_now_lands_inside_the_network_is_refused(): void
    {
        $this->fakeDns(['cal.example.com' => ['10.0.0.5']]);
        $feed = CalendarFeed::create(['url' => 'https://cal.example.com/x.ics', 'name' => 'Home', 'color' => 'peacock']);

        $f = $this->findings(CalendarChecks::class)["calendar.feed_{$feed->id}"];

        $this->assertSame(Severity::Problem, $f->severity);
        $this->assertStringContainsString('inside this computer', $f->detail);
    }

    // ── Conversations ────────────────────────────────────────────────────────

    #[Test]
    public function stuck_conversations_are_found(): void
    {
        $conversation = Conversation::create(['title' => 'Voice']);

        AgentRun::create([
            'conversation_id' => $conversation->id,
            'trigger' => AgentRun::TRIGGER_VOICE,
            'status' => AgentRun::RUNNING,
            'started_at' => now()->subMinutes(10),
        ]);

        AgentAction::create([
            'conversation_id' => $conversation->id,
            'tool_use_id' => 'toolu_old',
            'tool' => 'log_workout',
            'input' => [],
            'requires_confirmation' => true,
            'status' => AgentAction::PENDING,
        ])->forceFill(['created_at' => now()->subDays(2)])->save();

        Automation::create([
            'name' => 'Morning greeting', 'time' => '06:30', 'intent' => 'Say hello.',
            'context' => ['weather'], 'enabled' => true,
        ])->forceFill(['last_outcome' => Automation::FAILED, 'last_error' => 'Weather timed out.'])->save();

        $f = $this->findings(AgentStateChecks::class);

        $this->assertSame(SoftFix::ReleaseStuckRuns, $f['agent.voice_runs']->fix);
        // Whether a parked write happens is the owner's call, never a soft fix.
        $this->assertNull($f['agent.pending_actions']->fix);
        $this->assertNotNull($f['agent.pending_actions']->manual);
        $this->assertContains('Morning greeting: Weather timed out.', $f['agent.automations']->evidence);
    }

    // ── Configuration, storage, web app ─────────────────────────────────────

    #[Test]
    public function a_config_cache_older_than_env_is_a_problem_with_a_soft_fix(): void
    {
        $dir = sys_get_temp_dir().'/pmc-diag-'.uniqid();
        mkdir($dir);
        file_put_contents("{$dir}/config.php", '<?php return [];');
        file_put_contents("{$dir}/.env", 'APP_NAME=x');
        touch("{$dir}/config.php", time() - 3600);

        $this->app->bind(ConfigChecks::class, fn () => new class(app(Migrator::class), $dir) extends ConfigChecks
        {
            public function __construct(Migrator $migrator, private string $dir)
            {
                parent::__construct($migrator);
            }

            protected function cachedConfigPath(): string
            {
                return "{$this->dir}/config.php";
            }

            protected function envPath(): string
            {
                return "{$this->dir}/.env";
            }
        });

        $f = $this->findings(ConfigChecks::class);

        $this->assertSame(Severity::Problem, $f['config.cache']->severity);
        $this->assertSame(SoftFix::ClearConfigCache, $f['config.cache']->fix);
        $this->assertSame(Severity::Ok, $f['config.migrations']->severity);

        array_map('unlink', ["{$dir}/config.php", "{$dir}/.env"]);
        rmdir($dir);
    }

    #[Test]
    public function frame_files_no_row_points_at_are_offered_for_pruning(): void
    {
        Storage::put('snapshots/9/stray.jpg', 'x');

        $f = $this->findings(StorageChecks::class)['storage.snapshots'];

        $this->assertSame(SoftFix::PruneOrphanSnapshots, $f->fix);
        $this->assertContains('files with no row: 1', $f->evidence);
    }

    #[Test]
    public function filed_documents_are_counted_only_when_they_have_a_file(): void
    {
        // The old Stats storage card's line, kept as an `ok` finding's evidence.
        Document::create(['title' => 'Passport', 'kind' => 'passport'])
            ->forceFill(['file_path' => 'documents/a.pdf', 'size_bytes' => 2 * 1024 * 1024])->save();
        Document::create(['title' => 'Receipt', 'kind' => 'receipt']);

        $f = $this->findings(StorageChecks::class)['storage.documents'];

        $this->assertSame(Severity::Ok, $f->severity);
        $this->assertSame(['with a file: 1', 'on disk: 2.0 MB'], $f->evidence);
    }

    #[Test]
    public function a_502_from_the_web_app_is_expo_not_running(): void
    {
        $this->webStatus = 502;

        $f = $this->findings(FrontendChecks::class)['frontend.web'];

        $this->assertSame(Severity::Problem, $f->severity);
        $this->assertStringContainsString('npx expo start', $f->manual);
    }

    /**
     * @param  class-string  $class
     * @return array<string, Finding>
     */
    private function findings(string $class): array
    {
        return collect(app($class)->run())->keyBy('key')->all();
    }
}
