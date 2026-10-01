<?php

namespace App\Services;

use Anthropic\Client;
use Anthropic\Messages\StopReason;
use Anthropic\Messages\TextBlock;
use App\Agent\Support\StreamAccumulator;
use App\Services\Exceptions\AnthropicOutOfCredit;
use GuzzleHttp\Client as GuzzleClient;
use Psr\Http\Client\ClientInterface;
use RuntimeException;
use Throwable;

/**
 * Thin wrapper around the official anthropic-ai/sdk PHP client.
 *
 * Defaults follow the claude-api skill's guidance:
 *   - model, effort, thinking display: `AssistantSettings` (a saved choice, else .env)
 *   - thinking: adaptive (Claude decides depth)
 *   - effort: configurable; "high" balances quality and token efficiency
 * The frontend never sees the API key — every Claude call goes through Laravel.
 */
class ClaudeService
{
    private ?Client $client = null;

    private ?StreamingTransport $streamingTransport = null;

    public function __construct(
        private readonly ?string $apiKey = null,
        private readonly int $defaultMaxTokens = 1024,
        // A test's stand-in for the network, so the arguments a call was made
        // with can be read back. Null in the app: the SDK finds Guzzle itself.
        private readonly ?ClientInterface $transport = null,
    ) {
        // Constructor intentionally does NOT validate the API key, so the
        // service is safe to inject everywhere. Validation happens lazily in
        // client() so the controller's try/catch can render a clean 502 — and
        // that is where the on/off switch is checked too, for the same reason:
        // it is the one place every paid call has to pass through.
    }

    private function client(): Client
    {
        // Before the memo, not after it. A queue worker lives for an hour and
        // holds this instance the whole time, so a client cached on the first
        // call would keep answering questions the user switched off forty
        // minutes ago.
        AnthropicSwitch::guard();

        if ($this->client) {
            return $this->client;
        }
        $key = $this->apiKey ?? config('services.anthropic.key');
        if (empty($key)) {
            throw new RuntimeException(
                'ANTHROPIC_API_KEY is not set. Add it to backend/.env to enable AI insights.'
            );
        }

        return $this->client = new Client(
            apiKey: $key,
            requestOptions: $this->transport ? ['transporter' => $this->transport] : null,
        );
    }

    /**
     * The transport a streamed turn has to be made on, or null to keep the
     * default.
     *
     * Without it the turn is still correct and arrives all at once, at the end
     * — which is the same thing as not streaming. {@see StreamingTransport}
     * for the four layers involved and which one is at fault.
     *
     * Null when Guzzle is not the installed PSR-18 client, in which case the
     * SDK's own transport is used and the answer arrives whole. Degraded, not
     * broken, and it is not worth a hard dependency to prevent.
     */
    private function streamingTransport(): ?StreamingTransport
    {
        if ($this->transport || ! class_exists(GuzzleClient::class)) {
            return null;
        }

        return $this->streamingTransport ??= new StreamingTransport(new GuzzleClient);
    }

    /**
     * Run one Messages API call and return the response text plus metadata.
     *
     * `$schema` asks for structured output: the text that comes back is JSON
     * matching it. That is how the fact extractor gets rows rather than prose —
     * not a forced tool call, which would mean giving up thinking for it.
     *
     * @param  array<string, mixed>|null  $schema  a JSON schema the answer must match
     * @return array{text: string, usage: array, model: string}
     */
    public function complete(
        string $systemPrompt,
        string $userMessage,
        ?string $model = null,
        ?int $maxTokens = null,
        ?string $effort = null,
        ?array $schema = null,
    ): array {
        $model = $model ?? AssistantSettings::insightModel();
        $maxTokens = $maxTokens ?? (int) config('services.anthropic.max_tokens', $this->defaultMaxTokens);
        $effort = $effort ?? AssistantSettings::effort();

        $response = $this->billed(fn () => $this->client()->messages->create(
            model: $model,
            maxTokens: $maxTokens,
            system: $systemPrompt,
            thinking: ['type' => 'adaptive'],
            outputConfig: ['effort' => $effort] + ($schema === null ? [] : [
                'format' => ['type' => 'json_schema', 'schema' => $schema],
            ]),
            messages: [
                ['role' => 'user', 'content' => $userMessage],
            ],
        ));

        $usage = [
            'input_tokens' => $response->usage->inputTokens ?? null,
            'output_tokens' => $response->usage->outputTokens ?? null,
            'cache_read_input_tokens' => $response->usage->cacheReadInputTokens ?? null,
            'cache_creation_input_tokens' => $response->usage->cacheCreationInputTokens ?? null,
        ];

        // Before the text is looked for: a response with no text block throws
        // below, and it was paid for all the same.
        AnthropicUsage::record($response->model ?? $model, $usage);

        // content is a polymorphic array: ThinkingBlock(s) may precede TextBlock.
        // We only surface the text; thinking content is omitted by default on
        // Opus 4.7 anyway (display="omitted").
        $text = '';
        foreach ($response->content as $block) {
            if ($block instanceof TextBlock || (isset($block->type) && $block->type === 'text')) {
                $text = $block->text;
                break;
            }
        }

        if ($text === '') {
            throw new RuntimeException(
                'Claude returned no text block. stop_reason='.self::stopReason($response)
            );
        }

        return [
            'text' => $text,
            'usage' => $usage,
            'model' => $response->model ?? $model,
        ];
    }

