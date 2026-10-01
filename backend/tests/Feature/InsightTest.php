<?php

namespace Tests\Feature;

use App\Models\Insight;
use App\Services\ClaudeService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class InsightTest extends TestCase
{
    use RefreshDatabase;

    private function makeInsight(array $attrs = []): Insight
    {
        return Insight::create(array_merge([
            'domain' => 'fitness',
            'kind' => 'weekly_assessment',
            'title' => 'Weekly fitness assessment',
            'response' => 'Great week!',
        ], $attrs));
    }

    // ── GET /api/insights ─────────────────────────────────────────────────────

    public function test_index_returns_list(): void
    {
        $this->makeInsight();
        $this->makeInsight(['domain' => 'travel', 'kind' => 'summary', 'title' => 'Trip review']);

        $this->getJson('/api/insights')
            ->assertOk()
            ->assertJsonCount(2, 'data')
            ->assertJsonStructure(['data' => [['id', 'domain', 'kind', 'title', 'response']]]);
    }

    public function test_index_filters_by_domain(): void
    {
        $this->makeInsight(['domain' => 'fitness']);
        $this->makeInsight(['domain' => 'travel', 'kind' => 'summary', 'title' => 'Trip review']);

        $this->getJson('/api/insights?domain=fitness')
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.domain', 'fitness');
    }

    public function test_index_filters_by_kind(): void
    {
        // What the HUD's nudges panel asks for. The proactive layer has been
        // writing these rows since Phase 4 and nothing has ever had a surface
        // for them.
        $this->makeInsight(['kind' => 'weekly_assessment']);
        $this->makeInsight(['kind' => 'proactive_nudge', 'title' => 'Four days off']);

        $this->getJson('/api/insights?kind=proactive_nudge')
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.title', 'Four days off');
    }

    public function test_index_clamps_the_limit_it_is_given(): void
    {
        foreach (range(1, 4) as $i) {
            $this->makeInsight(['title' => "Insight {$i}"]);
        }

        $this->getJson('/api/insights?limit=2')->assertOk()->assertJsonCount(2, 'data');

        // The ceiling is the server's to decide, exactly as it is for the
        // agent's tools.
        $this->getJson('/api/insights?limit=9999')->assertOk()->assertJsonCount(4, 'data');
        $this->getJson('/api/insights?limit=0')->assertOk()->assertJsonCount(1, 'data');
    }

    public function test_index_returns_empty_list_when_no_insights(): void
    {
        $this->getJson('/api/insights')
            ->assertOk()
            ->assertJson(['data' => []]);
    }

    // ── POST /api/insights/fitness ────────────────────────────────────────────

    public function test_fitness_returns_422_when_no_recent_workouts(): void
    {
        $this->postJson('/api/insights/fitness')
            ->assertUnprocessable()
            ->assertJsonPath('message', fn ($v) => str_contains($v, 'No workouts'));
    }

    public function test_fitness_creates_insight_and_returns_201(): void
    {
        $this->makeWorkout();

        $this->mock(ClaudeService::class)
            ->shouldReceive('complete')
            ->once()
            ->andReturn([
                'text' => 'Great week!',
                'usage' => ['input_tokens' => 100, 'output_tokens' => 50,
                    'cache_read_input_tokens' => null, 'cache_creation_input_tokens' => null],
                'model' => 'claude-opus-4-7',
            ]);

        $this->postJson('/api/insights/fitness')
            ->assertCreated()
            ->assertJsonPath('domain', 'fitness')
            ->assertJsonPath('kind', 'weekly_assessment')
            ->assertJsonPath('response', 'Great week!')
            ->assertJsonPath('input_summary.workout_count', 1)
            ->assertJsonPath('input_summary.date_range_start', now()->toDateString())
            ->assertJsonPath('input_summary.date_range_end', now()->toDateString());

        $this->assertDatabaseCount('insights', 1);
        $this->assertDatabaseHas('insights', ['domain' => 'fitness', 'model' => 'claude-opus-4-7']);
    }

    public function test_fitness_returns_502_when_claude_call_fails(): void
    {
        $this->makeWorkout();

        $this->mock(ClaudeService::class)
            ->shouldReceive('complete')
            ->once()
            ->andThrow(new \RuntimeException('API key missing'));

        $this->postJson('/api/insights/fitness')
            ->assertStatus(502)
            ->assertJsonPath('message', fn ($v) => str_contains($v, 'Claude call failed'));
    }

    public function test_fitness_excludes_workouts_older_than_21_days(): void
    {
        // Only workout is 22 days old — falls outside the 21-day window
        $this->makeWorkout(['started_at' => now()->subDays(22)->toDateTimeString()]);

        $this->postJson('/api/insights/fitness')
            ->assertUnprocessable();
    }

    public function test_fitness_includes_workout_within_21_day_window(): void
    {
        $this->makeWorkout(['started_at' => now()->subDays(20)->toDateTimeString()]);

        $this->mock(ClaudeService::class)
            ->shouldReceive('complete')
            ->once()
            ->andReturn([
                'text' => 'Boundary test.',
                'usage' => ['input_tokens' => 10, 'output_tokens' => 5,
                    'cache_read_input_tokens' => null, 'cache_creation_input_tokens' => null],
                'model' => 'claude-opus-4-7',
            ]);

        $this->postJson('/api/insights/fitness')->assertCreated();
    }
}
