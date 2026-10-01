<?php

namespace App\Agent\Mcp;

use App\Agent\Support\Instructions;
use App\Agent\ToolRegistry;

/**
 * The Model Context Protocol, spoken over the tool registry.
 *
 * This is the whole of Phase 2's protocol work, and it is small on purpose: the
 * durable asset is the tool layer, and MCP is a way to point an existing host at
 * it. `initialize` announces the server, `tools/list` hands over the registry,
 * and `tools/call` is `ToolRegistry::run()` wrapped in an envelope.
 *
 * Hand-rolled rather than pulled from `laravel/mcp`, which was still at
 * `v1.0.0-beta.1` when this was written. The four methods below are the entire
 * surface a stateless tool server needs, and a beta dependency in the request
 * path of a write-capable endpoint costs more than it saves.
 *
 * Transport is decided elsewhere (McpController): this class takes a decoded
 * message and returns a decoded reply, so it can be tested without HTTP.
 *
 * ## Deliberately not implemented
 *
 * Sessions (`Mcp-Session-Id`), resources, prompts, sampling, and server-initiated
 * SSE. The server holds no state between calls, so every one of those is a
 * capability it can honestly decline — and capabilities it does not advertise,
 * hosts do not call.
 */
class McpServer
{
    /** The revision this server implements, and what an unrecognised request negotiates down to. */
    public const PROTOCOL_VERSION = '2025-06-18';

    /**
     * Revisions this server can speak, newest first.
     *
     * Negotiation is the spec's: if the client asks for one of these, answer in
     * it; otherwise answer with our own and let the client decide whether it can
     * live with that. The three differ in ways that do not reach a tools-only
     * server, so honouring an older one costs nothing.
     */
    public const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

    public const SERVER_NAME = 'projectmc';

    public const SERVER_VERSION = '1.0.0';

    public function __construct(private readonly ToolRegistry $tools) {}

    /**
     * Handle one decoded JSON-RPC message.
     *
     * Returns null when there is nothing to answer — the message was a
     * notification, which by the spec gets no response at all, not an empty one.
     *
     * @param  array<string, mixed>  $message
     * @return array<string, mixed>|null
     */
    public function handle(array $message): ?array
    {
        $id = $message['id'] ?? null;
        $isNotification = $id === null;

        if (! is_string($id) && ! is_int($id) && $id !== null) {
            return JsonRpc::error(null, JsonRpc::INVALID_REQUEST, 'Request `id` must be a string or a number.');
        }

        if (($message['jsonrpc'] ?? null) !== JsonRpc::VERSION || ! isset($message['method']) || ! is_string($message['method'])) {
            return $isNotification
                ? null
                : JsonRpc::error($id, JsonRpc::INVALID_REQUEST, 'Not a JSON-RPC 2.0 request: `jsonrpc` must be "2.0" and `method` a string.');
        }

        // A notification is fire-and-forget. `notifications/initialized` is the
        // only one a tools-only server sees, and there is nothing for it to do
        // with it — but an unknown notification is equally not an error, so the
        // whole class is swallowed rather than matched one name at a time.
        if ($isNotification) {
            return null;
        }

        $params = is_array($message['params'] ?? null) ? $message['params'] : [];

        return match ($message['method']) {
            'initialize' => JsonRpc::result($id, $this->initialize($params)),
            'ping' => JsonRpc::result($id, []),
            'tools/list' => JsonRpc::result($id, ['tools' => $this->toolDefinitions()]),
            'tools/call' => $this->call($id, $params),
            default => JsonRpc::error($id, JsonRpc::METHOD_NOT_FOUND, "Unknown method: {$message['method']}"),
        };
    }

    /**
     * @param  array<string, mixed>  $params
     * @return array<string, mixed>
     */
    private function initialize(array $params): array
    {
        $requested = $params['protocolVersion'] ?? null;

        return [
            'protocolVersion' => in_array($requested, self::SUPPORTED_VERSIONS, true)
                ? $requested
                : self::PROTOCOL_VERSION,
            // `listChanged: false` is the honest answer: the registry is a static
            // list compiled into the provider, so it cannot change under a
            // connected host and there is no notification to subscribe to.
            'capabilities' => ['tools' => ['listChanged' => false]],
            'serverInfo' => [
                'name' => self::SERVER_NAME,
                'title' => 'ProjectMC Life OS',
                'version' => self::SERVER_VERSION,
            ],
            'instructions' => Instructions::TOOLS,
        ];
    }

    /**
     * The registry, in MCP's shape.
     *
     * Not quite a pass-through: the Messages API names the schema `input_schema`
     * and MCP names it `inputSchema`, so one key is renamed here. That rename is
     * the entire difference between the two wire formats, which is why the same
     * `Tool::schema()` feeds both drivers.
     *
     * `readOnlyHint` is derived from the MutatingTool marker rather than
     * restated, so a write tool cannot advertise itself as safe: the marker is
     * what gates it in the custom loop and what un-checks the box here.
     *
     * @return list<array<string, mixed>>
     */
    private function toolDefinitions(): array
    {
        return array_values(array_map(function (array $schema): array {
            return [
                'name' => $schema['name'],
                'description' => $schema['description'],
                'inputSchema' => $schema['input_schema'],
                'annotations' => ['readOnlyHint' => ! $this->tools->isMutating($schema['name'])],
            ];
        }, $this->tools->schemas()));
    }

    /**
     * @param  array<string, mixed>  $params
     * @return array<string, mixed>
     */
    private function call(string|int|null $id, array $params): array
    {
        $name = $params['name'] ?? null;

        if (! is_string($name) || $name === '') {
            return JsonRpc::error($id, JsonRpc::INVALID_PARAMS, 'tools/call requires a `name`.');
        }

        // An unknown tool is a protocol error, not a failed call: the host asked
        // for something that was never in tools/list, and reporting it as "the
        // tool errored" would invite the model to retry the same missing name.
        if (! $this->tools->has($name)) {
            return JsonRpc::error($id, JsonRpc::INVALID_PARAMS, "Unknown tool: {$name}");
        }

        $arguments = is_array($params['arguments'] ?? null) ? $params['arguments'] : [];

        // A tool that throws is a *successful* protocol exchange reporting a
        // failed call. That distinction is the whole self-correction mechanism:
        // `isError` puts the message in front of the model, which fixes its
        // arguments and calls again, where a JSON-RPC error ends the exchange.
        //
        // How a failure is rendered belongs to the registry, not here: the
        // custom loop shows the model the same text for the same failure, and
        // two copies of that would drift.
        $outcome = $this->tools->attempt($name, $arguments);

        return JsonRpc::result($id, [
            'content' => [['type' => 'text', 'text' => $outcome['text']]],
            'isError' => $outcome['is_error'],
        ]);
    }
}
