<?php

namespace Tests\Feature\Settings;

use App\Jobs\GenerateProactiveInsights;
use App\Models\AgentRun;
use App\Models\Conversation;
use App\Models\Insight;
use App\Models\WorkoutSet;
use App\Services\AnthropicSwitch;
use App\Services\ClaudeService;
use App\Services\Exceptions\AnthropicDisabled;
use App\Services\FitnessStatsService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

/**
 * The switch that decides whether this app may spend money at Anthropic.
 *
 * Every paid path in the app is exercised here rather than only the gate
 * itself, and that is the point of the file: a kill switch is only worth having
 * if *nothing* gets past it, and the way this breaks in future is a new caller
 * that never asks.
 */
class AnthropicSwitchTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        // Pinned for the same reason HealthTest pins it: this machine has a key
        // in `.env` and CI does not, and every assertion below is about the
        // switch rather than about the key.
        config(['services.anthropic.key' => 'test-key']);
    }

    #[Test]
    public function it_is_on_until_someone_says_otherwise(): void
    {
        $this->assertTrue(AnthropicSwitch::enabled());

        $this->getJson('/api/health')
            ->assertOk()
            ->assertJsonPath('assistant.state', 'up')
            ->assertJsonPath('assistant.enabled', true)
            ->assertJsonPath('assistant.configured', true);
    }

    #[Test]
    public function switching_it_off_reads_as_a_choice_rather_than_a_fault(): void
    {
        $this->postJson('/api/settings/anthropic', ['enabled' => false])
            ->assertOk()
            ->assertJsonPath('state', 'off')
            ->assertJsonPath('enabled', false);

        $health = $this->getJson('/api/health')->assertOk();

        $this->assertSame('off', $health->json('assistant.state'));
        $this->assertFalse($health->json('assistant.enabled'));
        // Still configured: the key is there, it is simply not being used.
        $this->assertTrue($health->json('assistant.configured'));
        // And the pill stays ONLINE. An assistant that was switched off on
        // purpose is not a degraded machine, and saying so would teach the pill
        // to be ignored.
        $this->assertTrue($health->json('ok'));
    }

    #[Test]
    public function a_missing_key_is_still_a_different_state_from_a_switch(): void
    {
        config(['services.anthropic.key' => null]);

        $this->getJson('/api/health')
            ->assertOk()
            ->assertJsonPath('assistant.state', 'down')
            ->assertJsonPath('assistant.enabled', true)
            ->assertJsonPath('ok', false);
    }

    #[Test]
    public function the_setting_survives_being_read_back(): void
    {
        $this->postJson('/api/settings/anthropic', ['enabled' => false])->assertOk();
        $this->assertFalse(AnthropicSwitch::enabled());

        $this->postJson('/api/settings/anthropic', ['enabled' => true])->assertOk();
        $this->assertTrue(AnthropicSwitch::enabled());
    }

    #[Test]
    public function it_validates_the_flag(): void
    {
        $this->postJson('/api/settings/anthropic', [])->assertStatus(422);
        $this->postJson('/api/settings/anthropic', ['enabled' => 'maybe'])->assertStatus(422);
    }

    #[Test]
    public function the_service_refuses_even_with_a_key_configured(): void
    {
        AnthropicSwitch::set(false);

        $this->expectException(AnthropicDisabled::class);

        app(ClaudeService::class)->complete('system', 'hello');
    }

    #[Test]
    public function the_weekly_assessment_is_refused_while_it_is_off(): void
    {
        $workout = $this->makeWorkout(['started_at' => now()->subDays(2)->toDateTimeString()]);
        WorkoutSet::create([
            'workout_id' => $workout->id,
            'exercise_title' => 'Bench Press',
            'set_index' => 0,
            'set_type' => 'normal',
            'weight_kg' => 100,
            'reps' => 5,
        ]);

        AnthropicSwitch::set(false);

        // 503 rather than the 502 a failed call gets: nothing failed, and the
        // fix is a toggle rather than a configuration file.
        $this->postJson('/api/insights/fitness')
            ->assertStatus(503)
            ->assertJsonPath('message', AnthropicDisabled::MESSAGE);

        $this->assertSame(0, Insight::query()->count());
    }

    #[Test]
    public function the_switch_outranks_having_nothing_to_assess(): void
    {
        // Both refusals are true on a quiet month, and only one of them names
        // something the user just did. Logging a session would not fix this.
        AnthropicSwitch::set(false);

        $this->postJson('/api/insights/fitness')
            ->assertStatus(503)
            ->assertJsonPath('message', AnthropicDisabled::MESSAGE);
    }

    #[Test]
    public function a_message_is_refused_before_a_turn_is_stored_or_a_run_queued(): void
    {
        AnthropicSwitch::set(false);
        $conversation = Conversation::create(['title' => null]);

        $this->postJson("/api/agent/conversations/{$conversation->id}/messages", [
            'message' => 'How did last week go?',
        ])
            ->assertStatus(503)
            ->assertJsonPath('message', AnthropicDisabled::MESSAGE);

        // The thread is left exactly as it was: no half-conversation ending in
        // a question nothing answered, and nothing queued for a worker to fail.
        $this->assertSame(0, $conversation->messages()->count());
        $this->assertSame(0, AgentRun::query()->count());
    }

    #[Test]
    public function the_proactive_nudge_never_reaches_the_model_while_it_is_off(): void
    {
        // A layoff long enough to fire, so the only thing keeping this quiet is
        // the switch.
        $this->makeWorkout(['started_at' => now()->subDays(9)->toDateTimeString()]);

        AnthropicSwitch::set(false);
        $this->mock(ClaudeService::class)->shouldNotReceive('complete');

        app(GenerateProactiveInsights::class)->handle(
            app(FitnessStatsService::class),
            app(ClaudeService::class),
        );

        $this->assertSame(0, Insight::query()->count());
    }

    #[Test]
    public function turning_it_back_on_lets_the_call_through(): void
    {
        $workout = $this->makeWorkout(['started_at' => now()->subDays(2)->toDateTimeString()]);
        WorkoutSet::create([
            'workout_id' => $workout->id,
            'exercise_title' => 'Bench Press',
            'set_index' => 0,
            'set_type' => 'normal',
            'weight_kg' => 100,
            'reps' => 5,
        ]);

        AnthropicSwitch::set(false);
        AnthropicSwitch::set(true);

        $this->mock(ClaudeService::class)
            ->shouldReceive('complete')
            ->once()
            ->andReturn([
                'text' => 'Keep pressing.',
                'usage' => ['input_tokens' => 10, 'output_tokens' => 5,
                    'cache_read_input_tokens' => null, 'cache_creation_input_tokens' => null],
                'model' => 'claude-opus-5',
            ]);

        $this->postJson('/api/insights/fitness')->assertStatus(201);
    }
}
