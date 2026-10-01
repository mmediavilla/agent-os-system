<?php

namespace Tests\Feature\Agent;

use App\Agent\AgentRunner;
use App\Agent\Exceptions\ConversationBusy;
use App\Agent\RunOutcome;
use App\Models\AgentAction;
use App\Models\Conversation;
use App\Models\ConversationMessage;
use App\Models\Setting;
use App\Models\Workout;
use App\Services\AssistantSettings;
use App\Services\ClaudeService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * The loop, driven by scripted turns.
 *
 * `ClaudeService::turn()` is mocked rather than `complete()` — they are separate
 * methods for exactly this reason, and mocking the wrong one would make these
 * tests pass against a loop that never ran. Each test hands the runner a list of
 * turns to return in order, which is what makes "the model called a write tool"
 * a thing a test can state in one line.
 */
class AgentRunnerTest extends TestCase
{
    use RefreshDatabase;

    /** A turn that just talks. */
    private function says(string $text): array
    {
        return $this->turn([['type' => 'text', 'text' => $text]], 'end_turn');
    }

    /** A turn that calls one tool. */
    private function calls(string $id, string $tool, array $input = []): array
    {
        return $this->turn([['type' => 'tool_use', 'id' => $id, 'name' => $tool, 'input' => $input]], 'tool_use');
    }

    /** @param  list<array<string, mixed>>  $content */
    private function turn(array $content, string $stopReason): array
    {
        return [
            'content' => $content,
            'stop_reason' => $stopReason,
            'usage' => ['input_tokens' => 10, 'output_tokens' => 5,
                'cache_read_input_tokens' => null, 'cache_creation_input_tokens' => null],
            'model' => 'claude-sonnet-5',
        ];
    }

    /**
     * Script the model's side of the conversation, in order.
     *
     * @param  list<array<string, mixed>>  $turns
     */
    private function script(array $turns): void
    {
        $this->mock(ClaudeService::class)
            ->shouldReceive('turn')
            ->times(count($turns))
            ->andReturn(...$turns);
    }

    private function runner(): AgentRunner
    {
        return app(AgentRunner::class);
    }

    private function conversation(): Conversation
    {
        return Conversation::create([]);
    }

    /** A valid log_workout payload, matching WorkoutWriter::RULES. */
    private function workoutPayload(): array
    {
        return [
            'title' => 'Push Day',
            'started_at' => '2026-09-01 18:00:00',
            'exercises' => [[
                'exercise_title' => 'Bench Press',
                'sets' => [['set_type' => 'normal', 'weight_kg' => 100, 'reps' => 8, 'rpe' => 8]],
            ]],
        ];
    }

    // ── the happy path ────────────────────────────────────────────────────────

    public function test_a_plain_answer_stores_both_turns_and_completes(): void
    {
        $this->script([$this->says('You trained four times last week.')]);

        $run = $this->runner()->send($this->conversation(), 'how was last week?');

        $this->assertSame(RunOutcome::COMPLETED, $run->status);
        $this->assertSame('You trained four times last week.', $run->reply());
        $this->assertSame(['user', 'assistant'], $run->conversation->messages()->pluck('role')->all());
    }

    public function test_the_first_message_names_the_conversation(): void
    {
        $this->script([$this->says('ok')]);

        $run = $this->runner()->send($this->conversation(), '  how   was last week?  ');

        $this->assertSame('how was last week?', $run->conversation->fresh()->title);
    }

    public function test_content_is_stored_as_blocks_never_as_a_string(): void
    {
        $this->script([$this->says('ok')]);

        $run = $this->runner()->send($this->conversation(), 'hi');

        $this->assertSame([['type' => 'text', 'text' => 'hi']], $run->conversation->messages()->first()->content);
    }

    public function test_stop_reason_model_and_usage_are_kept_on_the_assistant_turn(): void
    {
        $this->script([$this->says('ok')]);

        $message = $this->runner()->send($this->conversation(), 'hi')->conversation
            ->messages()->where('role', ConversationMessage::ASSISTANT)->first();

        $this->assertSame('end_turn', $message->stop_reason);
        $this->assertSame('claude-sonnet-5', $message->model);
        $this->assertSame(10, $message->usage['input_tokens']);
    }

