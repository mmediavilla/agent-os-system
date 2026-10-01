<?php

namespace Tests\Feature\Settings;

use App\Models\Setting;
use App\Services\AssistantSettings;
use App\Services\ClaudeService;
use GuzzleHttp\Psr7\Response;
use Illuminate\Foundation\Testing\RefreshDatabase;
use PHPUnit\Framework\Attributes\Test;
use Psr\Http\Client\ClientInterface;
use Psr\Http\Message\RequestInterface;
use Psr\Http\Message\ResponseInterface;
use Tests\TestCase;

/**
 * Assistant → Settings' server half: which models answer, how hard they think,
 * how far a message may go. Asserted at the routes and where each takes effect —
 * the request body sent to Anthropic, the health payload — because a setting the
 * worker never reads is decoration. The iteration ceiling and the replay depth
 * are asserted beside their own behaviour, in `AgentRunnerTest` and
 * `SnapshotTest`.
 */
class AssistantSettingsTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        config([
            'services.anthropic.key' => 'test-key',
            'services.anthropic.agent_model' => 'claude-sonnet-5',
            'services.anthropic.model' => 'claude-opus-5',
            'services.anthropic.effort' => 'high',
            'services.anthropic.thinking_display' => 'summarized',
            'agent.max_iterations' => 12,
            'agent.snapshots.replay' => 3,
            'agent.voice.key' => null,
            'agent.voice.agent_id' => 'agent_123',
            'agent.local.enabled' => false,
        ]);
    }

    // ── The routes ────────────────────────────────────────────────────────────

    #[Test]
    public function env_answers_until_someone_chooses(): void
    {
        $this->getJson('/api/settings/assistant')
            ->assertOk()
            ->assertExactJson([
                'models' => ['chat' => 'claude-sonnet-5', 'insight' => 'claude-opus-5'],
                'reasoning' => ['effort' => 'high', 'thinking_display' => 'summarized'],
                'limits' => ['max_iterations' => 12, 'snapshot_replay' => 3],
                'voice' => ['configured' => false, 'agent_configured' => true, 'local_actions' => false],
            ]);
    }

    #[Test]
    public function a_patch_writes_only_what_it_names_and_answers_the_whole_state(): void
    {
        $this->patchJson('/api/settings/assistant', [
            'models' => ['chat' => 'claude-opus-5'],
            'limits' => ['snapshot_replay' => 1],
        ])
            ->assertOk()
            ->assertJsonPath('models.chat', 'claude-opus-5')
            ->assertJsonPath('models.insight', 'claude-opus-5')
            ->assertJsonPath('reasoning.effort', 'high')
            ->assertJsonPath('limits.max_iterations', 12)
            ->assertJsonPath('limits.snapshot_replay', 1);

        $this->assertNull(Setting::find(AssistantSettings::INSIGHT_MODEL));
        $this->assertNull(Setting::find(AssistantSettings::EFFORT));

        $this->patchJson('/api/settings/assistant', ['reasoning' => ['effort' => 'low', 'thinking_display' => 'omitted']])
            ->assertOk()
            ->assertJsonPath('models.chat', 'claude-opus-5')
            ->assertJsonPath('reasoning.effort', 'low')
            ->assertJsonPath('reasoning.thinking_display', 'omitted');
    }

    #[Test]
    public function a_saved_choice_outlives_a_changed_env(): void
    {
        $this->patchJson('/api/settings/assistant', ['limits' => ['max_iterations' => 20]])->assertOk();

        config(['agent.max_iterations' => 6]);

        $this->assertSame(20, AssistantSettings::maxIterations());
    }

    #[Test]
    public function values_outside_their_sets_are_refused(): void
    {
        foreach ([
            ['models' => ['chat' => 'claude-haiku-4-5']],
            ['models' => ['insight' => 'gpt-5']],
            ['reasoning' => ['effort' => 'max']],
            ['reasoning' => ['thinking_display' => 'full']],
            ['limits' => ['max_iterations' => 13]],
            // Zero would send the question without its own picture.
            ['limits' => ['snapshot_replay' => 0]],
            // A string that looks right is still not the integer the set holds.
            ['limits' => ['max_iterations' => '12']],
            ['models' => ['chat' => 'claude-opus-5', 'key' => 'x']],
            [],
            ['voice' => ['configured' => true]],
        ] as $body) {
            $this->patchJson('/api/settings/assistant', $body)->assertUnprocessable();
        }

        $this->assertSame(0, Setting::query()->count());
    }

    #[Test]
    public function a_row_outside_its_set_falls_back_to_env(): void
    {
        Setting::put(AssistantSettings::CHAT_MODEL, 'claude-3-opus');
        Setting::put(AssistantSettings::EFFORT, 'xhigh');
        Setting::put(AssistantSettings::MAX_ITERATIONS, '20');
        Setting::put(AssistantSettings::SNAPSHOT_REPLAY, 0);

        $this->getJson('/api/settings/assistant')
            ->assertJsonPath('models.chat', 'claude-sonnet-5')
            ->assertJsonPath('reasoning.effort', 'high')
            ->assertJsonPath('limits.max_iterations', 12)
            ->assertJsonPath('limits.snapshot_replay', 3);
    }

    #[Test]
    public function the_voice_card_never_carries_the_key(): void
    {
        config(['agent.voice.key' => 'sk_secret_value', 'agent.local.enabled' => true]);

        $response = $this->getJson('/api/settings/assistant')
            ->assertJsonPath('voice.configured', true)
            ->assertJsonPath('voice.local_actions', true);

        $this->assertStringNotContainsString('sk_secret_value', $response->getContent());
    }

    #[Test]
    public function health_reports_the_chat_model_that_will_answer(): void
    {
        Setting::put(AssistantSettings::CHAT_MODEL, 'claude-opus-5');

        $this->getJson('/api/health')->assertJsonPath('assistant.model', 'claude-opus-5');
    }

    // ── Where they take effect ────────────────────────────────────────────────

    #[Test]
    public function a_chat_turn_is_sent_with_the_saved_model_effort_and_display(): void
    {
        AssistantSettings::update([
            'models' => ['chat' => 'claude-opus-5'],
            'reasoning' => ['effort' => 'medium', 'thinking_display' => 'omitted'],
        ]);

        $transport = new RecordingTransport(fn () => new Response(200, ['Content-Type' => 'text/event-stream'], self::stream()));

        $turn = (new ClaudeService(transport: $transport))->turn('system', [['role' => 'user', 'content' => 'hi']]);

        $this->assertSame('hi back', $turn['content'][0]['text']);
        $this->assertSame('claude-opus-5', $transport->body['model']);
        $this->assertSame(['effort' => 'medium'], $transport->body['output_config']);
        $this->assertSame(['type' => 'adaptive', 'display' => 'omitted'], $transport->body['thinking']);
    }

    #[Test]
    public function an_insight_is_written_by_the_saved_insight_model_not_the_chat_one(): void
    {
        AssistantSettings::update([
            'models' => ['chat' => 'claude-opus-5', 'insight' => 'claude-sonnet-5'],
            'reasoning' => ['effort' => 'low'],
        ]);

        $transport = new RecordingTransport(fn () => new Response(200, ['Content-Type' => 'application/json'], json_encode([
            'id' => 'msg_1', 'type' => 'message', 'role' => 'assistant', 'model' => 'claude-sonnet-5',
            'content' => [['type' => 'text', 'text' => 'An insight.']],
            'stop_reason' => 'end_turn', 'stop_sequence' => null,
            'usage' => ['input_tokens' => 1, 'output_tokens' => 1],
        ])));

        $result = (new ClaudeService(transport: $transport))->complete('system', 'the week');

        $this->assertSame('An insight.', $result['text']);
        $this->assertSame('claude-sonnet-5', $transport->body['model']);
        $this->assertSame(['effort' => 'low'], $transport->body['output_config']);
    }

    #[Test]
    public function a_schema_asks_for_structured_output_beside_the_effort(): void
    {
        $transport = new RecordingTransport(fn () => new Response(200, ['Content-Type' => 'application/json'], json_encode([
            'id' => 'msg_1', 'type' => 'message', 'role' => 'assistant', 'model' => 'claude-sonnet-5',
            'content' => [['type' => 'text', 'text' => '{"facts":[]}']],
            'stop_reason' => 'end_turn', 'stop_sequence' => null,
            'usage' => ['input_tokens' => 1, 'output_tokens' => 1],
        ])));
        $schema = ['type' => 'object', 'properties' => ['facts' => ['type' => 'array']], 'required' => ['facts'], 'additionalProperties' => false];

        $result = (new ClaudeService(transport: $transport))->complete('system', 'read this', schema: $schema);

        $this->assertSame('{"facts":[]}', $result['text']);
        $this->assertSame(['type' => 'json_schema', 'schema' => $schema], $transport->body['output_config']['format']);
        $this->assertSame(['type' => 'adaptive'], $transport->body['thinking']);
    }

    #[Test]
    public function an_explicit_argument_still_beats_the_row(): void
    {
        Setting::put(AssistantSettings::CHAT_MODEL, 'claude-opus-5');

        $transport = new RecordingTransport(fn () => new Response(200, ['Content-Type' => 'text/event-stream'], self::stream()));

        (new ClaudeService(transport: $transport))->turn('system', [['role' => 'user', 'content' => 'hi']], model: 'claude-sonnet-5');

        $this->assertSame('claude-sonnet-5', $transport->body['model']);
    }

    /** One streamed turn that says "hi back". */
    private static function stream(): string
    {
        $events = [
            ['message_start', ['type' => 'message_start', 'message' => [
                'id' => 'msg_1', 'type' => 'message', 'role' => 'assistant', 'model' => 'claude-opus-5',
                'content' => [], 'stop_reason' => null, 'stop_sequence' => null,
                'usage' => ['input_tokens' => 1, 'output_tokens' => 1],
            ]]],
            ['content_block_start', ['type' => 'content_block_start', 'index' => 0, 'content_block' => ['type' => 'text', 'text' => '']]],
            ['content_block_delta', ['type' => 'content_block_delta', 'index' => 0, 'delta' => ['type' => 'text_delta', 'text' => 'hi back']]],
            ['content_block_stop', ['type' => 'content_block_stop', 'index' => 0]],
            ['message_delta', ['type' => 'message_delta', 'delta' => ['stop_reason' => 'end_turn', 'stop_sequence' => null], 'usage' => ['output_tokens' => 2]]],
            ['message_stop', ['type' => 'message_stop']],
        ];

        return implode('', array_map(
            fn ($e) => "event: {$e[0]}\ndata: ".json_encode($e[1])."\n\n",
            $events,
        ));
    }
}

/** Stands in for the network and keeps the last request body. */
final class RecordingTransport implements ClientInterface
{
    /** @var array<string, mixed> */
    public array $body = [];

    /** @param  callable(): ResponseInterface  $respond */
    public function __construct(private $respond) {}

    public function sendRequest(RequestInterface $request): ResponseInterface
    {
        $this->body = json_decode((string) $request->getBody(), true) ?? [];

        return ($this->respond)();
    }
}
