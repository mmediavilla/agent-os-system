<?php

namespace Tests\Feature\Agent;

use App\Agent\RunOutcome;
use App\Agent\Support\Instructions;
use App\Http\Controllers\VoiceTurnController;
use App\Models\AgentRun;
use App\Models\Conversation;
use App\Models\ConversationMessage;
use App\Services\AnthropicSwitch;
use App\Services\ClaudeService;
use App\Services\Facts\FactsBlock;
use App\Services\Facts\FactWriter;
use Illuminate\Foundation\Testing\RefreshDatabase;
use RuntimeException;
use Tests\TestCase;

/**
 * `POST /api/voice/turn` — the spoken half of the same assistant.
 *
 * Two properties carry this endpoint, and both are asserted here rather than
 * left to the wiring:
 *
 * - **It cannot write.** Not because it refuses to, but because the writing
 *   tools are never put in front of the model. A spoken sentence has no
 *   approval card in front of it, so a tool that would take effect on being
 *   called has no business being offered.
 * - **It shares the thread.** The turn lands in the conversation the HUD is
 *   showing, which is what makes one transcript and one audit log out of
 *   speaking and typing — and is why a spoken turn takes a run row despite not
 *   being queued.
 */
class VoiceTurnTest extends TestCase
{
    use RefreshDatabase;

    /** @var list<array<string, mixed>> the tool schemas the model was offered */
    private array $offered = [];

    /** The system prompt the model was sent, from the last turn taken. */
    private string $prompt = '';

    /**
     * Script the model's turns, remembering what it was handed.
     *
     * The arguments are the point of this test class as much as the answers
     * are: what a voice turn *cannot* do is decided by the third of them.
     *
     * @param  list<array<string, mixed>>  $turns
     */
    private function script(array $turns): void
    {
        $remaining = $turns;

        $this->mock(ClaudeService::class)
            ->shouldReceive('turn')
            ->andReturnUsing(function (string $system, array $messages, array $tools = []) use (&$remaining) {
                $this->prompt = $system;
                $this->offered = $tools;

                return array_shift($remaining);
            });
    }

    private function says(string $text): array
    {
        return [
            'content' => [['type' => 'text', 'text' => $text]],
            'stop_reason' => 'end_turn',
            'usage' => ['input_tokens' => 1, 'output_tokens' => 1,
                'cache_read_input_tokens' => null, 'cache_creation_input_tokens' => null],
            'model' => 'claude-sonnet-5',
        ];
    }

    private function callsListWorkouts(): array
    {
        return [
            'content' => [[
                'type' => 'tool_use',
                'id' => 'toolu_voice_1',
                'name' => 'list_workouts',
                'input' => ['limit' => 5],
            ]],
            'stop_reason' => 'tool_use',
            'usage' => ['input_tokens' => 1, 'output_tokens' => 1,
                'cache_read_input_tokens' => null, 'cache_creation_input_tokens' => null],
            'model' => 'claude-sonnet-5',
        ];
    }

    private function callsLogWorkout(): array
    {
        return [
            'content' => [[
                'type' => 'tool_use',
                'id' => 'toolu_write_1',
                'name' => 'log_workout',
                'input' => [
                    'title' => 'Push Day',
                    'started_at' => '2026-09-01 18:00:00',
                    'exercises' => [[
                        'exercise_title' => 'Bench Press',
                        'sets' => [['set_type' => 'normal', 'weight_kg' => 100, 'reps' => 8]],
                    ]],
                ],
            ]],
            'stop_reason' => 'tool_use',
            'usage' => ['input_tokens' => 1, 'output_tokens' => 1,
                'cache_read_input_tokens' => null, 'cache_creation_input_tokens' => null],
            'model' => 'claude-sonnet-5',
        ];
    }

    // ── answering ─────────────────────────────────────────────────────────────

