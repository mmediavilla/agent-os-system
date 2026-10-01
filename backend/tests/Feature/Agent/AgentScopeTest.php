<?php

namespace Tests\Feature\Agent;

use App\Agent\AgentRunner;
use App\Agent\CapabilityGroup;
use App\Agent\Streaming\RunDispatcher;
use App\Agent\Support\Instructions;
use App\Agent\ToolRegistry;
use App\Models\Agent;
use App\Models\AgentAction;
use App\Models\AgentRun;
use App\Models\Automation;
use App\Models\Conversation;
use App\Models\ConversationMessage;
use App\Services\Agents\AgentScope;
use App\Services\Automations\AutomationRunner;
use App\Services\ClaudeService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * Agents as rows (17.1): a switched-off agent's tools are not offered, the
 * prompt says so, and the one caller that must keep every tool does.
 *
 * The switch is proven by what the model is *offered* — the `tools` and the
 * system prompt handed to `ClaudeService::turn()` — never by what it says.
 */
class AgentScopeTest extends TestCase
{
    use RefreshDatabase;

    private const FITNESS = ['get_fitness_stats', 'list_workouts', 'get_workout', 'search_exercises', 'list_equipment', 'log_workout', 'update_workout', 'create_exercise', 'save_insight'];

    private function switchOff(string $systemKey): void
    {
        Agent::query()->where('system_key', $systemKey)->update(['enabled' => false]);
    }

    private function agent(array $attributes): Agent
    {
        return Agent::create(array_merge(['purpose' => 'Something.', 'enabled' => true], $attributes));
    }

    /** A turn that just talks. */
    private function reply(string $text = 'Certainly, Sir.'): array
    {
        return [
            'content' => [['type' => 'text', 'text' => $text]],
            'stop_reason' => 'end_turn',
            'usage' => ['input_tokens' => 10, 'output_tokens' => 5],
            'model' => 'claude-sonnet-5',
        ];
    }

    /**
     * Expect one model call and keep what it was handed.
     *
     * @return object{system: ?string, tools: list<string>}
     */
    private function capture(): object
    {
        $seen = (object) ['system' => null, 'tools' => []];

        $this->mock(ClaudeService::class)->shouldReceive('turn')->once()
            ->withArgs(function (string $system, array $messages, array $tools) use ($seen) {
                $seen->system = $system;
                $seen->tools = array_column($tools, 'name');

                return true;
            })
            ->andReturn($this->reply());

        return $seen;
    }

    private function queueRun(string $trigger = AgentRun::TRIGGER_MESSAGE): void
    {
        $conversation = Conversation::create(['title' => 'Chat']);
        $conversation->messages()->create([
            'role' => ConversationMessage::USER,
            'content' => [['type' => 'text', 'text' => 'How has my training been?']],
        ]);
        $conversation->forceFill(['last_message_at' => now()])->save();

        // The sync queue runs the job inline.
        RunDispatcher::queue($conversation, $trigger);
    }

    // ── The seeded rows ─────────────────────────────────────────────────────

    public function test_the_migrations_leave_two_built_in_agents_and_the_news_desk_as_the_owners_own(): void
    {
        // On, not off (the owner's call): an agent off takes tools away, so seeding
        // these off would have been the migration switching the training log
        // off on the day it ran.
        $agents = Agent::query()->orderBy('id')->get();

        $this->assertSame(['Fitness coach', 'Secretary', 'News desk'], $agents->pluck('name')->all());
        $this->assertSame([true, true, true], $agents->pluck('enabled')->all());
        // The News desk is the owner's agent, not a built-in one (19.4, the owner's call).
        $this->assertSame([Agent::FITNESS_COACH, Agent::SECRETARY, null], $agents->pluck('system_key')->all());
        $this->assertSame([CapabilityGroup::Fitness], $agents[0]->groups());
        $this->assertSame([CapabilityGroup::Calendar, CapabilityGroup::Documents, CapabilityGroup::Deadlines], $agents[1]->groups());
        $this->assertSame([CapabilityGroup::News], $agents[2]->groups());
        // It follows its group's rule rather than freezing today's wording.
        $this->assertNull($agents[2]->custom_guardrail);
        $this->assertSame(CapabilityGroup::News->guardrail(), $agents[2]->guardrail());
    }

    public function test_with_the_seeded_agents_on_nothing_changes(): void
    {
        $tools = app(ToolRegistry::class);
        $scope = AgentScope::load();

        $this->assertSame(array_keys($tools->all()), array_keys($scope->registry($tools)->all()));
        $this->assertSame([], $scope->withheld());
        $this->assertStringNotContainsString('switched off', $scope->instructions());
    }

