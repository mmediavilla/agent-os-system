<?php

namespace Tests\Feature\Settings;

use App\Models\Conversation;
use App\Models\ConversationMessage;
use App\Models\Insight;
use App\Services\AnthropicUsage;
use App\Services\ClaudeService;
use App\Services\Exceptions\AnthropicOutOfCredit;
use GuzzleHttp\Psr7\Response;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use PHPUnit\Framework\Attributes\Test;
use Psr\Http\Client\ClientInterface;
use Psr\Http\Message\RequestInterface;
use Psr\Http\Message\ResponseInterface;
use RuntimeException;
use Tests\TestCase;

/**
 * The ledger of paid calls, as `ClaudeService` writes it.
 *
 * Assistant → Activity prices its spend off these rows, so what matters is that
 * every call that was paid for leaves one, that a call that was not leaves
 * none, and that the ledger can never cost the owner an answer already bought.
 * What the tab does with the rows is `AssistantActivityTest`'s.
 */
class AnthropicUsageTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        config(['services.anthropic.key' => 'test-key']);
    }

    #[Test]
    public function a_one_shot_call_leaves_a_row_with_the_model_that_answered(): void
    {
        $this->travelTo('2026-09-30 12:00:00');

        (new ClaudeService(transport: new UsageTransport(fn () => self::message([
            'input_tokens' => 1200, 'output_tokens' => 80, 'cache_read_input_tokens' => 300, 'cache_creation_input_tokens' => 40,
        ]))))->complete('system', 'the week', model: 'claude-opus-5');

        $row = DB::table(AnthropicUsage::TABLE)->sole();

        // The dated id the API answered with, not the alias that was asked for:
        // it is what the price table is matched against.
        $this->assertSame('claude-opus-5-20260801', $row->model);
        $this->assertSame([1200, 80, 300, 40], [
            (int) $row->input_tokens, (int) $row->output_tokens, (int) $row->cache_read_tokens, (int) $row->cache_write_tokens,
        ]);
        $this->assertSame('2026-09-30 12:00:00', $row->created_at);
    }

    #[Test]
    public function a_streamed_turn_leaves_a_row_with_the_final_output_count(): void
    {
        (new ClaudeService(transport: new UsageTransport(fn () => new Response(200, ['Content-Type' => 'text/event-stream'], self::stream()))))
            ->turn('system', [['role' => 'user', 'content' => 'hi']]);

        $row = DB::table(AnthropicUsage::TABLE)->sole();

        $this->assertSame('claude-sonnet-5', $row->model);
        $this->assertSame(900, (int) $row->input_tokens);
        // `message_start` says 1; `message_delta` carries the real total.
        $this->assertSame(42, (int) $row->output_tokens);
    }

    #[Test]
    public function an_answer_with_no_text_was_still_paid_for(): void
    {
        $claude = new ClaudeService(transport: new UsageTransport(fn () => self::message(
            ['input_tokens' => 500, 'output_tokens' => 9],
            content: [['type' => 'thinking', 'thinking' => 'Hm.', 'signature' => 'sig']],
        )));

        try {
            $claude->complete('system', 'the week');
            $this->fail('A response with no text block must throw.');
        } catch (RuntimeException) {
            // The caller gets nothing; the account was charged all the same.
        }

        $this->assertSame(500, (int) DB::table(AnthropicUsage::TABLE)->sole()->input_tokens);
    }

    #[Test]
    public function a_refused_call_leaves_nothing(): void
    {
        $claude = new ClaudeService(transport: new UsageTransport(fn () => new Response(402, ['Content-Type' => 'application/json'], json_encode([
            'type' => 'error',
            'error' => ['type' => 'billing_error', 'message' => 'Your credit balance is too low to access the Anthropic API.'],
        ]))));

        try {
            $claude->complete('system', 'the week');
            $this->fail('A refused call must throw.');
        } catch (AnthropicOutOfCredit) {
            // Nothing was billed, so there is nothing to price.
        }

        $this->assertSame(0, DB::table(AnthropicUsage::TABLE)->count());
    }

    #[Test]
    public function a_response_that_reported_no_usage_is_not_a_row_of_zeros(): void
    {
        AnthropicUsage::record('claude-sonnet-5', []);
        AnthropicUsage::record('claude-sonnet-5', ['input_tokens' => null, 'output_tokens' => 0]);

        $this->assertSame(0, DB::table(AnthropicUsage::TABLE)->count());
    }

    #[Test]
    public function a_ledger_that_cannot_be_written_never_costs_the_answer(): void
    {
        // A checkout that has the code and not the migration.
        Schema::drop(AnthropicUsage::TABLE);

        $result = (new ClaudeService(transport: new UsageTransport(fn () => self::message(['input_tokens' => 10, 'output_tokens' => 5]))))
            ->complete('system', 'the week');

        $this->assertSame('An insight.', $result['text']);
    }

    #[Test]
    public function the_migration_brings_over_what_the_turns_and_insights_still_hold(): void
    {
        $migration = require database_path('migrations/2026_09_30_000003_create_anthropic_usage_table.php');
        $migration->down();

        $conversation = Conversation::create([]);
        ConversationMessage::create([
            'conversation_id' => $conversation->id, 'role' => 'assistant', 'content' => [['type' => 'text', 'text' => 'Sir.']],
            'model' => 'claude-sonnet-5',
            'usage' => ['input_tokens' => 8000, 'output_tokens' => 120, 'cache_read_input_tokens' => null, 'cache_creation_input_tokens' => 0],
        ])->forceFill(['created_at' => '2026-09-08 13:07:38'])->save();
        // The user's own turn, and a turn whose call reported nothing: neither was a paid call.
        ConversationMessage::create(['conversation_id' => $conversation->id, 'role' => 'user', 'content' => [['type' => 'text', 'text' => 'Hi.']]]);
        ConversationMessage::create(['conversation_id' => $conversation->id, 'role' => 'assistant', 'content' => [], 'usage' => []]);
        Insight::create([
            'domain' => 'fitness', 'kind' => 'weekly_assessment', 'title' => 'Week', 'response' => 'Fine.',
            'model' => 'claude-opus-5', 'usage' => ['input_tokens' => 4000, 'output_tokens' => 900],
        ]);

        $migration->up();

        $rows = DB::table(AnthropicUsage::TABLE)->orderBy('created_at')->get();

        $this->assertCount(2, $rows);
        $this->assertSame(['claude-sonnet-5', 8000, 120, '2026-09-08 13:07:38'], [
            $rows[0]->model, (int) $rows[0]->input_tokens, (int) $rows[0]->output_tokens, $rows[0]->created_at,
        ]);
        $this->assertSame(['claude-opus-5', 4000, 900], [$rows[1]->model, (int) $rows[1]->input_tokens, (int) $rows[1]->output_tokens]);
    }

    /**
     * @param  array<string, int>  $usage
     * @param  list<array<string, mixed>>  $content
     */
    private static function message(array $usage, array $content = [['type' => 'text', 'text' => 'An insight.']]): Response
    {
        return new Response(200, ['Content-Type' => 'application/json'], json_encode([
            'id' => 'msg_1', 'type' => 'message', 'role' => 'assistant', 'model' => 'claude-opus-5-20260801',
            'content' => $content,
            'stop_reason' => 'end_turn', 'stop_sequence' => null,
            'usage' => $usage,
        ]));
    }

    /** One streamed turn that says "hi back". */
    private static function stream(): string
    {
        $events = [
            ['message_start', ['type' => 'message_start', 'message' => [
                'id' => 'msg_1', 'type' => 'message', 'role' => 'assistant', 'model' => 'claude-sonnet-5',
                'content' => [], 'stop_reason' => null, 'stop_sequence' => null,
                'usage' => ['input_tokens' => 900, 'output_tokens' => 1],
            ]]],
            ['content_block_start', ['type' => 'content_block_start', 'index' => 0, 'content_block' => ['type' => 'text', 'text' => '']]],
            ['content_block_delta', ['type' => 'content_block_delta', 'index' => 0, 'delta' => ['type' => 'text_delta', 'text' => 'hi back']]],
            ['content_block_stop', ['type' => 'content_block_stop', 'index' => 0]],
            ['message_delta', ['type' => 'message_delta', 'delta' => ['stop_reason' => 'end_turn', 'stop_sequence' => null], 'usage' => ['output_tokens' => 42]]],
            ['message_stop', ['type' => 'message_stop']],
        ];

        return implode('', array_map(
            fn ($e) => "event: {$e[0]}\ndata: ".json_encode($e[1])."\n\n",
            $events,
        ));
    }
}

/** Stands in for the network with one scripted answer. */
final class UsageTransport implements ClientInterface
{
    /** @param  callable(): ResponseInterface  $respond */
    public function __construct(private $respond) {}

    public function sendRequest(RequestInterface $request): ResponseInterface
    {
        return ($this->respond)();
    }
}