    public function test_a_spoken_question_is_answered_in_the_same_request(): void
    {
        // Synchronous, unlike the typed path: the caller is a tool call blocked
        // on this response, and has nowhere to watch a run from. So the answer
        // is in the body, not a run id.
        $this->script([$this->says('Four sessions last week, Sir.')]);

        $this->postJson('/api/voice/turn', ['message' => 'How was last week?'])
            ->assertOk()
            ->assertJsonPath('text', 'Four sessions last week, Sir.')
            ->assertJsonStructure(['text', 'conversation_id']);
    }

    public function test_a_spoken_answer_knows_what_is_on_file_about_the_owner(): void
    {
        // Voice gets no change of its own for facts: it builds its prompt with
        // the same method as typing, so this is what keeps it that way.
        app(FactWriter::class)->remember('food', 'pork', 'does not eat it');
        $this->script([$this->says('Noted, Sir.')]);

        $this->postJson('/api/voice/turn', ['message' => 'What should I cook tonight?'])->assertOk();

        $this->assertStringContainsString(Instructions::SPOKEN, $this->prompt);
        $this->assertStringEndsWith(FactsBlock::render(), $this->prompt);
        $this->assertStringContainsString('- food / pork: does not eat it', $this->prompt);
    }

    public function test_it_lands_in_the_conversation_it_is_given(): void
    {
        $this->script([$this->says('Nothing on today, Sir.')]);

        $conversation = Conversation::create([]);

        $this->postJson('/api/voice/turn', [
            'message' => 'What is on today?',
            'conversation_id' => $conversation->id,
        ])->assertOk()->assertJsonPath('conversation_id', $conversation->id);

        // Speaking and typing share one transcript, which is the whole point of
        // passing the id: the question and the answer are in the thread the HUD
        // is already showing.
        $messages = $conversation->messages()->get();
        $this->assertCount(2, $messages);
        $this->assertSame(ConversationMessage::USER, $messages[0]->role);
        $this->assertSame('What is on today?', $messages[0]->content[0]['text']);
        $this->assertSame(ConversationMessage::ASSISTANT, $messages[1]->role);
    }

    public function test_a_thread_that_no_longer_exists_gets_a_new_one_rather_than_a_404(): void
    {
        $this->script([$this->says('Certainly, Sir.')]);

        // The only way to send a stale id is for the HUD to name a thread that
        // has since been deleted, and "conversation not found" is no use read
        // out loud. A fresh thread and the new id in the response is.
        $response = $this->postJson('/api/voice/turn', [
            'message' => 'Hello',
            'conversation_id' => 4242,
        ])->assertOk();

        $this->assertNotSame(4242, $response->json('conversation_id'));
        $this->assertDatabaseCount('conversations', 1);
    }

    public function test_a_new_thread_is_named_after_what_was_said(): void
    {
        $this->script([$this->says('Certainly, Sir.')]);

        $this->postJson('/api/voice/turn', ['message' => 'How many sets of squats last week?'])->assertOk();

        $this->assertNotNull(Conversation::sole()->title);
    }

    public function test_an_answer_with_no_prose_in_it_still_says_something(): void
    {
        // Dead air is the one thing a voice call cannot do. Rare, but the
        // alternative is handing the agent an empty string to read.
        $this->script([[
            'content' => [],
            'stop_reason' => 'end_turn',
            'usage' => ['input_tokens' => 1, 'output_tokens' => 1,
                'cache_read_input_tokens' => null, 'cache_creation_input_tokens' => null],
            'model' => 'claude-sonnet-5',
        ]]);

        $this->postJson('/api/voice/turn', ['message' => '...'])
            ->assertOk()
            ->assertJsonPath('text', VoiceTurnController::NOTHING_SAID);
    }

    public function test_a_message_is_required(): void
    {
        $this->postJson('/api/voice/turn', [])->assertStatus(422);
    }

    // ── read-only ─────────────────────────────────────────────────────────────