    // ── What a row claims ───────────────────────────────────────────────────

    public function test_a_row_that_claims_core_or_an_unknown_group_keeps_only_what_is_real(): void
    {
        // A hand-edited row must cost that one claim, not fail a turn — and a
        // claim on core must not make the weather look switchable.
        $agent = $this->agent(['name' => 'Odd', 'capabilities' => ['core', 'astrology', 'fitness', 'fitness', 7]]);

        $this->assertSame([CapabilityGroup::Fitness], $agent->groups());
    }

    public function test_a_guardrail_is_its_groups_rules_in_the_enums_order(): void
    {
        $coach = Agent::query()->where('system_key', Agent::FITNESS_COACH)->sole();
        $this->assertSame(CapabilityGroup::Fitness->guardrail(), $coach->guardrail());

        // The Secretary's is three rules, one per group — none shared, so none
        // depends on which others it happens to be owned with.
        $secretary = Agent::query()->where('system_key', Agent::SECRETARY)->sole();
        $this->assertSame(implode(' ', [
            CapabilityGroup::Calendar->guardrail(),
            CapabilityGroup::Documents->guardrail(),
            CapabilityGroup::Deadlines->guardrail(),
        ]), $secretary->guardrail());

        // A created row is held to the same rules, whatever order it lists them in.
        $created = $this->agent(['name' => 'Accountant', 'capabilities' => ['deadlines', 'machine', 'documents']]);
        $this->assertSame(
            CapabilityGroup::Documents->guardrail().' '.CapabilityGroup::Deadlines->guardrail(),
            $created->guardrail(),
        );

        // A group with no rule adds nothing, and owning only such groups is null.
        $this->assertNull($this->agent(['name' => 'Opener', 'capabilities' => ['machine']])->guardrail());
    }

    public function test_every_group_but_machine_and_core_has_a_rule_of_its_own(): void
    {
        $rules = [];

        foreach (CapabilityGroup::cases() as $group) {
            if (in_array($group, [CapabilityGroup::Machine, CapabilityGroup::Core], true)) {
                $this->assertNull($group->guardrail(), $group->value);

                continue;
            }

            $this->assertNotEmpty($group->guardrail(), $group->value);
            $rules[] = $group->guardrail();
        }

        $this->assertSame($rules, array_unique($rules));
    }

    public function test_every_guarded_group_the_model_is_offered_arrives_with_its_rule(): void
    {
        // The invariant the seeded rows' fixed groups exist for: a rule reaches
        // the prompt on an enabled owner's line, so a guarded group offered with
        // no such line would be offered with no rule.
        $states = [
            'as seeded' => fn () => null,
            'coach off' => fn () => $this->switchOff(Agent::FITNESS_COACH),
            'secretary off, a planner holds the calendars' => function () {
                $this->switchOff(Agent::SECRETARY);
                $this->agent(['name' => 'Planner', 'capabilities' => ['calendar']]);
            },
        ];

        foreach ($states as $label => $arrange) {
            $arrange();
            $scope = AgentScope::load();
            $text = $scope->instructions();

            foreach ($scope->offered() as $group) {
                if ($group->guardrail() !== null) {
                    $this->assertStringContainsString($group->guardrail(), $text, "{$label}: {$group->value}");
                }
            }
        }
    }

    // ── Which groups are withheld ───────────────────────────────────────────

    public function test_switching_the_fitness_coach_off_withholds_the_training_log_and_nothing_else(): void
    {
        $this->switchOff(Agent::FITNESS_COACH);

        $scope = AgentScope::load();
        $offered = array_keys($scope->registry(app(ToolRegistry::class))->all());

        $this->assertSame([CapabilityGroup::Fitness], $scope->withheld());
        $this->assertSame([], array_intersect(self::FITNESS, $offered));
        $this->assertSame(['list_events', 'get_weather', 'save_facts', 'search_documents', 'list_deadlines', 'get_news', 'pin_articles', 'list_pinned_articles'], $offered);
    }

