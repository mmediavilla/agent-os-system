<?php

namespace Tests\Feature\Fitness;

use App\Jobs\GenerateProactiveInsights;
use App\Models\Insight;
use App\Models\WorkoutSet;
use App\Services\ClaudeService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use RuntimeException;
use Tests\TestCase;

class ProactiveInsightsTest extends TestCase
{
    use RefreshDatabase;

    /** A session `$daysAgo` days back carrying one working set. */
    private function logSession(int $daysAgo): void
    {
        $workout = $this->makeWorkout(['started_at' => now()->subDays($daysAgo)->toDateTimeString()]);

        WorkoutSet::create([
            'workout_id' => $workout->id,
            'exercise_title' => 'Bench Press',
            'set_index' => 0,
            'set_type' => 'normal',
            'weight_kg' => 100,
            'reps' => 5,
        ]);
    }

    /** Claude is available but must not be asked. */
    private function expectNoModelCall(): void
    {
        $this->mock(ClaudeService::class)->shouldNotReceive('complete');
    }

    /** @param  int|string  $times  a Mockery cardinality */
    private function expectModelCall(string $text = 'Nine days off. Book Thursday.'): void
    {
        $this->mock(ClaudeService::class)
            ->shouldReceive('complete')
            ->once()
            ->andReturn([
                'text' => $text,
                'usage' => ['input_tokens' => 400, 'output_tokens' => 60,
                    'cache_read_input_tokens' => null, 'cache_creation_input_tokens' => null],
                'model' => 'claude-opus-5',
            ]);
    }

    private function nudge(array $triggers, int $daysAgo): Insight
    {
        $insight = Insight::create([
            'domain' => GenerateProactiveInsights::DOMAIN,
            'kind' => GenerateProactiveInsights::KIND,
            'title' => 'Earlier nudge',
            'response' => 'Said already.',
            'input_summary' => ['triggers' => $triggers],
        ]);

        $insight->forceFill(['created_at' => now()->subDays($daysAgo)])->save();

        return $insight;
    }

    // ── The expensive thing that must not happen ──────────────────────────────

    public function test_a_quiet_week_costs_nothing(): void
    {
        $this->logSession(1);
        $this->expectNoModelCall();

        GenerateProactiveInsights::dispatchSync();

        $this->assertSame(0, Insight::count());
    }

    public function test_an_empty_database_is_not_nudged(): void
    {
        // Nothing to observe is not the same as nothing to say, and the
        // difference has to be free — this runs every morning forever.
        $this->expectNoModelCall();

        GenerateProactiveInsights::dispatchSync();

        $this->assertSame(0, Insight::count());
    }

    // ── The nudge itself ──────────────────────────────────────────────────────

    public function test_a_layoff_becomes_an_insight_the_existing_screen_renders(): void
    {
        $this->logSession(10);
        $this->expectModelCall('Ten days off. Get one easy session in this week.');

        GenerateProactiveInsights::dispatchSync();

        $insight = Insight::sole();
        $this->assertSame('fitness', $insight->domain);
        $this->assertSame('proactive_nudge', $insight->kind);
        $this->assertSame('Ten days off. Get one easy session in this week.', $insight->response);
        $this->assertSame('10 days since your last session', $insight->title);
        $this->assertSame(['layoff'], $insight->input_summary['triggers']);
        $this->assertSame(10, $insight->input_summary['facts']['layoff']['days_since_last_session']);
        $this->assertSame('claude-opus-5', $insight->model);
        $this->assertSame(400, $insight->usage['input_tokens']);
    }

    public function test_the_nudge_is_listed_by_the_endpoint_the_app_already_calls(): void
    {
        $this->logSession(10);
        $this->expectModelCall();

        GenerateProactiveInsights::dispatchSync();

        // The whole reason for reusing `insights`: no new client surface.
        $this->getJson('/api/insights?domain=fitness')
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.kind', 'proactive_nudge');
    }

    // ── Cooldown ──────────────────────────────────────────────────────────────

    public function test_the_same_trigger_is_not_repeated_the_next_morning(): void
    {
        $this->logSession(10);
        $this->expectModelCall();

        // Two runs, one call: a five-day layoff otherwise produces five
        // identical cards and the screen stops being worth opening.
        GenerateProactiveInsights::dispatchSync();
        GenerateProactiveInsights::dispatchSync();

        $this->assertSame(1, Insight::count());
    }

    public function test_a_trigger_speaks_again_once_its_cooldown_has_passed(): void
    {
        $this->logSession(10);
        $this->nudge(['layoff'], 8);
        $this->expectModelCall();

        GenerateProactiveInsights::dispatchSync();

        $this->assertSame(2, Insight::count());
    }

    public function test_an_unrelated_recent_nudge_does_not_silence_this_one(): void
    {
        $this->logSession(10);
        $this->nudge(['new_pr'], 1);
        $this->expectModelCall();

        GenerateProactiveInsights::dispatchSync();

        $this->assertSame(2, Insight::count());
    }

    public function test_a_weekly_assessment_is_not_mistaken_for_a_nudge(): void
    {
        $this->logSession(10);
        Insight::create([
            'domain' => 'fitness',
            'kind' => 'weekly_assessment',
            'title' => 'Weekly fitness assessment',
            'response' => 'Solid block.',
        ]);
        $this->expectModelCall();

        GenerateProactiveInsights::dispatchSync();

        $this->assertSame(2, Insight::count());
    }

    // ── Failure ───────────────────────────────────────────────────────────────

    public function test_a_failed_model_call_writes_nothing_and_surfaces(): void
    {
        $this->logSession(10);
        $this->mock(ClaudeService::class)
            ->shouldReceive('complete')
            ->once()
            ->andThrow(new RuntimeException('API is down'));

        // It throws rather than swallowing, so the run lands in `failed_jobs`
        // instead of looking like a morning with nothing to say.
        $this->expectException(RuntimeException::class);

        try {
            GenerateProactiveInsights::dispatchSync();
        } finally {
            $this->assertSame(0, Insight::count());
        }
    }

    // ── Wiring ────────────────────────────────────────────────────────────────

    public function test_the_job_is_on_the_schedule(): void
    {
        $this->artisan('schedule:list')
            ->expectsOutputToContain('proactive-insights')
            ->assertSuccessful();
    }

    public function test_the_console_check_reports_without_spending(): void
    {
        $this->logSession(10);
        $this->expectNoModelCall();

        $this->artisan('proactive:check')
            ->expectsOutputToContain('layoff')
            ->expectsOutputToContain('Dry run')
            ->assertSuccessful();

        $this->assertSame(0, Insight::count());
    }
}
