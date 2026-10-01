<?php

namespace Tests\Feature\Settings;

use Anthropic\Core\Exceptions\BadRequestException;
use App\Http\Controllers\VoiceTurnController;
use App\Models\AgentRun;
use App\Models\Conversation;
use App\Models\Setting;
use App\Services\AnthropicCredit;
use App\Services\AnthropicSwitch;
use App\Services\ClaudeService;
use App\Services\Diagnostics\Checks\AssistantChecks;
use App\Services\Diagnostics\Severity;
use App\Services\Exceptions\AnthropicDisabled;
use App\Services\Exceptions\AnthropicOutOfCredit;
use Carbon\CarbonImmutable;
use GuzzleHttp\Psr7\Request;
use GuzzleHttp\Psr7\Response;
use Illuminate\Foundation\Testing\RefreshDatabase;
use PHPUnit\Framework\Attributes\Test;
use Psr\Http\Client\ClientInterface;
use Psr\Http\Message\RequestInterface;
use Psr\Http\Message\ResponseInterface;
use Tests\TestCase;

/**
 * An empty Anthropic account, as the app finds out about it: a refused call.
 *
 * There is no balance to read, so the whole feature is what one refusal proves
 * and one success disproves. These pin both directions, the three ways a
 * refusal arrives (a 402, the older 400 wording, an `error` event mid-stream),
 * that nothing else is mistaken for one, and every place it is said.
 */
class AnthropicCreditTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        config(['services.anthropic.key' => 'test-key']);
    }

    // ── What counts as a refusal ──────────────────────────────────────────────

    #[Test]
    public function a_402_billing_error_is_out_of_credit_and_says_so_in_words(): void
    {
        $claude = new ClaudeService(transport: new CreditTransport(fn () => self::billing402()));

        try {
            $claude->complete('system', 'the week');
            $this->fail('A refused call must throw.');
        } catch (AnthropicOutOfCredit $e) {
            // The sentence, not the SDK's JSON dump — this is what the chat
            // banner and the insight button show.
            $this->assertSame(AnthropicOutOfCredit::MESSAGE, $e->getMessage());
        }

        $this->assertTrue(AnthropicCredit::exhausted());
    }

    #[Test]
    public function the_older_400_credit_balance_wording_counts_too(): void
    {
        $claude = new ClaudeService(transport: new CreditTransport(fn () => new Response(400, ['Content-Type' => 'application/json'], json_encode([
            'type' => 'error',
            'error' => ['type' => 'invalid_request_error', 'message' => 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.'],
        ]))));

        $this->expectException(AnthropicOutOfCredit::class);

        try {
            $claude->complete('system', 'the week');
        } finally {
            $this->assertTrue(AnthropicCredit::exhausted());
        }
    }

    #[Test]
    public function a_refusal_part_way_through_a_stream_is_caught_too(): void
    {
        $stream = "event: error\ndata: ".json_encode([
            'type' => 'error',
            'error' => ['type' => 'billing_error', 'message' => 'Your credit balance is too low.'],
        ])."\n\n";

        $claude = new ClaudeService(transport: new CreditTransport(fn () => new Response(200, ['Content-Type' => 'text/event-stream'], $stream)));

        $this->expectException(AnthropicOutOfCredit::class);

        try {
            $claude->turn('system', [['role' => 'user', 'content' => 'hi']]);
        } finally {
            $this->assertTrue(AnthropicCredit::exhausted());
        }
    }

    #[Test]
    public function any_other_bad_request_passes_through_and_flags_nothing(): void
    {
        $claude = new ClaudeService(transport: new CreditTransport(fn () => new Response(400, ['Content-Type' => 'application/json'], json_encode([
            'type' => 'error',
            'error' => ['type' => 'invalid_request_error', 'message' => 'messages: at least one message is required'],
        ]))));

        $this->expectException(BadRequestException::class);

        try {
            $claude->complete('system', 'the week');
        } finally {
            $this->assertFalse(AnthropicCredit::exhausted());
        }
    }

    #[Test]
    public function the_switch_being_off_says_nothing_about_the_balance(): void
    {
        AnthropicCredit::record();
        AnthropicSwitch::set(false);

        try {
            (new ClaudeService(transport: new CreditTransport(fn () => self::ok())))->complete('system', 'the week');
            $this->fail('A switched-off call must throw.');
        } catch (AnthropicDisabled) {
            // Neither cleared (nothing went through) nor re-stamped.
        }

        $this->assertTrue(AnthropicCredit::exhausted());
    }

    // ── How it clears ─────────────────────────────────────────────────────────

    #[Test]
    public function the_next_call_that_goes_through_clears_it(): void
    {
        AnthropicCredit::record();

        $result = (new ClaudeService(transport: new CreditTransport(fn () => self::ok())))->complete('system', 'the week');

        $this->assertSame('An insight.', $result['text']);
        $this->assertFalse(AnthropicCredit::exhausted());
    }

    #[Test]
    public function since_is_the_first_refusal_and_last_refused_moves(): void
    {
        CarbonImmutable::setTestNow('2026-09-29 08:00:00');
        AnthropicCredit::record();

        CarbonImmutable::setTestNow('2026-09-29 09:30:00');
        AnthropicCredit::record();

        $state = AnthropicCredit::state();
        $this->assertTrue($state['exhausted']);
        $this->assertStringStartsWith('2026-09-29T08:00:00', (string) $state['since']);
        $this->assertStringStartsWith('2026-09-29T09:30:00', (string) $state['last_refused_at']);

        CarbonImmutable::setTestNow();
    }

    #[Test]
    public function a_row_of_the_wrong_shape_reads_as_clear(): void
    {
        Setting::put(AnthropicCredit::KEY, true);

        $this->assertFalse(AnthropicCredit::exhausted());
    }

    #[Test]
    public function the_chain_is_searched_not_just_the_top(): void
    {
        $sdk = BadRequestException::from(new Request('POST', 'https://api.anthropic.com/v1/messages'), self::billing402());

        $this->assertTrue(AnthropicCredit::isBillingError(new \RuntimeException('wrapped', 0, $sdk)));
        $this->assertFalse(AnthropicCredit::isBillingError(new \RuntimeException('credit balance')));
    }

    // ── Where it is said ──────────────────────────────────────────────────────

    #[Test]
    public function health_reports_it_without_changing_the_state(): void
    {
        $this->getJson('/api/health')
            ->assertJsonPath('assistant.credit.exhausted', false)
            ->assertJsonPath('assistant.credit.since', null);

        AnthropicCredit::record();

        // Not `down` — the key is fine — and not `off` — nobody chose it.
        $this->getJson('/api/health')
            ->assertJsonPath('assistant.state', 'up')
            ->assertJsonPath('assistant.credit.exhausted', true);
    }

    #[Test]
    public function a_typed_run_fails_with_the_sentence_and_no_prefix(): void
    {
        $this->mock(ClaudeService::class)
            ->shouldReceive('turn')
            ->once()
            ->andThrow(new AnthropicOutOfCredit);

        $conversation = Conversation::create([]);

        $this->postJson("/api/agent/conversations/{$conversation->id}/messages", ['message' => 'hi'])
            ->assertAccepted()
            ->assertJsonPath('run.status', AgentRun::FAILED)
            ->assertJsonPath('run.error', AnthropicOutOfCredit::MESSAGE);
    }

    #[Test]
    public function a_spoken_turn_is_a_503_the_agent_can_read_out(): void
    {
        $this->mock(ClaudeService::class)
            ->shouldReceive('turn')
            ->andThrow(new AnthropicOutOfCredit);

        $this->postJson('/api/voice/turn', ['message' => 'How was last week?'])
            ->assertStatus(503)
            ->assertJsonPath('message', VoiceTurnController::OUT_OF_CREDIT);

        $this->assertSame(AgentRun::FAILED, AgentRun::sole()->status);
    }

    #[Test]
    public function diagnose_calls_it_a_problem_until_it_clears(): void
    {
        $finding = fn () => collect((new AssistantChecks)->run())->firstWhere('key', 'assistant.credit');

        $this->assertSame(Severity::Ok, $finding()->severity);

        AnthropicCredit::record();

        $this->assertSame(Severity::Problem, $finding()->severity);
        $this->assertStringContainsString('console.anthropic.com', (string) $finding()->manual);
    }

    private static function billing402(): Response
    {
        return new Response(402, ['Content-Type' => 'application/json'], json_encode([
            'type' => 'error',
            'error' => ['type' => 'billing_error', 'message' => 'Your credit balance is too low to access the Anthropic API.'],
        ]));
    }

    private static function ok(): Response
    {
        return new Response(200, ['Content-Type' => 'application/json'], json_encode([
            'id' => 'msg_1', 'type' => 'message', 'role' => 'assistant', 'model' => 'claude-opus-5',
            'content' => [['type' => 'text', 'text' => 'An insight.']],
            'stop_reason' => 'end_turn', 'stop_sequence' => null,
            'usage' => ['input_tokens' => 1, 'output_tokens' => 1],
        ]));
    }
}

/** Stands in for the network with one scripted answer. */
final class CreditTransport implements ClientInterface
{
    /** @param  callable(): ResponseInterface  $respond */
    public function __construct(private $respond) {}

    public function sendRequest(RequestInterface $request): ResponseInterface
    {
        return ($this->respond)();
    }
}