    public function test_the_news_desk_on_offers_get_news_and_off_withholds_it(): void
    {
        $tools = app(ToolRegistry::class);

        $this->assertArrayHasKey('get_news', AgentScope::load()->registry($tools)->all());
        $this->assertArrayHasKey('get_news', AgentScope::load()->registry($tools->readOnly())->all());

        Agent::query()->where('name', 'News desk')->update(['enabled' => false]);
        $scope = AgentScope::load();

        $this->assertSame([CapabilityGroup::News], $scope->withheld());
        $this->assertArrayNotHasKey('get_news', $scope->registry($tools)->all());
        $this->assertArrayNotHasKey('get_news', $scope->registry($tools->readOnly())->all());
        // The reading list goes with it, both halves (19.2).
        $this->assertArrayNotHasKey('pin_articles', $scope->registry($tools)->all());
        $this->assertArrayNotHasKey('list_pinned_articles', $scope->registry($tools->readOnly())->all());
        $this->assertStringContainsString('News desk (the news)', $scope->instructions());
        $this->assertStringNotContainsString(CapabilityGroup::News->guardrail(), $scope->instructions());
    }

    public function test_the_news_desks_line_carries_its_purpose_and_the_news_rule(): void
    {
        $text = AgentScope::load()->instructions();

        $this->assertStringContainsString('- News desk (the news): Brief me on local news and my interests.', $text);
        $this->assertStringContainsString(CapabilityGroup::News->guardrail(), $text);
    }

    public function test_unmaking_the_built_in_news_desk_keeps_the_row_and_can_be_undone(): void
    {
        $migration = require database_path('migrations/2026_09_30_000002_make_the_news_desk_a_created_agent.php');
        $desk = Agent::query()->where('name', 'News desk')->sole();
        $desk->forceFill(['purpose' => 'My own words.'])->save();

        $migration->down();
        $this->assertSame(Agent::NEWS_DESK, $desk->fresh()->system_key);

        $migration->up();
        $migration->up();
        // The same row, with the owner's words — only the key went.
        $this->assertNull($desk->fresh()->system_key);
        $this->assertSame('My own words.', $desk->fresh()->purpose);
        $this->assertSame(3, Agent::count());
    }

    public function test_a_guarded_group_no_agent_owns_is_withheld_and_the_prompt_says_how_to_get_it(): void
    {
        // The News desk deleted: `news` has a rule and no owner, so offering it
        // would hand the model get_news with no rule at all.
        Agent::query()->where('name', 'News desk')->delete();
        $tools = app(ToolRegistry::class);
        $scope = AgentScope::load();

        $this->assertSame([CapabilityGroup::News], $scope->withheld());
        $this->assertSame([CapabilityGroup::News], $scope->unowned());
        $this->assertArrayNotHasKey('get_news', $scope->registry($tools)->all());
        $this->assertArrayNotHasKey('list_pinned_articles', $scope->registry($tools->readOnly())->all());
        $this->assertStringContainsString('No agent of the user\'s does the news', $scope->instructions());
        $this->assertStringContainsString('can be made in Assistant → Agents', $scope->instructions());
        // Nobody is switched off, so nobody is named as off.
        $this->assertStringNotContainsString('switched off', $scope->instructions());

        // Making one is how it comes back.
        $this->agent(['name' => 'Sports desk', 'capabilities' => ['news']]);
        $scope = AgentScope::load();
        $this->assertSame([], $scope->withheld());
        $this->assertArrayHasKey('get_news', $scope->registry($tools)->all());
        $this->assertStringContainsString(CapabilityGroup::News->guardrail(), $scope->instructions());
    }

    public function test_a_news_agent_switched_off_is_named_as_off_not_as_missing(): void
    {
        Agent::query()->where('name', 'News desk')->update(['enabled' => false]);
        $scope = AgentScope::load();

        $this->assertSame([], $scope->unowned());
        $this->assertStringContainsString('News desk (the news)', $scope->instructions());
        $this->assertStringNotContainsString('No agent of the user\'s', $scope->instructions());
    }

    public function test_a_group_with_no_rule_and_no_agent_rides_along(): void
    {
        // `machine` belongs to no agent and has no rule. A switch nobody made
        // cannot be off: reading "unclaimed" as "off" would take
        // open_on_this_machine away with no row to say so.
        $this->switchOff(Agent::FITNESS_COACH);
        $this->switchOff(Agent::SECRETARY);

        $this->assertContains(CapabilityGroup::Machine, AgentScope::load()->offered());
        $this->assertNotContains(CapabilityGroup::Machine, AgentScope::load()->withheld());

        // With no rows at all, only the groups with no rule are offered: a
        // guarded group's rule has no line to arrive on (19.4).
        $unguarded = array_values(array_filter(CapabilityGroup::ownables(), fn (CapabilityGroup $g) => $g->guardrail() === null));
        $this->assertSame([CapabilityGroup::Machine], $unguarded);
        $this->assertSame($unguarded, AgentScope::of([])->offered());
    }