    public function test_thinking_blocks_round_trip_in_the_order_they_arrived(): void
    {
        // The block order a real turn produced during the Phase 0 spikes:
        // thinking, then text, then the tool call.
        $this->script([
            $this->turn([
                ['type' => 'thinking', 'thinking' => 'let me look', 'signature' => 'sig-1'],
                ['type' => 'text', 'text' => 'Checking your log.'],
                ['type' => 'tool_use', 'id' => 'toolu_1', 'name' => 'list_workouts', 'input' => []],
            ], 'tool_use'),
            $this->says('Four sessions.'),
        ]);

        $run = $this->runner()->send($this->conversation(), 'how was last week?');

        $stored = $run->conversation->messages()->where('role', ConversationMessage::ASSISTANT)->first()->content;

        $this->assertSame(['thinking', 'text', 'tool_use'], array_column($stored, 'type'));
        $this->assertSame('sig-1', $stored[0]['signature']);
    }

    // ── read tools ────────────────────────────────────────────────────────────

    public function test_a_read_tool_runs_without_asking_and_its_result_goes_back(): void
    {
        $this->makeWorkout(['title' => 'Leg Day']);

        $this->script([
            $this->calls('toolu_1', 'list_workouts'),
            $this->says('One session: Leg Day.'),
        ]);

        $run = $this->runner()->send($this->conversation(), 'what have I done?');

        $this->assertSame(RunOutcome::COMPLETED, $run->status);

        $action = AgentAction::sole();
        $this->assertFalse($action->requires_confirmation);
        $this->assertSame(AgentAction::APPROVED, $action->status);
        $this->assertStringContainsString('Leg Day', $action->result);

        // user, assistant(tool_use), user(tool_result), assistant
        $roles = $run->conversation->messages()->pluck('role')->all();
        $this->assertSame(['user', 'assistant', 'user', 'assistant'], $roles);
    }

    public function test_parallel_tool_calls_are_answered_in_a_single_user_message(): void
    {
        $this->script([
            $this->turn([
                ['type' => 'tool_use', 'id' => 'toolu_1', 'name' => 'list_workouts', 'input' => []],
                ['type' => 'tool_use', 'id' => 'toolu_2', 'name' => 'list_equipment', 'input' => []],
            ], 'tool_use'),
            $this->says('done'),
        ]);

        $run = $this->runner()->send($this->conversation(), 'summarise everything');

        $results = $run->conversation->messages()->get()[2];

        // Splitting these across two messages is accepted by the API and teaches
        // the model that parallel calls are not worth making.
        $this->assertSame(ConversationMessage::USER, $results->role);
        $this->assertCount(2, $results->content);
        $this->assertSame(['toolu_1', 'toolu_2'], array_column($results->content, 'tool_use_id'));
    }

    public function test_a_tool_that_rejects_its_input_becomes_an_error_result_not_a_500(): void
    {
        $this->script([
            // `range` is validated against a closed list.
            $this->calls('toolu_1', 'get_fitness_stats', ['range' => 'since-the-dawn-of-time']),
            $this->says('Let me try that differently.'),
        ]);

        $run = $this->runner()->send($this->conversation(), 'how am I doing?');

        $this->assertSame(RunOutcome::COMPLETED, $run->status);

        $action = AgentAction::sole();
        $this->assertTrue($action->is_error);

        $block = $run->conversation->messages()->get()[2]->content[0];
        $this->assertTrue($block['is_error']);
    }

    public function test_an_unknown_tool_name_is_reported_to_the_model_and_writes_nothing(): void
    {
        $this->script([
            $this->calls('toolu_1', 'delete_everything'),
            $this->says('Sorry, I cannot do that.'),
        ]);

        $run = $this->runner()->send($this->conversation(), 'delete it all');

        $action = AgentAction::sole();
        $this->assertTrue($action->is_error);
        $this->assertFalse($action->requires_confirmation);
        $this->assertStringContainsString('Unknown tool', $action->result);
        $this->assertSame(RunOutcome::COMPLETED, $run->status);
    }

    // ── the confirmation gate ─────────────────────────────────────────────────

    public function test_a_write_is_proposed_and_nothing_is_written(): void
    {
        $this->script([$this->calls('toolu_1', 'log_workout', $this->workoutPayload())]);

        $run = $this->runner()->send($this->conversation(), 'log push day');

        $this->assertSame(RunOutcome::AWAITING_CONFIRMATION, $run->status);
        $this->assertCount(1, $run->pendingActions);
        $this->assertDatabaseCount('workouts', 0);

        $action = AgentAction::sole();
        $this->assertTrue($action->requires_confirmation);
        $this->assertSame(AgentAction::PENDING, $action->status);
        $this->assertNull($action->result);

        // The turn that proposed it is stored; its results are not, because
        // there are none yet.
        $this->assertSame(['user', 'assistant'], $run->conversation->messages()->pluck('role')->all());
    }

