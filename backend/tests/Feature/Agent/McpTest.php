<?php

namespace Tests\Feature\Agent;

use App\Agent\Mcp\JsonRpc;
use App\Agent\Mcp\McpServer;
use App\Agent\ToolRegistry;
use App\Models\Workout;
use App\Models\WorkoutSet;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Testing\TestResponse;
use Tests\TestCase;

/**
 * The MCP endpoint, over HTTP.
 *
 * Two things are being protected here. The protocol contract — a host that
 * cannot complete `initialize` never gets as far as calling a tool, and the
 * failure looks like nothing at all from the app's side. And the gate: these
 * routes let a language model write to the real database, so "no token means no
 * access" is asserted before anything else.
 */
class McpTest extends TestCase
{
    use RefreshDatabase;

    private const TOKEN = 'test-agent-token';

    protected function setUp(): void
    {
        parent::setUp();

        config(['agent.token' => self::TOKEN]);
    }

    /** POST one JSON-RPC message with a valid token. */
    private function rpc(string $method, array $params = [], string|int|null $id = 1): TestResponse
    {
        $message = array_filter([
            'jsonrpc' => '2.0',
            'id' => $id,
            'method' => $method,
            'params' => $params ?: null,
        ], fn ($v) => $v !== null);

        return $this->withToken(self::TOKEN)->postJson('/api/mcp', $message);
    }

    /** The `result` object of a successful call. */
    private function callResult(string $method, array $params = []): array
    {
        return $this->rpc($method, $params)->assertOk()->json('result');
    }

    // ── The gate ──────────────────────────────────────────────────────────────

    public function test_a_request_with_no_token_is_rejected(): void
    {
        $this->postJson('/api/mcp', ['jsonrpc' => '2.0', 'id' => 1, 'method' => 'tools/list'])
            ->assertStatus(401)
            ->assertHeader('WWW-Authenticate', 'Bearer');
    }

    public function test_a_request_with_the_wrong_token_is_rejected(): void
    {
        $this->withToken('not-the-token')
            ->postJson('/api/mcp', ['jsonrpc' => '2.0', 'id' => 1, 'method' => 'tools/list'])
            ->assertStatus(401);
    }

    public function test_an_unconfigured_server_closes_the_route_rather_than_opening_it(): void
    {
        // The failure mode worth designing against: a blank line in `.env`
        // turning a write-capable endpoint into an anonymous one.
        config(['agent.token' => null]);

        $this->postJson('/api/mcp', ['jsonrpc' => '2.0', 'id' => 1, 'method' => 'tools/list'])
            ->assertStatus(503);
    }

    public function test_the_endpoint_is_rate_limited(): void
    {
        config(['agent.rate_limit' => 2]);

        $this->rpc('ping')->assertOk();
        $this->rpc('ping')->assertOk();
        $this->rpc('ping')->assertStatus(429);
    }

    public function test_the_throttle_applies_before_the_token_is_checked(): void
    {
        config(['agent.rate_limit' => 1]);

        $this->postJson('/api/mcp', ['jsonrpc' => '2.0', 'id' => 1, 'method' => 'ping'])->assertStatus(401);
        $this->postJson('/api/mcp', ['jsonrpc' => '2.0', 'id' => 1, 'method' => 'ping'])->assertStatus(429);
    }

    public function test_the_fitness_api_is_left_ungated(): void
    {
        // The gate is on the agent group alone; adding it to the `api` group
        // would lock out the Expo app, which carries no token.
        $this->getJson('/api/workouts')->assertOk();
    }

    // ── initialize ────────────────────────────────────────────────────────────

    public function test_initialize_announces_the_server(): void
    {
        $result = $this->callResult('initialize', ['protocolVersion' => McpServer::PROTOCOL_VERSION]);

        $this->assertSame(McpServer::PROTOCOL_VERSION, $result['protocolVersion']);
        $this->assertSame(['tools' => ['listChanged' => false]], $result['capabilities']);
        $this->assertSame(McpServer::SERVER_NAME, $result['serverInfo']['name']);
        $this->assertSame(McpServer::SERVER_VERSION, $result['serverInfo']['version']);
        $this->assertStringContainsString('get_fitness_stats', $result['instructions']);
    }

