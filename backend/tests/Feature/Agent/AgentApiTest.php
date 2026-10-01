<?php

namespace Tests\Feature\Agent;

use App\Agent\CapabilityGroup;
use App\Models\Agent;
use App\Services\Agents\AgentScope;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Route;
use Tests\TestCase;

/**
 * Assistant → Agents' routes (17.2). What a row *does* to a turn is
 * `AgentScopeTest`'s; this is the shape, the validation, and the two things
 * the API must never let through — a request making or unmaking a seeded row,
 * and `core` becoming something an agent can own.
 */
class AgentApiTest extends TestCase
{
    use RefreshDatabase;

    private function coach(): Agent
    {
        return Agent::query()->where('system_key', Agent::FITNESS_COACH)->firstOrFail();
    }

    private function created(array $overrides = []): Agent
    {
        return Agent::create(array_merge([
            'name' => 'Accountant',
            'purpose' => 'Keep my receipts in order.',
            'capabilities' => ['documents'],
            'enabled' => true,
        ], $overrides));
    }

    // ── Reading ─────────────────────────────────────────────────────────────

    public function test_the_list_is_the_seeded_rows_with_their_guardrails(): void
    {
        $response = $this->getJson('/api/agents')->assertOk();

        $this->assertSame(['Fitness coach', 'Secretary', 'News desk'], array_column($response->json('data'), 'name'));

        $coach = $response->json('data.0');
        $this->assertTrue($coach['seeded']);
        $this->assertTrue($coach['enabled']);
        $this->assertSame(['fitness'], $coach['capabilities']);
        $this->assertSame(CapabilityGroup::Fitness->guardrail(), $coach['guardrail']);
        $this->assertSame([], $coach['withholds']);
        $this->assertArrayNotHasKey('system_key', $coach);
    }

    public function test_the_groups_ride_beside_the_rows_and_never_include_core(): void
    {
        $groups = $this->getJson('/api/agents')->assertOk()->json('groups');

        $this->assertSame(
            array_map(fn (CapabilityGroup $g) => $g->value, CapabilityGroup::ownables()),
            array_column($groups, 'value'),
        );
        $this->assertNotContains('core', array_column($groups, 'value'));

        $fitness = collect($groups)->firstWhere('value', 'fitness');
        $this->assertSame(CapabilityGroup::Fitness->label(), $fitness['label']);
        $this->assertSame(CapabilityGroup::Fitness->guardrail(), $fitness['guardrail']);
        $this->assertNull(collect($groups)->firstWhere('value', 'machine')['guardrail']);
        $this->assertContains('log_workout', $fitness['tools']);
        $this->assertNotContains('get_weather', $fitness['tools']);
    }

    public function test_a_switched_off_row_says_what_it_withholds_and_a_shared_group_is_not_withheld(): void
    {
        $this->created(['name' => 'Tracker', 'capabilities' => ['calendar'], 'enabled' => true]);
        Agent::query()->where('system_key', Agent::SECRETARY)->update(['enabled' => false]);

        $secretary = collect($this->getJson('/api/agents')->json('data'))->firstWhere('name', 'Secretary');

        // The Tracker still holds the calendars, so only the other two go.
        $this->assertSame(['documents', 'deadlines'], $secretary['withholds']);
    }

    // ── Creating ────────────────────────────────────────────────────────────

    public function test_creating_one_requires_a_name_a_purpose_and_a_group(): void
    {
        $this->postJson('/api/agents', [])
            ->assertUnprocessable()
            ->assertJsonValidationErrors(['name', 'purpose', 'capabilities']);

        $this->postJson('/api/agents', ['name' => 'X', 'purpose' => 'Y', 'capabilities' => []])
            ->assertUnprocessable()
            ->assertJsonValidationErrors('capabilities');

        $this->assertSame(3, Agent::count());
    }

    public function test_core_and_unknown_groups_are_refused(): void
    {
        foreach (['core', 'weekend'] as $group) {
            $this->postJson('/api/agents', ['name' => 'X', 'purpose' => 'Y', 'capabilities' => [$group]])
                ->assertUnprocessable()
                ->assertJsonValidationErrors('capabilities.0');
        }

        $this->postJson('/api/agents', ['name' => 'X', 'purpose' => 'Y', 'capabilities' => ['fitness', 'fitness']])
            ->assertUnprocessable();

        $this->assertSame(3, Agent::count());
    }

