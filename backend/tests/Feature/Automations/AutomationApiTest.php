<?php

namespace Tests\Feature\Automations;

use App\Jobs\RunAutomation;
use App\Models\Automation;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Queue;
use Tests\TestCase;

/**
 * The Automations overlay's routes (15.4 draws them; this is the backend).
 *
 * What is actually asserted here is the shape, the validation and the once-a-day
 * claim — `AutomationRunner` owns what a run does and is tested on its own.
 */
class AutomationApiTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        // The migration seeds row one — "Morning greeting", disabled — so every
        // test starts from a clean table rather than working around it.
        Automation::query()->delete();
    }

    private function automation(array $overrides = []): Automation
    {
        return Automation::create(array_merge([
            'name' => 'Morning greeting',
            'time' => '06:30',
            'intent' => 'Say good morning.',
            'context' => ['agenda', 'weather', 'training'],
            'enabled' => true,
        ], $overrides));
    }

    // ── CRUD ────────────────────────────────────────────────────────────────

    public function test_the_list_is_ordered_by_time(): void
    {
        $this->automation(['name' => 'Evening wrap-up', 'time' => '21:00']);
        $this->automation(['name' => 'Morning greeting', 'time' => '06:30']);

        $response = $this->getJson('/api/automations')->assertOk();

        $this->assertSame(
            ['Morning greeting', 'Evening wrap-up'],
            array_column($response->json('data'), 'name'),
        );
    }

    public function test_creating_one_requires_every_field(): void
    {
        $this->postJson('/api/automations', [])
            ->assertUnprocessable()
            ->assertJsonValidationErrors(['name', 'time', 'intent', 'context']);

        $this->assertSame(0, Automation::count());
    }

    public function test_a_bad_time_or_context_value_is_a_422(): void
    {
        $this->postJson('/api/automations', [
            'name' => 'Test', 'time' => '6:30', 'intent' => 'Hi', 'context' => ['agenda'],
        ])->assertUnprocessable()->assertJsonValidationErrors('time');

        $this->postJson('/api/automations', [
            'name' => 'Test', 'time' => '06:30', 'intent' => 'Hi', 'context' => ['weekend'],
        ])->assertUnprocessable()->assertJsonValidationErrors('context.0');
    }

    public function test_creating_one_defaults_to_disabled(): void
    {
        $response = $this->postJson('/api/automations', [
            'name' => 'Test', 'time' => '06:30', 'intent' => 'Hi', 'context' => ['agenda'],
        ])->assertCreated();

        $this->assertFalse($response->json('enabled'));
    }

    public function test_updating_is_partial_and_each_field_sent_is_fully_validated(): void
    {
        $automation = $this->automation();

        $this->patchJson("/api/automations/{$automation->id}", ['enabled' => false])
            ->assertOk()
            ->assertJson(['enabled' => false, 'name' => 'Morning greeting']);

        $this->patchJson("/api/automations/{$automation->id}", ['time' => 'noon'])
            ->assertUnprocessable()
            ->assertJsonValidationErrors('time');
    }

    public function test_deleting_removes_it(): void
    {
        $automation = $this->automation();

        $this->deleteJson("/api/automations/{$automation->id}")->assertNoContent();
        $this->assertSame(0, Automation::count());
    }

    // ── Running ─────────────────────────────────────────────────────────────

    public function test_run_now_dispatches_regardless_of_the_guard(): void
    {
        Queue::fake();
        $automation = $this->automation(['enabled' => false, 'last_run_on' => now()->toDateString()]);

        $this->postJson("/api/automations/{$automation->id}/run")->assertStatus(202);

        Queue::assertPushed(RunAutomation::class, fn (RunAutomation $job) => $job->automationId === $automation->id);
    }

    public function test_due_claims_and_dispatches_a_row_past_its_time_not_yet_run_today(): void
    {
        Queue::fake();
        $this->travelTo(now()->timezone(config('agent.timezone'))->setTime(7, 0));
        $automation = $this->automation(['time' => '06:30']);

        $response = $this->postJson('/api/automations/due')->assertOk();

        $this->assertSame([$automation->id], $response->json('claimed'));
        $this->assertSame(now()->timezone(config('agent.timezone'))->toDateString(), $automation->fresh()->last_run_on->toDateString());
        Queue::assertPushed(RunAutomation::class, 1);
    }

    public function test_due_ignores_a_row_not_yet_at_its_time(): void
    {
        Queue::fake();
        $this->travelTo(now()->timezone(config('agent.timezone'))->setTime(6, 0));
        $this->automation(['time' => '06:30']);

        $this->postJson('/api/automations/due')->assertOk()->assertJson(['claimed' => []]);
        Queue::assertNothingPushed();
    }

    public function test_due_ignores_a_row_already_run_today(): void
    {
        Queue::fake();
        $today = now()->timezone(config('agent.timezone'))->toDateString();
        $this->automation(['time' => '06:30', 'last_run_on' => $today]);

        $this->postJson('/api/automations/due')->assertOk()->assertJson(['claimed' => []]);
        Queue::assertNothingPushed();
    }

    public function test_due_fires_later_in_the_day_time_aware(): void
    {
        Queue::fake();
        $this->travelTo(now()->timezone(config('agent.timezone'))->setTime(15, 0));
        $automation = $this->automation(['time' => '06:30']);

        $this->postJson('/api/automations/due')->assertOk()->assertJson(['claimed' => [$automation->id]]);
    }

    public function test_due_ignores_disabled_rows(): void
    {
        Queue::fake();
        $this->travelTo(now()->timezone(config('agent.timezone'))->setTime(7, 0));
        $this->automation(['time' => '06:30', 'enabled' => false]);

        $this->postJson('/api/automations/due')->assertOk()->assertJson(['claimed' => []]);
        Queue::assertNothingPushed();
    }

    public function test_a_row_run_yesterday_is_due_again_today(): void
    {
        Queue::fake();
        $this->travelTo(now()->timezone(config('agent.timezone'))->setTime(7, 0));
        $automation = $this->automation(['time' => '06:30', 'last_run_on' => now()->subDay()->toDateString()]);

        $this->postJson('/api/automations/due')->assertOk()->assertJson(['claimed' => [$automation->id]]);
    }
}