    public function test_approving_runs_the_write_and_resumes_the_loop(): void
    {
        $this->script([
            $this->calls('toolu_1', 'log_workout', $this->workoutPayload()),
            $this->says('Logged Push Day.'),
        ]);

        $conversation = $this->conversation();
        $this->runner()->send($conversation, 'log push day');

        $this->runner()->decide(AgentAction::sole(), approve: true);
        $resumed = $this->runner()->resume($conversation->refresh());

        $this->assertSame(RunOutcome::COMPLETED, $resumed->status);
        $this->assertSame('Logged Push Day.', $resumed->reply());
        $this->assertDatabaseHas('workouts', ['title' => 'Push Day']);

        $this->assertSame(
            ['user', 'assistant', 'user', 'assistant'],
            $conversation->messages()->pluck('role')->all()
        );
    }

    public function test_declining_writes_nothing_and_tells_the_model_so(): void
    {
        $this->script([
            $this->calls('toolu_1', 'log_workout', $this->workoutPayload()),
            $this->says('No problem, I have not logged it.'),
        ]);

        $conversation = $this->conversation();
        $this->runner()->send($conversation, 'log push day');

        $action = $this->runner()->decide(AgentAction::sole(), approve: false);
        $resumed = $this->runner()->resume($conversation->refresh());

        $this->assertDatabaseCount('workouts', 0);
        $this->assertSame(AgentAction::REJECTED, $action->status);
        $this->assertTrue($action->is_error);
        $this->assertSame(RunOutcome::COMPLETED, $resumed->status);

        $block = $conversation->messages()->get()[2]->content[0];
        $this->assertTrue($block['is_error']);
        $this->assertStringContainsString('declined', $block['content']);
    }

    public function test_approving_twice_cannot_write_twice(): void
    {
        $this->script([$this->calls('toolu_1', 'log_workout', $this->workoutPayload())]);

        $this->runner()->send($this->conversation(), 'log push day');

        $action = AgentAction::sole();
        $this->runner()->decide($action, approve: true);
        $this->runner()->decide($action->fresh(), approve: true);

        $this->assertDatabaseCount('workouts', 1);
    }

    public function test_declining_after_approving_does_not_undo_the_write(): void
    {
        $this->script([$this->calls('toolu_1', 'log_workout', $this->workoutPayload())]);

        $this->runner()->send($this->conversation(), 'log push day');

        $action = AgentAction::sole();
        $this->runner()->decide($action, approve: true);
        $second = $this->runner()->decide($action->fresh(), approve: false);

        // The action was already spent. Reversing the decision would claim to
        // undo something this layer has no way to undo.
        $this->assertSame(AgentAction::APPROVED, $second->status);
        $this->assertDatabaseCount('workouts', 1);
    }

    public function test_reads_beside_a_write_run_immediately_and_survive_the_pause(): void
    {
        $this->makeWorkout(['title' => 'Leg Day']);

        $this->script([
            $this->turn([
                ['type' => 'tool_use', 'id' => 'toolu_1', 'name' => 'list_workouts', 'input' => []],
                ['type' => 'tool_use', 'id' => 'toolu_2', 'name' => 'log_workout', 'input' => $this->workoutPayload()],
            ], 'tool_use'),
            $this->says('Done.'),
        ]);

        $conversation = $this->conversation();
        $run = $this->runner()->send($conversation, 'check then log');

        $this->assertSame(RunOutcome::AWAITING_CONFIRMATION, $run->status);

        $read = AgentAction::where('tool_use_id', 'toolu_1')->sole();
        $this->assertSame(AgentAction::APPROVED, $read->status);
        $this->assertStringContainsString('Leg Day', $read->result);

        $this->runner()->decide(AgentAction::where('tool_use_id', 'toolu_2')->sole(), approve: true);
        $this->runner()->resume($conversation->refresh());

        // Both results come back together, in the order the calls were made.
        $results = $conversation->messages()->get()[2];
        $this->assertSame(['toolu_1', 'toolu_2'], array_column($results->content, 'tool_use_id'));
    }

    public function test_sending_while_a_write_is_undecided_is_refused(): void
    {
        $this->script([$this->calls('toolu_1', 'log_workout', $this->workoutPayload())]);

        $conversation = $this->conversation();
        $this->runner()->send($conversation, 'log push day');

        $this->expectException(ConversationBusy::class);

        // Appending here would leave `toolu_1` unanswered, which the API rejects
        // outright — the conversation would be unusable, not merely confused.
        $this->runner()->send($conversation->refresh(), 'actually, never mind');
    }