    public function test_one_enabled_owner_keeps_a_shared_group(): void
    {
        $this->switchOff(Agent::SECRETARY);
        $this->agent(['name' => 'Planner', 'capabilities' => ['calendar']]);

        $scope = AgentScope::load();

        $this->assertContains(CapabilityGroup::Calendar, $scope->offered());
        $this->assertSame([CapabilityGroup::Documents, CapabilityGroup::Deadlines], $scope->withheld());

        // The Secretary is named only for what it actually took away.
        $this->assertStringContainsString('Secretary (filed documents and deadlines)', $scope->instructions());
    }

    // ── What the prompt says ────────────────────────────────────────────────

    public function test_the_prompt_names_each_enabled_agent_with_its_purpose_and_guardrail(): void
    {
        $text = AgentScope::load()->instructions();

        $this->assertStringContainsString('- Fitness coach (the training log): Keep track of my training', $text);
        $this->assertStringContainsString(CapabilityGroup::Fitness->guardrail(), $text);
        $this->assertStringContainsString('- Secretary (the calendars, filed documents and deadlines):', $text);
        $this->assertStringContainsString(CapabilityGroup::Documents->guardrail(), $text);
    }

    public function test_a_switched_off_agent_is_said_rather_than_gone_quiet(): void
    {
        $this->switchOff(Agent::FITNESS_COACH);

        $text = AgentScope::load()->instructions();

        $this->assertStringContainsString('switched off', $text);
        $this->assertStringContainsString('Fitness coach (the training log)', $text);
        $this->assertStringContainsString('Assistant → Agents', $text);
        // It explains why the shared notes still name tools it was not given.
        $this->assertStringContainsString('name a tool you have not been given', $text);
        // An agent that is off is not also listed among the ones at work.
        $this->assertStringNotContainsString('- Fitness coach', $text);
        $this->assertStringNotContainsString(CapabilityGroup::Fitness->guardrail(), $text);
    }

    public function test_the_agents_paragraph_sits_after_the_gate_and_before_the_shared_notes(): void
    {
        $this->switchOff(Agent::FITNESS_COACH);
        $scope = AgentScope::load();
        $tools = $scope->registry(app(ToolRegistry::class));

        $prompt = Instructions::systemPrompt($tools, '', $scope->instructions());
        $at = strpos($prompt, 'Some of the user\'s agents are switched off');

        // With the gate: both are standing rules about what this caller may do.
        $this->assertGreaterThan(strpos($prompt, 'are proposed to the'), $at);
        $this->assertLessThan(strpos($prompt, 'A turn may carry a photograph'), $at);
        $this->assertLessThan(strpos($prompt, Instructions::TOOLS), $at);

        // The gate narrowed by itself: the coach's writes are no longer named.
        $this->assertStringNotContainsString('log_workout are proposed', $prompt);
        $this->assertStringContainsString('save_facts and pin_articles are proposed', $prompt);
    }

    public function test_without_a_paragraph_the_prompt_is_what_it_always_was(): void
    {
        $tools = app(ToolRegistry::class);

        $this->assertSame(Instructions::systemPrompt($tools), Instructions::systemPrompt($tools, '', ''));
        $this->assertStringContainsString("\n\nA turn may carry a photograph", Instructions::systemPrompt($tools));
        $this->assertStringNotContainsString("\n\n\nA turn may carry", Instructions::systemPrompt($tools));
    }

    // ── Where it is applied ─────────────────────────────────────────────────

    public function test_a_typed_run_is_offered_only_what_the_agents_allow(): void
    {
        $this->switchOff(Agent::FITNESS_COACH);
        $seen = $this->capture();

        $this->queueRun();

        $this->assertNotContains('log_workout', $seen->tools);
        $this->assertNotContains('get_fitness_stats', $seen->tools);
        $this->assertContains('list_events', $seen->tools);
        $this->assertStringContainsString('Fitness coach (the training log)', $seen->system);
    }

    public function test_an_automations_own_run_is_scoped_like_any_other(): void
    {
        // The model choosing among tools in a delivered greeting's thread is a
        // model-facing caller; only the runner's own fetches are exempt.
        $this->switchOff(Agent::SECRETARY);
        $seen = $this->capture();

        $this->queueRun(AgentRun::TRIGGER_AUTOMATION);

        $this->assertNotContains('list_events', $seen->tools);
        $this->assertNotContains('list_deadlines', $seen->tools);
        $this->assertContains('get_fitness_stats', $seen->tools);
    }