    public function test_a_created_agent_is_switched_on_by_default_and_is_never_seeded(): void
    {
        $response = $this->postJson('/api/agents', [
            'name' => 'Accountant',
            'purpose' => 'Keep my receipts in order.',
            'capabilities' => ['documents', 'deadlines'],
            'system_key' => Agent::SECRETARY,
        ])->assertCreated();

        $this->assertTrue($response->json('enabled'));
        $this->assertFalse($response->json('seeded'));
        $this->assertNull(Agent::find($response->json('id'))->system_key);
    }

    public function test_a_created_agent_is_held_to_its_groups_guardrails(): void
    {
        // Not seeded, and guarded anyway: the rule comes with the work, not the row.
        $response = $this->postJson('/api/agents', [
            'name' => 'Accountant',
            'purpose' => 'Keep my receipts in order.',
            'capabilities' => ['deadlines', 'documents'],
        ])->assertCreated();

        $this->assertSame(
            CapabilityGroup::Documents->guardrail().' '.CapabilityGroup::Deadlines->guardrail(),
            $response->json('guardrail'),
        );

        // Changing what it owns changes what it is held to.
        $this->patchJson("/api/agents/{$response->json('id')}", ['capabilities' => ['machine']])
            ->assertOk()
            ->assertJsonPath('guardrail', null);
    }

    public function test_any_agents_guardrail_can_be_reworded_and_blank_puts_the_default_back(): void
    {
        $coach = $this->coach();
        $mine = 'Never prescribe a programme; say what the log shows and leave the plan to me.';

        $this->patchJson("/api/agents/{$coach->id}", ['guardrail' => "  {$mine}  "])
            ->assertOk()
            ->assertJsonPath('guardrail', $mine)
            ->assertJsonPath('default_guardrail', CapabilityGroup::Fitness->guardrail());

        // The prompt is held to the rewording, not the default.
        $text = AgentScope::load()->instructions();
        $this->assertStringContainsString($mine, $text);
        $this->assertStringNotContainsString(CapabilityGroup::Fitness->guardrail(), $text);

        // Blank is the default again — never "no rule" (the owner's call). Null likewise.
        foreach (['', '   ', null] as $blank) {
            $this->patchJson("/api/agents/{$coach->id}", ['guardrail' => $mine])->assertOk();
            $this->patchJson("/api/agents/{$coach->id}", ['guardrail' => $blank])
                ->assertOk()
                ->assertJsonPath('guardrail', CapabilityGroup::Fitness->guardrail());
            $this->assertNull($coach->fresh()->custom_guardrail);
        }
    }

    public function test_saving_the_default_word_for_word_stores_nothing_and_keeps_following_the_groups(): void
    {
        $agent = $this->created();

        $this->patchJson("/api/agents/{$agent->id}", ['guardrail' => CapabilityGroup::Documents->guardrail()])->assertOk();
        $this->assertNull($agent->fresh()->custom_guardrail);

        // So a later change of groups still moves it.
        $this->patchJson("/api/agents/{$agent->id}", ['capabilities' => ['deadlines']])
            ->assertOk()
            ->assertJsonPath('guardrail', CapabilityGroup::Deadlines->guardrail());
    }

    public function test_a_guardrail_sent_with_new_groups_is_compared_with_the_new_groups_default(): void
    {
        $agent = $this->created();
        $agent->rewordGuardrail('Something of my own.');
        $agent->save();

        // Groups are applied before the guardrail, so "the default" means theirs.
        $this->patchJson("/api/agents/{$agent->id}", ['capabilities' => ['deadlines'], 'guardrail' => CapabilityGroup::Deadlines->guardrail()])
            ->assertOk()
            ->assertJsonPath('guardrail', CapabilityGroup::Deadlines->guardrail());
        $this->assertNull($agent->fresh()->custom_guardrail);
    }

    public function test_a_created_agent_may_arrive_with_its_own_guardrail(): void
    {
        $this->postJson('/api/agents', [
            'name' => 'Accountant',
            'purpose' => 'Keep my receipts in order.',
            'capabilities' => ['documents'],
            'guardrail' => 'Never estimate what I owe.',
        ])->assertCreated()->assertJsonPath('guardrail', 'Never estimate what I owe.');

        $this->postJson('/api/agents', ['name' => 'X', 'purpose' => 'Y', 'capabilities' => ['documents'], 'guardrail' => str_repeat('a', 2001)])
            ->assertUnprocessable()
            ->assertJsonValidationErrors('guardrail');
    }