    public function test_resuming_a_conversation_with_nothing_parked_costs_nothing(): void
    {
        $this->script([$this->says('All done.')]);

        $conversation = $this->conversation();
        $this->runner()->send($conversation, 'hi');

        // `times()` on the mock is the assertion: a second model call here would
        // be a paid round trip answering a question already answered.
        $run = $this->runner()->resume($conversation->refresh());

        $this->assertSame(RunOutcome::COMPLETED, $run->status);
        $this->assertSame([], $run->messages);
    }

    // ── the ceiling ───────────────────────────────────────────────────────────

    public function test_hitting_the_iteration_ceiling_answers_instead_of_throwing(): void
    {
        config(['agent.max_iterations' => 3]);

        $this->script([
            $this->calls('toolu_1', 'list_workouts'),
            $this->calls('toolu_2', 'list_workouts'),
            $this->calls('toolu_3', 'list_workouts'),
            // The fourth call is the forced answer, made with tools switched off.
            $this->says('I could not finish, but here is what I found.'),
        ]);

        $run = $this->runner()->send($this->conversation(), 'go round in circles');

        $this->assertSame(RunOutcome::MAX_ITERATIONS, $run->status);
        $this->assertSame('I could not finish, but here is what I found.', $run->reply());
    }

    public function test_the_ceiling_saved_in_assistant_settings_beats_env(): void
    {
        config(['agent.max_iterations' => 20]);
        Setting::put(AssistantSettings::MAX_ITERATIONS, 6);

        // Six tool rounds, then the forced answer — never the twentieth call.
        $this->script([
            ...array_map(fn ($i) => $this->calls("toolu_{$i}", 'list_workouts'), range(1, 6)),
            $this->says('Stopped at six.'),
        ]);

        $run = $this->runner()->send($this->conversation(), 'go round in circles');

        $this->assertSame(RunOutcome::MAX_ITERATIONS, $run->status);
        $this->assertSame('Stopped at six.', $run->reply());
    }

    public function test_the_forced_answer_switches_tools_off(): void
    {
        config(['agent.max_iterations' => 1]);

        $toolChoices = [];

        $this->mock(ClaudeService::class)
            ->shouldReceive('turn')
            ->twice()
            ->andReturnUsing(function (...$args) use (&$toolChoices) {
                // Argument 4 is toolChoice.
                $toolChoices[] = $args[3] ?? null;

                return count($toolChoices) === 1
                    ? $this->calls('toolu_1', 'list_workouts')
                    : $this->says('Stopping here.');
            });

        $run = $this->runner()->send($this->conversation(), 'go round in circles');

        $this->assertSame(RunOutcome::MAX_ITERATIONS, $run->status);
        // Left alone while looping, forced off for the last call. Without that
        // the model would just call another tool and the ceiling would buy
        // nothing but one more paid round trip.
        $this->assertSame([null, ['type' => 'none']], $toolChoices);
    }

    // ── durability ────────────────────────────────────────────────────────────

    public function test_the_assistant_turn_is_stored_even_when_its_tool_fatals(): void
    {
        // `update_workout` on a workout that does not exist throws from inside
        // the tool, after the turn that requested it has been persisted.
        $this->script([
            $this->calls('toolu_1', 'get_workout', ['id' => 9999]),
            $this->says('That session does not exist.'),
        ]);

        $run = $this->runner()->send($this->conversation(), 'show me workout 9999');

        $this->assertSame(ConversationMessage::ASSISTANT, $run->conversation->messages()->get()[1]->role);
        $this->assertTrue(AgentAction::sole()->is_error);
    }

    public function test_deleting_a_conversation_leaves_what_the_assistant_wrote(): void
    {
        $this->script([
            $this->calls('toolu_1', 'log_workout', $this->workoutPayload()),
            $this->says('Logged.'),
        ]);

        $conversation = $this->conversation();
        $this->runner()->send($conversation, 'log push day');
        $this->runner()->decide(AgentAction::sole(), approve: true);
        $this->runner()->resume($conversation->refresh());

        $conversation->delete();

        // Deleting the record of a change is not undoing the change.
        $this->assertSame(1, Workout::count());
        $this->assertDatabaseCount('agent_actions', 0);
        $this->assertDatabaseCount('conversation_messages', 0);
    }
}