    public function test_a_toggle_lands_on_the_next_run_without_a_new_worker(): void
    {
        // The worker holds the registry singleton for an hour; the rows must
        // be read per run, not captured with it.
        app(ToolRegistry::class);
        $this->switchOff(Agent::FITNESS_COACH);
        $seen = $this->capture();

        $this->queueRun();

        $this->assertNotContains('log_workout', $seen->tools);
    }

    public function test_voice_loses_the_secretarys_tools_including_the_calendar_opener(): void
    {
        config(['agent.local.enabled' => true]);
        $this->switchOff(Agent::SECRETARY);
        $seen = $this->capture();

        $this->postJson('/api/voice/turn', ['message' => 'What is on this week?'])->assertOk();

        $this->assertNotContains('list_events', $seen->tools);
        $this->assertNotContains('show_google_calendar', $seen->tools);
        $this->assertNotContains('search_documents', $seen->tools);
        $this->assertContains('get_fitness_stats', $seen->tools);
        $this->assertStringContainsString('Secretary (the calendars, filed documents and deadlines)', $seen->system);
        $this->assertStringContainsString(Instructions::SPOKEN, $seen->system);
    }

    public function test_voice_keeps_the_calendar_opener_while_the_secretary_is_on(): void
    {
        config(['agent.local.enabled' => true]);
        $seen = $this->capture();

        $this->postJson('/api/voice/turn', ['message' => 'Show me my week.'])->assertOk();

        $this->assertContains('show_google_calendar', $seen->tools);
    }

    public function test_mcp_lists_only_what_the_agents_allow(): void
    {
        config(['agent.token' => 'test-agent-token']);
        $this->switchOff(Agent::FITNESS_COACH);

        $names = array_column(
            $this->withToken('test-agent-token')
                ->postJson('/api/mcp', ['jsonrpc' => '2.0', 'id' => 1, 'method' => 'tools/list'])
                ->assertOk()
                ->json('result.tools'),
            'name',
        );

        $this->assertSame([], array_intersect(self::FITNESS, $names));
        $this->assertContains('list_events', $names);
        $this->assertContains('get_weather', $names);
    }

    // ── Where it must not be applied ────────────────────────────────────────

    public function test_an_automation_still_assembles_with_every_agent_off(): void
    {
        // The trap this design turns on: AutomationRunner calls list_events,
        // get_fitness_stats and list_deadlines itself. Scoping the singleton
        // would record `failed` on a greeting whose only fault is that an
        // unrelated switch moved.
        $this->switchOff(Agent::FITNESS_COACH);
        $this->switchOff(Agent::SECRETARY);
        Automation::query()->delete();

        $automation = Automation::create([
            'name' => 'Morning greeting',
            'time' => '06:30',
            'intent' => 'Say good morning.',
            'context' => ['agenda', 'weather', 'training', 'deadlines'],
            'enabled' => true,
        ]);
        $this->mock(ClaudeService::class)->shouldReceive('turn')->once()->andReturn($this->reply('Good morning, Sir.'));

        app(AutomationRunner::class)->run($automation);

        $automation->refresh();
        $this->assertSame(Automation::OK, $automation->last_outcome, (string) $automation->last_error);

        $text = Conversation::find($automation->last_conversation_id)->messages()->first()->content[0]['text'];
        $this->assertStringContainsString("Today's agenda:", $text);
        $this->assertStringContainsString("This week's training:", $text);
        $this->assertStringNotContainsString('Unknown tool', $text);
    }

    public function test_a_write_parked_before_its_agent_went_off_can_still_be_decided(): void
    {
        // The Anthropic switch's rule: a card must never strand a thread.
        $conversation = Conversation::create(['title' => 'Chat']);
        $action = AgentAction::create([
            'conversation_id' => $conversation->id,
            'tool_use_id' => 'toolu_parked',
            'tool' => 'create_exercise',
            'input' => ['name' => 'Landmine press'],
            'requires_confirmation' => true,
            'status' => AgentAction::PENDING,
        ]);

        $this->switchOff(Agent::FITNESS_COACH);

        $decided = app(AgentRunner::class)->decide($action, true);

        $this->assertSame(AgentAction::APPROVED, $decided->status);
        $this->assertStringNotContainsString('Unknown tool', (string) $decided->result);
    }
}