    public function test_initialize_answers_in_a_supported_older_revision(): void
    {
        $this->assertSame(
            '2024-11-05',
            $this->callResult('initialize', ['protocolVersion' => '2024-11-05'])['protocolVersion']
        );
    }

    public function test_initialize_offers_its_own_revision_for_an_unknown_one(): void
    {
        $this->assertSame(
            McpServer::PROTOCOL_VERSION,
            $this->callResult('initialize', ['protocolVersion' => '1999-01-01'])['protocolVersion']
        );
    }

    public function test_the_initialized_notification_is_accepted_and_not_answered(): void
    {
        // No `id`, so by the spec there is no response — 202 with an empty body,
        // not an empty 200 the host would try to parse.
        $this->withToken(self::TOKEN)
            ->postJson('/api/mcp', ['jsonrpc' => '2.0', 'method' => 'notifications/initialized'])
            ->assertStatus(202)
            ->assertNoContent(202);
    }

    // ── tools/list ────────────────────────────────────────────────────────────

    public function test_tools_list_covers_the_whole_registry_in_order(): void
    {
        $tools = $this->callResult('tools/list')['tools'];

        $this->assertSame(
            array_keys(app(ToolRegistry::class)->all()),
            array_column($tools, 'name')
        );
    }

    public function test_tools_list_renames_the_schema_key_for_mcp(): void
    {
        // The one difference between the Messages API's shape and MCP's. Getting
        // it wrong leaves every tool with no arguments the host can validate.
        foreach ($this->callResult('tools/list')['tools'] as $tool) {
            $this->assertArrayHasKey('inputSchema', $tool);
            $this->assertArrayNotHasKey('input_schema', $tool);
            $this->assertSame('object', $tool['inputSchema']['type']);
            $this->assertNotSame('', $tool['description']);
        }
    }

    public function test_only_the_read_tools_are_advertised_as_read_only(): void
    {
        $registry = app(ToolRegistry::class);

        foreach ($this->callResult('tools/list')['tools'] as $tool) {
            $this->assertSame(
                ! $registry->isMutating($tool['name']),
                $tool['annotations']['readOnlyHint'],
                "{$tool['name']} advertises the wrong readOnlyHint"
            );
        }
    }

    // ── tools/call ────────────────────────────────────────────────────────────

    public function test_calling_a_read_tool_returns_its_encoded_result(): void
    {
        $workout = $this->makeWorkout(['title' => 'Push Day']);
        WorkoutSet::create([
            'workout_id' => $workout->id,
            'exercise_title' => 'Bench Press',
            'set_index' => 0,
            'set_type' => 'normal',
            'weight_kg' => 100,
            'reps' => 5,
        ]);

        $result = $this->callResult('tools/call', ['name' => 'list_workouts', 'arguments' => ['limit' => 5]]);

        $this->assertFalse($result['isError']);
        $this->assertSame('text', $result['content'][0]['type']);

        $payload = json_decode($result['content'][0]['text'], true);
        $this->assertSame('Push Day', $payload['workouts'][0]['title']);
    }

    public function test_arguments_may_be_omitted_entirely(): void
    {
        $result = $this->callResult('tools/call', ['name' => 'list_equipment']);

        $this->assertFalse($result['isError']);
    }

    public function test_a_write_tool_writes_because_mcp_hosts_run_their_own_gate(): void
    {
        // No confirmation gate on this path, by design: an MCP host prompts the
        // user itself. The Laravel-side gate belongs to the custom loop.
        $this->callResult('tools/call', ['name' => 'log_workout', 'arguments' => [
            'title' => 'Pull Day',
            'started_at' => '2026-09-01 18:00:00',
            'exercises' => [[
                'exercise_title' => 'Deadlift',
                'sets' => [['set_type' => 'normal', 'weight_kg' => 140, 'reps' => 5]],
            ]],
        ]]);

        $this->assertSame('Pull Day', Workout::sole()->title);
    }

