<?php

namespace Tests\Feature\Agent;

use App\Agent\RunOutcome;
use App\Models\AgentAction;
use App\Models\AgentRun;
use App\Models\AgentRunEvent;
use App\Models\Conversation;
use App\Models\ConversationMessage;
use App\Services\ClaudeService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\URL;
use Illuminate\Support\Str;
use Tests\TestCase;

/**
 * The chat surface: `/api/agent/conversations` and the confirmation gate.
 *
 * These routes can spend money and, once a write is approved, change data — but
 * they are reached by the app's own Chat screen, which has no credential to
 * present, so the thing standing between a language model and the database here
 * is the confirmation gate rather than the perimeter. Both halves of that are
 * asserted below.
 *
 * `auth()` is still sent on most calls: harmless extra headers, and they keep
 * the diff against the token-gated era readable.
 */
class ConversationApiTest extends TestCase
{
    use RefreshDatabase;

    private const TOKEN = 'test-agent-token';

    protected function setUp(): void
    {
        parent::setUp();

        config(['agent.token' => self::TOKEN]);
    }

    private function auth(): array
    {
        return ['Authorization' => 'Bearer '.self::TOKEN];
    }

    /** @param  list<array<string, mixed>>  $turns */
    private function script(array $turns): void
    {
        $this->mock(ClaudeService::class)
            ->shouldReceive('turn')
            ->times(count($turns))
            ->andReturn(...$turns);
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

    private function callsLogWorkout(): array
    {
        return [
            'content' => [[
                'type' => 'tool_use',
                'id' => 'toolu_1',
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

    /** A read, so it runs without asking anyone — the ordinary case for a tool call. */
    private function callsListWorkouts(): array
    {
        return [
            'content' => [[
                'type' => 'tool_use',
                'id' => 'toolu_read_1',
                'name' => 'list_workouts',
                'input' => ['limit' => 5],
            ]],
            'stop_reason' => 'tool_use',
            'usage' => ['input_tokens' => 1, 'output_tokens' => 1,
                'cache_read_input_tokens' => null, 'cache_creation_input_tokens' => null],
            'model' => 'claude-sonnet-5',
        ];
    }

    // ── the perimeter ─────────────────────────────────────────────────────────

    public function test_the_chat_routes_do_not_require_the_agent_token(): void
    {
        // Asserted rather than left implicit: the Expo app carries no token and
        // cannot be given one without inlining it into the web bundle, so a
        // token check re-added to this group would take the Chat screen down and
        // look, from the server side, exactly like the gate working.
        $this->getJson('/api/agent/conversations')->assertOk();
        $this->postJson('/api/agent/conversations')->assertCreated();
    }

    public function test_the_chat_routes_work_with_no_token_configured_at_all(): void
    {
        // AGENT_API_TOKEN is only needed by `/api/mcp`. A checkout that never
        // sets one must still be able to open the Chat screen.
        config(['agent.token' => null]);

        $this->getJson('/api/agent/conversations')->assertOk();
    }

    // ── conversations ─────────────────────────────────────────────────────────

    public function test_store_creates_an_untitled_conversation(): void
    {
        $this->postJson('/api/agent/conversations', [], $this->auth())
            ->assertCreated()
            ->assertJsonPath('title', null)
            ->assertJsonStructure(['id', 'title', 'created_at']);
    }

    public function test_index_lists_most_recently_active_first(): void
    {
        Conversation::create(['title' => 'Older', 'last_message_at' => now()->subDay()]);
        Conversation::create(['title' => 'Newer', 'last_message_at' => now()]);

        $this->getJson('/api/agent/conversations', $this->auth())
            ->assertOk()
            ->assertJsonPath('data.0.title', 'Newer')
            ->assertJsonPath('data.1.title', 'Older');
    }

    public function test_show_returns_the_transcript(): void
    {
        $this->script([$this->says('Four sessions.')]);
        $conversation = Conversation::create([]);

        $this->postJson("/api/agent/conversations/{$conversation->id}/messages",
            ['message' => 'how was last week?'], $this->auth())->assertAccepted();

        $this->getJson("/api/agent/conversations/{$conversation->id}", $this->auth())
            ->assertOk()
            ->assertJsonCount(2, 'messages')
            ->assertJsonPath('messages.1.text', 'Four sessions.')
            ->assertJsonPath('pending_actions', [])
            // Nothing is still running, so there is nothing to reattach to.
            ->assertJsonPath('run', null);
    }

    public function test_destroy_removes_the_conversation(): void
    {
        $conversation = Conversation::create([]);

        $this->deleteJson("/api/agent/conversations/{$conversation->id}", [], $this->auth())
            ->assertNoContent();

        $this->assertDatabaseCount('conversations', 0);
    }

    public function test_a_missing_conversation_is_a_404(): void
    {
        $this->getJson('/api/agent/conversations/9999', $this->auth())->assertNotFound();
    }

    // ── messages ──────────────────────────────────────────────────────────────

    public function test_a_message_is_accepted_and_queues_a_run(): void
    {
        $this->script([$this->says('You trained four times.')]);
        $conversation = Conversation::create([]);

        $this->postJson("/api/agent/conversations/{$conversation->id}/messages",
            ['message' => 'how was last week?'], $this->auth())
            ->assertAccepted()
            // 202 says the work was taken, not done. Under QUEUE_CONNECTION=sync
            // it is in fact already done by the time this returns, which is why
            // a terminal status is assertable here at all — in production the
            // client would see `queued` and watch.
            ->assertJsonPath('run.status', RunOutcome::COMPLETED)
            ->assertJsonPath('run.finished', true)
            // The typed turn is handed straight back, so the client can swap its
            // optimistic bubble for the stored row without waiting for the run.
            ->assertJsonPath('message.role', 'user')
            ->assertJsonPath('message.text', 'how was last week?')
            ->assertJsonPath('conversation.title', 'how was last week?');

        $this->getJson("/api/agent/conversations/{$conversation->id}", $this->auth())
            ->assertJsonPath('messages.1.text', 'You trained four times.');
    }

    public function test_a_second_message_while_a_run_is_still_going_is_a_409(): void
    {
        $conversation = Conversation::create([]);

        // A run left `running` is what a real second send collides with: the
        // first one is mid-loop, not parked on a confirmation, so the pending
        // action check would let this through.
        AgentRun::create([
            'conversation_id' => $conversation->id,
            'trigger' => AgentRun::TRIGGER_MESSAGE,
            'status' => AgentRun::RUNNING,
        ]);

        $this->postJson("/api/agent/conversations/{$conversation->id}/messages",
            ['message' => 'and another thing'], $this->auth())
            ->assertStatus(409)
            ->assertJsonPath('run.status', AgentRun::RUNNING);

        // Refused before anything was written, so the transcript is untouched.
        $this->assertDatabaseCount('conversation_messages', 0);
    }

    public function test_a_message_is_required(): void
    {
        $conversation = Conversation::create([]);

        $this->postJson("/api/agent/conversations/{$conversation->id}/messages", [], $this->auth())
            ->assertUnprocessable()
            ->assertJsonValidationErrors('message');
    }

    public function test_a_failed_model_call_fails_the_run_and_keeps_the_user_turn(): void
    {
        $this->mock(ClaudeService::class)
            ->shouldReceive('turn')
            ->once()
            ->andThrow(new \RuntimeException('overloaded'));

        $conversation = Conversation::create([]);

        // The request itself succeeded — it accepted the message. Where a
        // blocking call answered 502, the failure now belongs to the run, which
        // is the only thing still around to report it.
        $this->postJson("/api/agent/conversations/{$conversation->id}/messages",
            ['message' => 'hi'], $this->auth())
            ->assertAccepted()
            ->assertJsonPath('run.status', AgentRun::FAILED)
            ->assertJsonPath('run.error', fn ($v) => str_contains((string) $v, 'Claude call failed'));

        // The message the user typed is not lost with the call that failed.
        $this->assertDatabaseCount('conversation_messages', 1);

        // And the run is finished rather than left running, so a client
        // watching it is told to stop rather than waiting forever.
        $this->assertTrue(AgentRun::sole()->isFinished());
    }

    public function test_thinking_blocks_are_stored_but_not_returned(): void
    {
        $this->script([[
            'content' => [
                ['type' => 'thinking', 'thinking' => '', 'signature' => 'sig-1'],
                ['type' => 'text', 'text' => 'Hello.'],
            ],
            'stop_reason' => 'end_turn',
            'usage' => ['input_tokens' => 1, 'output_tokens' => 1,
                'cache_read_input_tokens' => null, 'cache_creation_input_tokens' => null],
            'model' => 'claude-sonnet-5',
        ]]);

        $conversation = Conversation::create([]);

        $this->postJson("/api/agent/conversations/{$conversation->id}/messages",
            ['message' => 'hi'], $this->auth())->assertAccepted();

        $response = $this->getJson("/api/agent/conversations/{$conversation->id}", $this->auth());

        $this->assertSame(['text'], array_column($response->json('messages.1.content'), 'type'));

        // Dropped from the response only. Removing one from storage would break
        // the next request that follows a tool call.
        $stored = $conversation->messages()->get()[1]->content;
        $this->assertSame(['thinking', 'text'], array_column($stored, 'type'));
    }

    // ── the confirmation gate ─────────────────────────────────────────────────

    public function test_a_proposed_write_comes_back_as_a_pending_action(): void
    {
        $this->script([$this->callsLogWorkout()]);
        $conversation = Conversation::create([]);

        $this->postJson("/api/agent/conversations/{$conversation->id}/messages",
            ['message' => 'log push day'], $this->auth())
            ->assertAccepted()
            ->assertJsonPath('run.status', RunOutcome::AWAITING_CONFIRMATION);

        $this->getJson("/api/agent/conversations/{$conversation->id}", $this->auth())
            ->assertJsonCount(1, 'pending_actions')
            ->assertJsonPath('pending_actions.0.tool', 'log_workout')
            ->assertJsonPath('pending_actions.0.requires_confirmation', true);

        $this->assertDatabaseCount('workouts', 0);
    }

    public function test_sending_again_while_a_write_is_undecided_is_a_409(): void
    {
        $this->script([$this->callsLogWorkout()]);
        $conversation = Conversation::create([]);

        $this->postJson("/api/agent/conversations/{$conversation->id}/messages",
            ['message' => 'log push day'], $this->auth())->assertAccepted();

        $this->postJson("/api/agent/conversations/{$conversation->id}/messages",
            ['message' => 'never mind'], $this->auth())
            ->assertStatus(409)
            ->assertJsonCount(1, 'pending_actions');
    }

    public function test_approving_lands_the_write_and_returns_the_continuation(): void
    {
        $this->script([$this->callsLogWorkout(), $this->says('Logged Push Day.')]);
        $conversation = Conversation::create([]);

        $this->postJson("/api/agent/conversations/{$conversation->id}/messages",
            ['message' => 'log push day'], $this->auth())->assertAccepted();

        $action = AgentAction::sole();

        // The decision itself is made in this request — an approved write runs
        // here, not in the queued continuation — so the workout exists by the
        // time the response is written even though the reply does not.
        $this->postJson("/api/agent/actions/{$action->id}", ['decision' => 'approve'], $this->auth())
            ->assertAccepted()
            ->assertJsonPath('action.status', AgentAction::APPROVED)
            ->assertJsonPath('run.trigger', AgentRun::TRIGGER_RESUME)
            ->assertJsonPath('run.status', RunOutcome::COMPLETED);

        $this->assertDatabaseHas('workouts', ['title' => 'Push Day']);

        $this->getJson("/api/agent/conversations/{$conversation->id}", $this->auth())
            ->assertJsonPath('messages.3.text', 'Logged Push Day.');
    }

    public function test_declining_writes_nothing_and_still_continues(): void
    {
        $this->script([$this->callsLogWorkout(), $this->says('Understood, nothing logged.')]);
        $conversation = Conversation::create([]);

        $this->postJson("/api/agent/conversations/{$conversation->id}/messages",
            ['message' => 'log push day'], $this->auth())->assertAccepted();

        $this->postJson('/api/agent/actions/'.AgentAction::sole()->id,
            ['decision' => 'reject'], $this->auth())
            ->assertAccepted()
            ->assertJsonPath('action.status', AgentAction::REJECTED);

        $this->assertDatabaseCount('workouts', 0);

        $this->getJson("/api/agent/conversations/{$conversation->id}", $this->auth())
            ->assertJsonPath('messages.3.text', 'Understood, nothing logged.');
    }

    public function test_a_second_decision_on_the_same_action_changes_nothing(): void
    {
        $this->script([$this->callsLogWorkout(), $this->says('Logged Push Day.')]);
        $conversation = Conversation::create([]);

        $this->postJson("/api/agent/conversations/{$conversation->id}/messages",
            ['message' => 'log push day'], $this->auth())->assertAccepted();

        $action = AgentAction::sole();
        $this->postJson("/api/agent/actions/{$action->id}", ['decision' => 'approve'], $this->auth())
            ->assertAccepted();

        $before = ConversationMessage::count();

        // A double-tapped button must not write twice, and must not look like a
        // failure either — `times()` on the mock asserts it costs no model call.
        // The second decision still queues a run, and that run correctly finds
        // nothing parked and stops without asking the model anything.
        $this->postJson("/api/agent/actions/{$action->id}", ['decision' => 'approve'], $this->auth())
            ->assertAccepted()
            ->assertJsonPath('run.status', RunOutcome::COMPLETED);

        $this->assertDatabaseCount('workouts', 1);
        $this->assertSame($before, ConversationMessage::count());
    }

    public function test_a_decision_must_be_approve_or_reject(): void
    {
        $this->script([$this->callsLogWorkout()]);
        $conversation = Conversation::create([]);

        $this->postJson("/api/agent/conversations/{$conversation->id}/messages",
            ['message' => 'log push day'], $this->auth())->assertAccepted();

        $this->postJson('/api/agent/actions/'.AgentAction::sole()->id,
            ['decision' => 'maybe'], $this->auth())
            ->assertUnprocessable()
            ->assertJsonValidationErrors('decision');
    }

    // ── watching a run ────────────────────────────────────────────────────────

    public function test_a_run_reports_what_it_did_as_events(): void
    {
        $this->script([$this->callsListWorkouts(), $this->says('Four sessions.')]);
        $conversation = Conversation::create([]);

        $runId = $this->postJson("/api/agent/conversations/{$conversation->id}/messages",
            ['message' => 'how was last week?'], $this->auth())
            ->assertAccepted()
            ->json('run.id');

        $response = $this->getJson("/api/agent/runs/{$runId}", $this->auth())->assertOk();

        $types = array_column($response->json('events'), 'type');

        $this->assertSame(AgentRunEvent::STARTED, $types[0]);
        $this->assertContains(AgentRunEvent::TOOL_STARTED, $types);
        $this->assertContains(AgentRunEvent::TOOL_FINISHED, $types);
        $this->assertSame(AgentRunEvent::FINISHED, end($types));

        // Monotonic and gapless from 1, which is what makes `after` a resume
        // token rather than a guess.
        $this->assertSame(
            range(1, count($types)),
            array_column($response->json('events'), 'seq'),
        );
    }

    public function test_a_run_can_be_read_from_where_a_client_left_off(): void
    {
        $this->script([$this->says('Four sessions.')]);
        $conversation = Conversation::create([]);

        $runId = $this->postJson("/api/agent/conversations/{$conversation->id}/messages",
            ['message' => 'hi'], $this->auth())->json('run.id');

        $all = $this->getJson("/api/agent/runs/{$runId}", $this->auth())->json('events');
        $rest = $this->getJson("/api/agent/runs/{$runId}?after=1", $this->auth())->json('events');

        $this->assertSame(array_slice($all, 1), $rest);
        $this->assertSame([], $this->getJson("/api/agent/runs/{$runId}?after=999", $this->auth())->json('events'));
    }

    public function test_the_stream_replays_the_log_as_server_sent_events(): void
    {
        $this->script([$this->says('Four sessions.')]);
        $conversation = Conversation::create([]);

        $runId = $this->postJson("/api/agent/conversations/{$conversation->id}/messages",
            ['message' => 'hi'], $this->auth())->json('run.id');

        // The run has already finished — sync queue — so the stream drains what
        // is there, sees `run.finished`, and closes rather than polling.
        $response = $this->get(URL::signedRoute('agent.runs.stream', ['run' => $runId]));

        $response->assertOk();
        $this->assertStringStartsWith('text/event-stream', (string) $response->headers->get('Content-Type'));
        // Without this nginx buffers the whole response and delivers it at the
        // end, which is indistinguishable from streaming not working at all.
        $this->assertSame('no', $response->headers->get('X-Accel-Buffering'));

        $body = $response->streamedContent();

        $this->assertStringContainsString('event: '.AgentRunEvent::STARTED, $body);
        $this->assertStringContainsString('event: '.AgentRunEvent::FINISHED, $body);
        $this->assertStringContainsString('id: 1', $body);
    }

    public function test_a_missing_run_is_a_404(): void
    {
        $this->getJson('/api/agent/runs/'.Str::uuid())->assertNotFound();
    }

    public function test_deciding_an_action_that_does_not_exist_is_a_404(): void
    {
        // Plainly 404, where this used to be 401 for every id alike. The token
        // check that made a real action indistinguishable from an imaginary one
        // is gone from this route, and with it the existence oracle it was
        // hiding — there is no longer a perimeter for an id to leak across.
        $this->postJson('/api/agent/actions/9999', ['decision' => 'approve'])
            ->assertNotFound();
    }
}