    public function test_the_guardrail_column_is_not_writable_by_name(): void
    {
        // Only `rewordGuardrail()` writes it — the route that makes blank mean default.
        $coach = $this->coach();

        $this->patchJson("/api/agents/{$coach->id}", ['custom_guardrail' => '', 'name' => 'Coach'])->assertOk();

        $this->assertNull($coach->fresh()->custom_guardrail);
    }

    // ── Updating ────────────────────────────────────────────────────────────

    public function test_switching_the_coach_off_takes_the_training_log_out_of_the_next_turn(): void
    {
        $response = $this->patchJson("/api/agents/{$this->coach()->id}", ['enabled' => false])->assertOk();

        $this->assertFalse($response->json('enabled'));
        $this->assertSame(['fitness'], $response->json('withholds'));
        $this->assertContains(CapabilityGroup::Fitness, AgentScope::load()->withheld());
    }

    public function test_a_seeded_rows_name_and_purpose_are_the_owners_but_its_groups_are_fixed(): void
    {
        $coach = $this->coach();

        $this->patchJson("/api/agents/{$coach->id}", ['name' => 'Coach', 'purpose' => 'Push me harder.'])
            ->assertOk()
            ->assertJsonPath('name', 'Coach')
            ->assertJsonPath('purpose', 'Push me harder.')
            ->assertJsonPath('guardrail', CapabilityGroup::Fitness->guardrail());

        $this->patchJson("/api/agents/{$coach->id}", ['capabilities' => ['fitness', 'documents']])
            ->assertUnprocessable()
            ->assertJsonValidationErrors('capabilities');

        $this->assertSame(['fitness'], $coach->fresh()->capabilities);
    }

    public function test_a_patch_can_never_unmake_a_seeded_row(): void
    {
        $coach = $this->coach();

        $this->patchJson("/api/agents/{$coach->id}", ['system_key' => null, 'name' => 'Coach'])->assertOk();

        $this->assertSame(Agent::FITNESS_COACH, $coach->fresh()->system_key);
    }

    public function test_a_created_rows_groups_can_change(): void
    {
        $agent = $this->created();

        $this->patchJson("/api/agents/{$agent->id}", ['capabilities' => ['documents', 'deadlines']])
            ->assertOk()
            ->assertJsonPath('capabilities', ['documents', 'deadlines']);

        $this->patchJson("/api/agents/{$agent->id}", ['capabilities' => ['core']])->assertUnprocessable();
        $this->patchJson("/api/agents/{$agent->id}", ['name' => ''])->assertUnprocessable();
    }

    // ── Deleting ────────────────────────────────────────────────────────────

    public function test_a_created_agent_can_be_deleted(): void
    {
        $agent = $this->created();

        $this->deleteJson("/api/agents/{$agent->id}")->assertNoContent();

        $this->assertNull(Agent::find($agent->id));
    }

    public function test_the_news_desk_is_the_owners_to_change_and_delete(): void
    {
        // Not built in (19.4, the owner's call): its groups move and it can go.
        $desk = Agent::query()->where('name', 'News desk')->sole();
        $this->assertFalse($this->getJson('/api/agents')->json('data.2.seeded'));

        $patched = $this->patchJson("/api/agents/{$desk->id}", ['capabilities' => ['news', 'calendar']])->assertOk();
        $this->assertEqualsCanonicalizing(['news', 'calendar'], $patched->json('capabilities'));

        $this->deleteJson("/api/agents/{$desk->id}")->assertNoContent();
        $this->assertFalse(Agent::query()->whereKey($desk->id)->exists());
    }

    public function test_a_seeded_agent_cannot_be_deleted(): void
    {
        $coach = $this->coach();

        $this->deleteJson("/api/agents/{$coach->id}")
            ->assertStatus(409)
            ->assertJsonPath('message', 'Fitness coach is built in, so it can be switched off but not deleted.');

        $this->assertNotNull($coach->fresh());
    }

    // ── Routing ─────────────────────────────────────────────────────────────

    public function test_nothing_here_spends_the_agent_allowance(): void
    {
        foreach (['agents.index', 'agents.store', 'agents.update', 'agents.destroy'] as $name) {
            $middleware = Route::getRoutes()->getByName($name)->gatherMiddleware();

            $this->assertNotContains('throttle:agent', $middleware, $name);
            $this->assertContains('auth:sanctum', $middleware, $name);
        }
    }
}