    public function test_a_tool_that_rejects_its_input_reports_a_failed_call_not_a_failed_request(): void
    {
        // `isError` inside a 200 is how the model sees its mistake and retries.
        // A 500 would end the conversation instead.
        $result = $this->callResult('tools/call', ['name' => 'get_workout', 'arguments' => ['id' => 'not-an-id']]);

        $this->assertTrue($result['isError']);
        $this->assertStringContainsString('id', $result['content'][0]['text']);
    }

    public function test_a_tool_that_finds_nothing_reports_a_failed_call(): void
    {
        $result = $this->callResult('tools/call', ['name' => 'get_workout', 'arguments' => ['id' => 9999]]);

        $this->assertTrue($result['isError']);
    }

    public function test_an_unknown_tool_is_a_protocol_error(): void
    {
        // Not `isError`: the host asked for something that was never in
        // tools/list, and there is nothing for the model to correct.
        $this->rpc('tools/call', ['name' => 'delete_everything'])
            ->assertOk()
            ->assertJsonPath('error.code', JsonRpc::INVALID_PARAMS);
    }

    public function test_tools_call_without_a_name_is_a_protocol_error(): void
    {
        $this->rpc('tools/call', ['arguments' => []])
            ->assertOk()
            ->assertJsonPath('error.code', JsonRpc::INVALID_PARAMS);
    }

    // ── Framing ───────────────────────────────────────────────────────────────

    public function test_ping_is_answered_with_an_empty_result(): void
    {
        $this->rpc('ping')->assertOk()->assertJsonPath('result', []);
    }

    public function test_an_unknown_method_is_method_not_found(): void
    {
        $this->rpc('resources/list')
            ->assertOk()
            ->assertJsonPath('error.code', JsonRpc::METHOD_NOT_FOUND)
            ->assertJsonPath('id', 1);
    }

    public function test_a_string_id_comes_back_unchanged(): void
    {
        // Hosts number their requests however they like; echoing the id back in
        // the wrong type is how a client loses track of which reply is which.
        $this->rpc('ping', [], 'req-7')->assertOk()->assertJsonPath('id', 'req-7');
    }

    public function test_a_body_that_is_not_json_is_a_parse_error(): void
    {
        // `call()` does not apply the headers `withToken()` records, so the
        // token goes in by hand here.
        $this->call('POST', '/api/mcp', [], [], [], [
            'CONTENT_TYPE' => 'application/json',
            'HTTP_ACCEPT' => 'application/json',
            'HTTP_AUTHORIZATION' => 'Bearer '.self::TOKEN,
        ], '{"jsonrpc":')->assertStatus(400);
    }

    public function test_a_message_missing_the_jsonrpc_version_is_an_invalid_request(): void
    {
        $this->withToken(self::TOKEN)
            ->postJson('/api/mcp', ['id' => 1, 'method' => 'ping'])
            ->assertJsonPath('error.code', JsonRpc::INVALID_REQUEST);
    }

    public function test_a_batch_is_refused_in_words(): void
    {
        // Batching left MCP in the 2025-06-18 revision. Saying so beats
        // answering a list with a complaint about it not being an object.
        $this->withToken(self::TOKEN)
            ->postJson('/api/mcp', [['jsonrpc' => '2.0', 'id' => 1, 'method' => 'ping']])
            ->assertStatus(400)
            ->assertJsonPath('error.code', JsonRpc::INVALID_REQUEST);
    }

    public function test_a_get_is_refused_because_there_is_no_server_stream(): void
    {
        // How a host is told this server never opens an SSE stream of its own.
        $this->withToken(self::TOKEN)->getJson('/api/mcp')->assertStatus(405);
    }
}
