<?php

namespace Tests\Feature\Agent;

use App\Agent\RunOutcome;
use App\Agent\ToolRegistry;
use App\Jobs\RunAgentTurn;
use App\Models\AgentRun;
use App\Models\AgentRunEvent;
use App\Models\Conversation;
use App\Services\ClaudeService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Tests\TestCase;

/**
 * What a queued run tells a client while it works.
 *
 * The events are a *presentation* of the run and never its record — every one
 * of them duplicates something being written to `conversation_messages` or
 * `agent_actions` — so what is worth asserting is not that they exist but that
 * they are **in the right order** and **readable**. Both are easy to lose:
 * deltas are buffered before they are written, and a buffer that survives past
 * the next real event puts the model's answer above the tool call it came from.
 */
class RunEventsTest extends TestCase
{
    use RefreshDatabase;

    /**
     * Script one turn, letting it hand slices to whoever is watching first.
     *
     * @param  list<array{0: string, 1: string}>  $deltas
     */
    private function turnWithDeltas(array $deltas, array $turn): callable
    {
        return function (...$args) use ($deltas, $turn) {
            // Argument 5 is the delta callback — the same position
            // `AgentRunner` passes it in.
            $onDelta = $args[4] ?? null;

            if (is_callable($onDelta)) {
                foreach ($deltas as [$kind, $slice]) {
                    $onDelta($kind, $slice);
                }
            }

            return $turn;
        };
    }

    private function says(string $text): array
    {
        return [
            'content' => [['type' => 'text', 'text' => $text]],
            'stop_reason' => 'end_turn',
            'usage' => [],
            'model' => 'claude-sonnet-5',
        ];
    }

    private function callsListWorkouts(): array
    {
        return [
            'content' => [[
                'type' => 'tool_use',
                'id' => 'toolu_1',
                'name' => 'list_workouts',
                'input' => ['limit' => 3],
            ]],
            'stop_reason' => 'tool_use',
            'usage' => [],
            'model' => 'claude-sonnet-5',
        ];
    }

    /** @return list<AgentRunEvent> */
    private function eventsOf(AgentRun $run): array
    {
        return $run->events()->get()->all();
    }

    private function send(string $message = 'how was last week?'): AgentRun
    {
        $conversation = Conversation::create([]);

        $id = $this->postJson("/api/agent/conversations/{$conversation->id}/messages", ['message' => $message])
            ->assertAccepted()
            ->json('run.id');

        return AgentRun::findOrFail($id);
    }

    public function test_slices_of_one_answer_arrive_as_readable_pieces(): void
    {
        $this->mock(ClaudeService::class)
            ->shouldReceive('turn')
            ->once()
            ->andReturnUsing($this->turnWithDeltas(
                [['text', 'You trained '], ['text', 'four times '], ['text', 'last week.']],
                $this->says('You trained four times last week.'),
            ));

        $run = $this->send();

        $texts = collect($this->eventsOf($run))
            ->where('type', AgentRunEvent::TEXT)
            ->pluck('data.delta');

        // Coalesced rather than one row per slice: a poller asking once a
        // second must not be handed three hundred fragments to reassemble into
        // one paragraph.
        $this->assertSame('You trained four times last week.', $texts->join(''));
        $this->assertLessThan(3, $texts->count());
    }

    public function test_thinking_and_text_are_never_merged_into_one_event(): void
    {
        $this->mock(ClaudeService::class)
            ->shouldReceive('turn')
            ->once()
            ->andReturnUsing($this->turnWithDeltas(
                [['thinking', 'Checking.'], ['text', 'Four.']],
                $this->says('Four.'),
            ));

        $run = $this->send();

        $said = collect($this->eventsOf($run))
            ->whereIn('type', [AgentRunEvent::THINKING, AgentRunEvent::TEXT])
            ->map(fn (AgentRunEvent $e) => [$e->type, $e->data['delta']])
            ->values()
            ->all();

        $this->assertSame([
            [AgentRunEvent::THINKING, 'Checking.'],
            [AgentRunEvent::TEXT, 'Four.'],
        ], $said);
    }