    public function test_the_writing_tools_are_never_offered(): void
    {
        $this->script([$this->says('Four sessions, Sir.')]);

        $this->postJson('/api/voice/turn', ['message' => 'How was last week?'])->assertOk();

        // The reads, in registration order, and nothing else. Asserted as a
        // list rather than by "contains no writes", because the point is that
        // this is a *smaller registry* and not a filter applied later.
        $this->assertSame([
            'get_fitness_stats',
            'list_workouts',
            'get_workout',
            'search_exercises',
            'list_equipment',
            'list_events',
            'get_weather',
            'search_documents',
            'list_deadlines',
            'get_news',
            'list_pinned_articles',
        ], array_column($this->offered, 'name'));
    }

    public function test_a_read_still_runs(): void
    {
        $this->script([$this->callsListWorkouts(), $this->says('Nothing logged yet, Sir.')]);

        $this->postJson('/api/voice/turn', ['message' => 'What have I logged?'])
            ->assertOk()
            ->assertJsonPath('text', 'Nothing logged yet, Sir.');

        $this->assertDatabaseHas('agent_actions', [
            'tool' => 'list_workouts',
            'requires_confirmation' => false,
        ]);
    }

    public function test_a_write_the_model_asks_for_anyway_cannot_land(): void
    {
        // It has not been told about `log_workout` and should not call it. If
        // it does, the tool is not in this registry, so the call comes back as
        // an error the model is shown — and nothing is written.
        $this->script([$this->callsLogWorkout(), $this->says('That has to be typed, Sir.')]);

        $this->postJson('/api/voice/turn', ['message' => 'Log four sets of bench.'])->assertOk();

        $this->assertDatabaseCount('workouts', 0);
        $this->assertDatabaseHas('agent_actions', ['tool' => 'log_workout', 'is_error' => true]);

        // And no approval card either: a gated action is one this registry
        // could perform, and it cannot.
        $this->assertSame(0, Conversation::sole()->pendingActions()->count());
    }

    public function test_the_prompt_says_it_cannot_write_and_will_be_heard(): void
    {
        $this->script([$this->says('Certainly, Sir.')]);

        $this->postJson('/api/voice/turn', ['message' => 'Hello'])->assertOk();

        $this->assertStringContainsString(Instructions::SPOKEN, $this->prompt);
        $this->assertStringContainsString('not one of them writes', $this->prompt);

        // The typed path's gate paragraph would be describing a mechanism this
        // caller does not have.
        $this->assertStringNotContainsString('are proposed to the', $this->prompt);

        // And it is still the same assistant.
        $this->assertStringStartsWith('You are a highly capable personal AI butler.', trim($this->prompt));
    }

    // ── the switch, and sharing a thread ──────────────────────────────────────

    public function test_the_kill_switch_stops_it_before_anything_is_stored(): void
    {
        AnthropicSwitch::set(false);

        $this->postJson('/api/voice/turn', ['message' => 'How was last week?'])
            ->assertStatus(503);

        // Off has to mean off for voice as well, or the AI OFF chip is a lie —
        // and refusing before the write means the thread is untouched.
        $this->assertDatabaseCount('conversations', 0);
        $this->assertDatabaseCount('agent_runs', 0);
    }

    public function test_it_takes_a_run_row_and_gives_it_back(): void
    {
        $this->script([$this->says('Four sessions, Sir.')]);

        $this->postJson('/api/voice/turn', ['message' => 'How was last week?'])->assertOk();

        $run = AgentRun::sole();
        $this->assertSame(AgentRun::TRIGGER_VOICE, $run->trigger);
        $this->assertSame(RunOutcome::COMPLETED, $run->status);
        $this->assertNotNull($run->finished_at);

        // Finished means finished: a row left `running` would make the thread
        // look busy forever and refuse the next thing anyone typed into it.
        $this->assertTrue($run->isFinished());
    }

    public function test_it_refuses_while_a_typed_run_is_still_going(): void
    {
        $conversation = Conversation::create([]);

        AgentRun::create([
            'conversation_id' => $conversation->id,
            'trigger' => AgentRun::TRIGGER_MESSAGE,
            'status' => AgentRun::RUNNING,
        ]);

        // Two loops appending to one transcript is not confusion, it is a
        // request the API refuses — and the one it refuses is the *next* one.
        $this->postJson('/api/voice/turn', [
            'message' => 'And what about squats?',
            'conversation_id' => $conversation->id,
        ])->assertStatus(409)->assertJsonStructure(['message']);

        $this->assertSame(0, $conversation->messages()->count());
    }