    /**
     * One turn of a tool-using conversation.
     *
     * Deliberately added *beneath* `complete()` rather than by reshaping it.
     * `complete()` takes one string and returns one string, `InsightTest` mocks
     * exactly that, and the weekly insight has no use for tools — so its
     * signature and return contract stay byte-identical and no existing test
     * moves.
     *
     * What comes back is the wire shape, not the SDK's objects. Two SDK traps
     * make that the only comfortable boundary: `$response->stopReason` throws
     * (property access is overridden — see `stopReason()` below), and a block
     * rehydrated from snake_case leaves its typed properties uninitialised, so
     * reading `->toolUseID` on a replayed turn fatals. Encoding here means the
     * runner only ever handles plain arrays, in the same shape it stores and
     * replays, and a test can script a sequence of turns without constructing a
     * single SDK object.
     *
     * Events are `json_encode`d and decoded rather than mapped by hand:
     * `SdkModel::jsonSerialize()` already emits wire snake_case regardless of
     * how a block was built, and the API accepts those arrays back verbatim —
     * thinking blocks and their signatures included.
     *
     * **Always streamed, whether or not anyone is watching.** The non-streaming
     * call and the streamed one produce the same turn, so keeping both would be
     * two code paths for one result, and only one of them would ever be
     * exercised by the screen people actually use. `$onDelta` is the difference
     * between a watcher and none, and it changes nothing about what is
     * returned — `StreamAccumulator` reassembles the turn into the same array
     * shape this method has always given back.
     *
     * @param  list<array<string, mixed>>  $messages  wire-shaped turns, oldest first
     * @param  list<array<string, mixed>>  $tools  the `tools` parameter, or [] for none
     * @param  array<string, mixed>|null  $toolChoice  e.g. `['type' => 'none']` to force a final answer
     * @param  (callable(string, string): void)|null  $onDelta  "text" or "thinking", and the slice
     * @return array{content: list<array<string, mixed>>, stop_reason: string, usage: array, model: string}
     */
    public function turn(
        string $systemPrompt,
        array $messages,
        array $tools = [],
        ?array $toolChoice = null,
        ?callable $onDelta = null,
        ?string $model = null,
        ?int $maxTokens = null,
        ?string $effort = null,
    ): array {
        $model = $model ?? AssistantSettings::chatModel();
        // Never the shared `max_tokens`. A turn that emits thinking *and* a tool
        // call needs room for both, and 1024 truncates it mid-JSON — which does
        // not look like a limit, it looks like random tool-call corruption.
        $maxTokens = $maxTokens ?? (int) config('services.anthropic.agent_max_tokens', 8192);
        $effort = $effort ?? AssistantSettings::effort();

        $turn = $this->billed(function () use ($systemPrompt, $messages, $tools, $toolChoice, $onDelta, $model, $maxTokens, $effort) {
            $stream = $this->client()->messages->createStream(
                model: $model,
                maxTokens: $maxTokens,
                system: $systemPrompt,
                // `omitted` streams thinking blocks with nothing in them, which for
                // a model that thinks for eight seconds before its first word looks
                // exactly like a frozen screen. `summarized` is what gives a
                // watcher something true to read in the meantime; the cost is that
                // the summary is stored and re-sent with every later turn, which is
                // why it is a setting rather than a constant.
                thinking: ['type' => 'adaptive', 'display' => AssistantSettings::thinkingDisplay()],
                outputConfig: ['effort' => $effort],
                messages: $messages,
                tools: $tools === [] ? null : $tools,
                toolChoice: $toolChoice,
                requestOptions: array_filter(['transporter' => $this->streamingTransport()]),
            );

            $accumulator = new StreamAccumulator($onDelta);

            foreach ($stream as $event) {
                $decoded = json_decode(json_encode($event) ?: '[]', true);

                if (is_array($decoded)) {
                    $accumulator->push($decoded);
                }
            }

            return $accumulator->result();
        });

        // Here and not where the turn is stored: the stored turn goes when its
        // thread is deleted, and what it cost does not.
        AnthropicUsage::record($turn['model'] ?: $model, $turn['usage']);

        return $turn;
    }

    /**
     * Make one paid call, and keep `AnthropicCredit` true to what it proved.
     *
     * Anthropic refusing to bill is recorded and rethrown in words
     * ({@see AnthropicOutOfCredit}); a call that went through clears the flag,
     * which is how a top-up is noticed without anyone saying so. Every other
     * failure passes through untouched, the switch's refusal included — being
     * switched off says nothing about the balance.
     *
     * A stream can be refused before its first event or part-way through (an
     * `error` event), and both surface from inside the callable, which is why
     * `turn()` iterates in here rather than after it.
     *
     * @template T
     *
     * @param  callable(): T  $call
     * @return T
     */
    private function billed(callable $call): mixed
    {
        try {
            $result = $call();
        } catch (Throwable $e) {
            if (AnthropicCredit::isBillingError($e)) {
                AnthropicCredit::record();

                throw new AnthropicOutOfCredit($e);
            }

            throw $e;
        }

        AnthropicCredit::clear();

        return $result;
    }

    /**
     * Why the model stopped, as a plain string.
     *
     * `$response->stopReason` looks like it would work and does not: the SDK
     * overrides the property and property access throws "the stopReason property
     * is overridden, use the array access ['stopReason'] syntax". Array access
     * then yields a `StopReason` enum, not a string, so `->value` is the last
     * step. This was reached only from the error path above, which meant a call
     * that returned no text raised a confusing SDK exception instead of the
     * message it was trying to build.
     *
     * The agent loop reads the same field on every turn, so it lives here rather
     * than being rediscovered there.
     */
    public static function stopReason(mixed $response): string
    {
        $reason = $response['stopReason'] ?? null;

        return match (true) {
            $reason instanceof StopReason => $reason->value,
            is_string($reason) => $reason,
            default => 'unknown',
        };
    }
}