    public function test_what_the_model_said_arrives_before_the_tool_it_then_called(): void
    {
        $this->mock(ClaudeService::class)
            ->shouldReceive('turn')
            ->twice()
            ->andReturnUsing(
                $this->turnWithDeltas([['text', 'Let me check.']], $this->callsListWorkouts()),
                $this->turnWithDeltas([['text', 'Four sessions.']], $this->says('Four sessions.')),
            );

        $run = $this->send();

        $types = array_map(fn (AgentRunEvent $e) => $e->type, $this->eventsOf($run));

        // Buffered deltas are flushed by the next real event rather than
        // whenever they happen to fill up, which is the only thing keeping the
        // narration above the work it narrates.
        $this->assertSame([
            AgentRunEvent::STARTED,
            AgentRunEvent::TEXT,
            AgentRunEvent::TOOL_STARTED,
            AgentRunEvent::TOOL_FINISHED,
            AgentRunEvent::TEXT,
            AgentRunEvent::FINISHED,
        ], $types);
    }

    public function test_a_parked_write_is_announced_and_the_run_stops_there(): void
    {
        $this->mock(ClaudeService::class)->shouldReceive('turn')->once()->andReturn([
            'content' => [[
                'type' => 'tool_use',
                'id' => 'toolu_w',
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
            'usage' => [],
            'model' => 'claude-sonnet-5',
        ]);

        $run = $this->send('log push day');
        $events = collect($this->eventsOf($run));

        // Started, never finished: the write is waiting on a person, and a
        // `tool.finished` here would say it had already happened.
        $this->assertTrue($events->contains('type', AgentRunEvent::TOOL_STARTED));
        $this->assertFalse($events->contains('type', AgentRunEvent::TOOL_FINISHED));

        $awaiting = $events->firstWhere('type', AgentRunEvent::AWAITING);
        $this->assertNotNull($awaiting);
        $this->assertCount(1, $awaiting->data['action_ids']);

        // `awaiting` comes before `run.finished` rather than instead of it, so
        // a client has exactly one event meaning "stop watching".
        $last = $events->last();
        $this->assertSame(AgentRunEvent::FINISHED, $last->type);
        $this->assertSame(RunOutcome::AWAITING_CONFIRMATION, $last->data['status']);
    }

    public function test_a_failed_run_says_so_in_its_closing_event(): void
    {
        $this->mock(ClaudeService::class)
            ->shouldReceive('turn')
            ->once()
            ->andThrow(new \RuntimeException('overloaded'));

        $run = $this->send();
        $last = collect($this->eventsOf($run))->last();

        // Reported as a normal end of stream, not by dropping the connection:
        // a client cannot tell a silent stream from a slow one.
        $this->assertSame(AgentRunEvent::FINISHED, $last->type);
        $this->assertSame(AgentRun::FAILED, $last->data['status']);
        $this->assertStringContainsString('overloaded', $last->data['error']);
    }

    public function test_a_run_whose_conversation_is_gone_does_nothing(): void
    {
        $conversation = Conversation::create([]);

        $run = AgentRun::create([
            'conversation_id' => $conversation->id,
            'trigger' => AgentRun::TRIGGER_MESSAGE,
            'status' => AgentRun::QUEUED,
        ]);

        $conversation->delete();

        // No model is mocked, so reaching one at all would fail the test.
        (new RunAgentTurn($run->id))->handle(app(ClaudeService::class), app(ToolRegistry::class));

        $this->assertDatabaseCount('agent_runs', 0);
    }

    public function test_a_run_that_is_no_longer_queued_is_not_started_twice(): void
    {
        $conversation = Conversation::create([]);

        $run = AgentRun::create([
            'conversation_id' => $conversation->id,
            'trigger' => AgentRun::TRIGGER_MESSAGE,
            'status' => AgentRun::RUNNING,
        ]);

        (new RunAgentTurn($run->id))->handle(app(ClaudeService::class), app(ToolRegistry::class));

        $this->assertSame(AgentRun::RUNNING, $run->refresh()->status);
        $this->assertSame(0, $run->events()->count());
    }

    public function test_a_run_that_no_longer_exists_does_nothing(): void
    {
        (new RunAgentTurn((string) Str::uuid()))->handle(app(ClaudeService::class), app(ToolRegistry::class));

        $this->assertDatabaseCount('agent_run_events', 0);
    }
}