    public function test_a_voice_run_whose_request_died_does_not_lock_the_thread(): void
    {
        $this->script([$this->says('Your dentist is at three, Sir.')]);
        $conversation = Conversation::create([]);

        // What a PHP fatal leaves behind: the request that opened the run was
        // killed before it could finish it, so the row still says `running`.
        $stranded = AgentRun::create([
            'conversation_id' => $conversation->id,
            'trigger' => AgentRun::TRIGGER_VOICE,
            'status' => AgentRun::RUNNING,
            'started_at' => now()->subSeconds(AgentRun::VOICE_MAX_SECONDS + 31),
        ]);

        $this->postJson('/api/voice/turn', [
            'message' => 'What is on today?',
            'conversation_id' => $conversation->id,
        ])->assertOk()->assertJsonPath('text', 'Your dentist is at three, Sir.');

        $stranded->refresh();
        $this->assertSame(AgentRun::FAILED, $stranded->status);
        $this->assertNotNull($stranded->finished_at);
    }

    public function test_a_voice_run_still_inside_its_time_limit_is_still_busy(): void
    {
        $conversation = Conversation::create([]);

        AgentRun::create([
            'conversation_id' => $conversation->id,
            'trigger' => AgentRun::TRIGGER_VOICE,
            'status' => AgentRun::RUNNING,
            'started_at' => now()->subSeconds(20),
        ]);

        // Twenty seconds in is an answer on its way, not a dead request.
        $this->postJson('/api/voice/turn', [
            'message' => 'And tomorrow?',
            'conversation_id' => $conversation->id,
        ])->assertStatus(409);
    }

    public function test_a_stranded_typed_run_is_not_released_by_the_voice_rule(): void
    {
        $conversation = Conversation::create([]);

        // A queued run lives on the worker, which has no time limit of this
        // kind. Its age says nothing about whether it is still going.
        AgentRun::create([
            'conversation_id' => $conversation->id,
            'trigger' => AgentRun::TRIGGER_MESSAGE,
            'status' => AgentRun::RUNNING,
            'started_at' => now()->subHour(),
        ]);

        $this->postJson('/api/voice/turn', [
            'message' => 'Anything today?',
            'conversation_id' => $conversation->id,
        ])->assertStatus(409);
    }

    public function test_it_refuses_while_a_write_is_waiting_to_be_decided(): void
    {
        $this->script([$this->callsLogWorkout()]);

        $conversation = Conversation::create([]);

        // Parked from the typed side: the transcript now ends with an
        // unanswered `tool_use`, and anything appended to it is a request the
        // API rejects outright.
        $this->postJson("/api/agent/conversations/{$conversation->id}/messages", ['message' => 'log push day'])
            ->assertAccepted();

        $this->postJson('/api/voice/turn', [
            'message' => 'How was last week?',
            'conversation_id' => $conversation->id,
        ])->assertStatus(409)->assertJsonPath('message', VoiceTurnController::PARKED);

        // Refused before a run was opened, so there is no `failed` row for
        // something that never started.
        $this->assertSame(1, AgentRun::query()->count());
    }

    public function test_a_failed_model_call_is_a_502_and_a_failed_run(): void
    {
        $this->mock(ClaudeService::class)
            ->shouldReceive('turn')
            ->andThrow(new RuntimeException('upstream exploded'));

        $this->postJson('/api/voice/turn', ['message' => 'How was last week?'])
            ->assertStatus(502)
            ->assertJsonStructure(['message']);

        // Reported on the run, which is the only place the reason can live —
        // and terminal, so the thread is usable again immediately.
        $run = AgentRun::sole();
        $this->assertSame(AgentRun::FAILED, $run->status);
        $this->assertStringContainsString('upstream exploded', (string) $run->error);
        $this->assertTrue($run->isFinished());
    }
}
