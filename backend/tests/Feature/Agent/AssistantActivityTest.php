<?php

namespace Tests\Feature\Agent;

use App\Models\AgentAction;
use App\Models\AgentRun;
use App\Models\Conversation;
use App\Models\ConversationMessage;
use App\Models\Insight;
use App\Models\Snapshot;
use App\Services\AnthropicPricing;
use App\Services\AnthropicUsage;
use App\Services\Facts\FactWriter;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

class AssistantActivityTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        // Noon in Manila, 04:00 UTC — the eight hours where a UTC window and the
        // user's own day disagree.
        config(['agent.timezone' => 'Asia/Manila']);
        $this->travelTo(CarbonImmutable::parse('2026-09-18 04:00:00', 'UTC'));
    }

    #[Test]
    public function an_empty_database_is_a_state_of_the_tab_not_an_error(): void
    {
        $this->getJson('/api/assistant/activity')
            ->assertOk()
            ->assertJsonPath('records.conversations', 0)
            ->assertJsonPath('records.last_conversation_at', null)
            ->assertJsonPath('tool_calls', 0)
            ->assertJsonPath('tools', [])
            ->assertJsonPath('tokens', ['input' => 0, 'output' => 0, 'cache_read' => 0, 'cache_write' => 0]);
    }

    #[Test]
    public function the_records_come_from_the_tables(): void
    {
        $conversation = Conversation::create(['last_message_at' => '2026-09-18 03:00:00']);
        $this->message($conversation);
        Insight::create(['domain' => 'fitness', 'kind' => 'weekly_assessment', 'title' => 'Weekly', 'response' => 'Good.']);
        Snapshot::create(['conversation_id' => $conversation->id, 'path' => 'snapshots/a.jpg', 'media_type' => 'image/jpeg', 'bytes' => 1200]);

        $this->getJson('/api/assistant/activity')
            ->assertOk()
            ->assertJsonPath('records.conversations', 1)
            ->assertJsonPath('records.messages', 1)
            ->assertJsonPath('records.insights', 1)
            ->assertJsonPath('records.snapshots', 1)
            ->assertJsonPath('records.last_conversation_at', '2026-09-18T03:00:00+00:00')
            ->assertJsonPath('records.last_insight_at', '2026-09-18T04:00:00+00:00');
    }

    #[Test]
    public function the_week_counts_what_extraction_proposed_and_what_was_kept(): void
    {
        $writer = app(FactWriter::class);

        $kept = $writer->propose('food', 'coffee', 'Black.');
        $writer->keep($kept);
        $writer->reject($writer->propose('food', 'tea', 'Green.'));
        $writer->propose('work', 'employer', 'A hospital.');
        // Typed by the owner: on file, but not the extractor's doing.
        $writer->remember('home', 'city', 'Manila.');

        // Proposed and kept before the window: neither counts.
        $this->travelTo(CarbonImmutable::parse('2026-09-01 04:00:00', 'UTC'));
        $writer->keep($writer->propose('hobby', 'basketball', 'Weekends.'));
        $this->travelBack();
        $this->travelTo(CarbonImmutable::parse('2026-09-18 04:00:00', 'UTC'));

        $this->getJson('/api/assistant/activity')
            ->assertOk()
            ->assertJsonPath('records.facts', 3)
            ->assertJsonPath('facts', ['proposed' => 3, 'kept' => 1]);
    }

    #[Test]
    public function the_window_is_the_users_week_not_utcs(): void
    {
        $conversation = Conversation::create([]);

        // Six days back on the user's clock: in.
        $this->agentRun($conversation, 'completed', '2026-09-12 04:00:00');
        // 01:00 on the window's first Manila day, which is still the day before
        // in UTC — in, and the case a UTC window would drop.
        $this->agentRun($conversation, 'completed', '2026-09-11 17:00:00');
        // Seven days and an hour back: out.
        $this->agentRun($conversation, 'completed', '2026-09-11 03:00:00');

        $this->getJson('/api/assistant/activity')
            ->assertOk()
            ->assertJsonPath('window.days', 7)
            ->assertJsonPath('window.timezone', 'Asia/Manila')
            ->assertJsonPath('window.since', '2026-09-12T00:00:00+08:00')
            ->assertJsonPath('runs.completed', 2);
    }

    #[Test]
    public function every_run_status_has_a_key_and_an_unknown_one_is_dropped(): void
    {
        $conversation = Conversation::create([]);
        $this->agentRun($conversation, 'failed', '2026-09-17 10:00:00');
        $this->agentRun($conversation, 'something_else', '2026-09-17 10:00:00');

        $this->assertSame([
            'queued' => 0,
            'running' => 0,
            'completed' => 0,
            'awaiting_confirmation' => 0,
            'max_iterations' => 0,
            'failed' => 1,
        ], $this->getJson('/api/assistant/activity')->assertOk()->json('runs'));
    }

    #[Test]
    public function approvals_count_only_calls_that_needed_one(): void
    {
        $conversation = Conversation::create([]);

        // A read is born approved; it is not a write anybody waved through.
        $this->action($conversation, 'get_fitness_stats', gated: false, status: AgentAction::APPROVED);
        $this->action($conversation, 'log_workout', gated: true, status: AgentAction::APPROVED);
        $this->action($conversation, 'update_workout', gated: true, status: AgentAction::REJECTED);
        $this->action($conversation, 'get_fitness_stats', gated: false, status: AgentAction::APPROVED, error: true);

        $this->getJson('/api/assistant/activity')
            ->assertOk()
            ->assertJsonPath('tool_calls', 4)
            ->assertJsonPath('tool_errors', 1)
            ->assertJsonPath('gated', ['approved' => 1, 'rejected' => 1, 'pending' => 0])
            ->assertJsonPath('tools.0', ['tool' => 'get_fitness_stats', 'calls' => 2])
            ->assertJsonCount(3, 'tools');
    }

    #[Test]
    public function tokens_add_every_recorded_call_and_a_call_that_reported_nothing_adds_nothing(): void
    {
        $this->usage(['input_tokens' => 100, 'output_tokens' => 20, 'cache_read_input_tokens' => 1000, 'cache_creation_input_tokens' => 50]);
        $this->usage([]);
        $this->usage(['input_tokens' => 5, 'output_tokens' => 3, 'cache_read_input_tokens' => null, 'cache_creation_input_tokens' => 0]);

        // Outside the window: not this week's spend.
        $this->usage(['input_tokens' => 9999], '2026-09-01 00:00:00');

        $this->getJson('/api/assistant/activity')
            ->assertOk()
            ->assertJsonPath('tokens', ['input' => 105, 'output' => 23, 'cache_read' => 1000, 'cache_write' => 50]);
    }

    #[Test]
    public function spend_prices_each_model_at_its_own_rate(): void
    {
        // Sonnet 5: 1M in at $2, 100k out at $10 = $3.00.
        $this->usage(['input_tokens' => 1_000_000, 'output_tokens' => 100_000], model: 'claude-sonnet-5');
        // Opus 5 through a dated snapshot id: 200k in at $5, 40k out at $25 = $2.00.
        $this->usage(['input_tokens' => 200_000, 'output_tokens' => 40_000], model: 'claude-opus-5-20260801');
        // Cache reads and writes at 0.1x and 1.25x Sonnet input: $0.20 + $2.50.
        $this->usage(['cache_read_input_tokens' => 1_000_000, 'cache_creation_input_tokens' => 1_000_000], model: 'claude-sonnet-5');

        $this->getJson('/api/assistant/activity')
            ->assertOk()
            ->assertJsonPath('spend.usd', 7.7)
            ->assertJsonPath('spend.unpriced_models', [])
            ->assertJsonPath('spend.unpriced_tokens', 0)
            ->assertJsonPath('spend.prices_as_of', AnthropicPricing::AS_OF);
    }

    #[Test]
    public function a_model_the_table_does_not_list_is_named_not_guessed(): void
    {
        $this->usage(['input_tokens' => 1_000_000], model: 'claude-sonnet-5');
        // A different model at a different price, not a snapshot of Opus 5.
        $this->usage(['input_tokens' => 500, 'output_tokens' => 100], model: 'claude-opus-5-5');
        // A call recorded with no model at all.
        $this->usage(['input_tokens' => 7]);
        // Nothing spent: nothing recorded, so nothing to name.
        $this->usage([], model: 'claude-haiku-4-5');

        $response = $this->getJson('/api/assistant/activity')
            ->assertOk()
            ->assertJsonPath('spend.usd', 2)
            ->assertJsonPath('spend.unpriced_tokens', 607);

        $this->assertEqualsCanonicalizing(['claude-opus-5-5', 'unknown'], $response->json('spend.unpriced_models'));
    }

    #[Test]
    public function the_month_is_the_users_calendar_month_and_reaches_past_the_week(): void
    {
        // This week: 1M Sonnet input = $2.
        $this->usage(['input_tokens' => 1_000_000], model: 'claude-sonnet-5');
        // Earlier this month, before the week: 100k Opus output = $2.50.
        $this->usage(['output_tokens' => 100_000], '2026-09-05 00:00:00', 'claude-opus-5');
        // 04:00 on the 1st in Manila is still September there: 1M Sonnet input = $2.
        $this->usage(['input_tokens' => 1_000_000], '2026-08-31 20:00:00', 'claude-sonnet-5');
        // 18:00 on the 31st in Manila is August: not this month.
        $this->usage(['input_tokens' => 9_000_000], '2026-08-31 10:00:00', 'claude-sonnet-5');

        $this->getJson('/api/assistant/activity')
            ->assertOk()
            ->assertJsonPath('spend.usd', 2)
            ->assertJsonPath('spend_month.usd', 6.5)
            ->assertJsonPath('spend_month.since', '2026-09-01T00:00:00+08:00')
            ->assertJsonPath('spend_month.unpriced_models', [])
            // The token totals stay the week's.
            ->assertJsonPath('tokens.input', 1_000_000);
    }

    #[Test]
    public function early_in_a_month_the_week_reaches_back_past_it(): void
    {
        // Noon on 2 October in Manila: the week began on 26 September.
        $this->travelTo(CarbonImmutable::parse('2026-10-02 04:00:00', 'UTC'));

        $this->usage(['input_tokens' => 1_000_000], '2026-09-28 04:00:00', 'claude-sonnet-5');
        $this->usage(['input_tokens' => 500_000], '2026-10-01 04:00:00', 'claude-sonnet-5');

        $this->getJson('/api/assistant/activity')
            ->assertOk()
            ->assertJsonPath('spend.usd', 3)
            ->assertJsonPath('spend_month.usd', 1);
    }

    #[Test]
    public function deleting_a_thread_does_not_take_its_spend_with_it(): void
    {
        // The turn keeps a `usage` of its own; the ledger holds the call.
        $conversation = Conversation::create([]);
        $this->message($conversation, ['input_tokens' => 1_000_000], model: 'claude-sonnet-5');
        $this->usage(['input_tokens' => 1_000_000], model: 'claude-sonnet-5');

        // Counted once while the thread stands, not once a table.
        $this->getJson('/api/assistant/activity')->assertJsonPath('spend_month.usd', 2);

        $this->deleteJson("/api/agent/conversations/{$conversation->id}")->assertSuccessful();
        $this->assertSame(0, ConversationMessage::count());

        $this->getJson('/api/assistant/activity')
            ->assertOk()
            ->assertJsonPath('records.messages', 0)
            ->assertJsonPath('spend.usd', 2)
            ->assertJsonPath('spend_month.usd', 2)
            ->assertJsonPath('tokens.input', 1_000_000);
    }

    #[Test]
    public function an_empty_week_spends_nothing(): void
    {
        $this->getJson('/api/assistant/activity')
            ->assertJsonPath('spend.usd', 0)
            ->assertJsonPath('spend.unpriced_models', [])
            ->assertJsonPath('spend_month.usd', 0);
    }

    #[Test]
    public function it_is_a_handful_of_statements_however_much_there_is(): void
    {
        $conversation = Conversation::create([]);
        foreach (range(1, 5) as $i) {
            $this->agentRun($conversation, 'completed', '2026-09-17 10:00:00');
            $this->action($conversation, "tool_{$i}", gated: false, status: AgentAction::APPROVED);
            $this->message($conversation);
            $this->usage(['input_tokens' => 10], model: 'claude-sonnet-5');
        }

        $statements = 0;
        DB::listen(function () use (&$statements) {
            $statements++;
        });

        $this->getJson('/api/assistant/activity')->assertOk();

        // Records, runs, actions, top tools, one token sum. A card that added an
        // N+1 would blow straight through this.
        $this->assertLessThanOrEqual(6, $statements);
    }

    #[Test]
    public function it_is_not_behind_the_agent_rate_limit(): void
    {
        // That ceiling is for requests that spend money. A tab reading counts
        // must not eat the allowance a message needs.
        config(['agent.rate_limit' => 1]);

        $this->getJson('/api/assistant/activity')->assertOk();
        $this->getJson('/api/assistant/activity')->assertOk();
        $this->getJson('/api/assistant/activity')->assertOk();
    }

    // -- seeding ---------------------------------------------------------------

    private function agentRun(Conversation $conversation, string $status, string $createdAt): void
    {
        AgentRun::create(['conversation_id' => $conversation->id, 'trigger' => 'message', 'status' => $status])
            ->forceFill(['created_at' => $createdAt])
            ->save();
    }

    private function action(Conversation $conversation, string $tool, bool $gated, string $status, bool $error = false): void
    {
        AgentAction::create([
            'conversation_id' => $conversation->id,
            'tool_use_id' => 'toolu_'.uniqid('', true),
            'tool' => $tool,
            'input' => [],
            'requires_confirmation' => $gated,
            'status' => $status,
            'is_error' => $error,
        ]);
    }

    /**
     * One paid call in the ledger, as `ClaudeService` records it.
     *
     * @param  array<string, int|null>  $usage
     */
    private function usage(array $usage, ?string $createdAt = null, ?string $model = null): void
    {
        AnthropicUsage::record($model, $usage);

        if ($createdAt !== null) {
            DB::table(AnthropicUsage::TABLE)
                ->where('id', DB::table(AnthropicUsage::TABLE)->max('id'))
                ->update(['created_at' => $createdAt]);
        }
    }

    /** @param  array<string, int|null>|null  $usage */
    private function message(Conversation $conversation, ?array $usage = null, ?string $createdAt = null, ?string $model = null): void
    {
        $message = ConversationMessage::create([
            'conversation_id' => $conversation->id,
            'role' => 'assistant',
            'content' => [['type' => 'text', 'text' => 'Sir.']],
            'usage' => $usage,
            'model' => $model,
        ]);

        if ($createdAt !== null) {
            $message->forceFill(['created_at' => $createdAt])->save();
        }
    }
}
