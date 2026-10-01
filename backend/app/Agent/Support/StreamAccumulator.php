<?php

namespace App\Agent\Support;

/**
 * Rebuilds one whole assistant turn from the pieces the streaming API sends.
 *
 * The Messages API streams a turn as a sequence of framing events —
 * `message_start`, then a `content_block_start` / `…_delta` / `…_stop` group
 * per block, then `message_delta` and `message_stop`. Nothing in the SDK
 * reassembles them, so this does, and it produces **exactly the array shape
 * `ClaudeService::turn()` has always returned**: content, stop_reason, usage,
 * model. Everything downstream — the runner, the transcript, the replay — is
 * unaware that the turn arrived in pieces.
 *
 * That fidelity is the whole job, and it is stricter than it looks. Thinking
 * blocks carry a `signature` the API requires back byte-identically on the next
 * turn, and a `tool_use` block's `input` arrives as a *string* of partial JSON
 * split at arbitrary boundaries. Both are reassembled here; getting either
 * wrong does not fail loudly, it fails on the following request with a
 * validation error about a block nobody edited.
 *
 * Events arrive as plain arrays in wire shape, not as SDK objects — the same
 * `json_encode`/`json_decode` boundary `turn()` already uses, and for the same
 * reason: a rehydrated SDK block leaves its typed properties uninitialised, so
 * reading them fatals.
 *
 * Blocks are collected by their `index` rather than by arrival order. The two
 * agree today; keying on the index means they do not have to.
 */
final class StreamAccumulator
{
    /** @var array<int, array<string, mixed>> */
    private array $blocks = [];

    /**
     * Partial JSON per block index, for `tool_use` inputs.
     *
     * @var array<int, string>
     */
    private array $partials = [];

    private string $stopReason = 'unknown';

    private string $model = '';

    /** @var array<string, mixed> */
    private array $usage = [];

    /**
     * @param  (callable(string, string): void)|null  $onDelta  called with "text" or
     *                                                          "thinking" and the slice that just arrived
     */
    public function __construct(private $onDelta = null) {}

    /** @param  array<string, mixed>  $event  one wire event, already decoded */
    public function push(array $event): void
    {
        match ($event['type'] ?? '') {
            'message_start' => $this->messageStart($event),
            'content_block_start' => $this->blockStart($event),
            'content_block_delta' => $this->blockDelta($event),
            'content_block_stop' => $this->blockStop($event),
            'message_delta' => $this->messageDelta($event),
            // `message_stop` carries nothing, and an event type added to the
            // API after this was written is skipped rather than guessed at.
            default => null,
        };
    }

    /** @return array{content: list<array<string, mixed>>, stop_reason: string, usage: array, model: string} */
    public function result(): array
    {
        $blocks = $this->blocks;
        ksort($blocks);

        return [
            'content' => array_values($blocks),
            'stop_reason' => $this->stopReason,
            'usage' => $this->usage,
            'model' => $this->model,
        ];
    }

    // ── the events ───────────────────────────────────────────────────────────

    /** @param  array<string, mixed>  $event */
    private function messageStart(array $event): void
    {
        $message = is_array($event['message'] ?? null) ? $event['message'] : [];

        $this->model = is_string($message['model'] ?? null) ? $message['model'] : '';
        $this->usage = $this->readUsage(is_array($message['usage'] ?? null) ? $message['usage'] : []);
    }

    /** @param  array<string, mixed>  $event */
    private function blockStart(array $event): void
    {
        $index = (int) ($event['index'] ?? 0);
        $block = is_array($event['content_block'] ?? null) ? $event['content_block'] : [];

        // A `tool_use` block starts with an empty `input` and fills in through
        // `input_json_delta`. The partial text is kept out of the block until
        // `content_block_stop`, so a turn cut off mid-argument leaves an empty
        // object rather than half a JSON document.
        if (($block['type'] ?? null) === 'tool_use') {
            $this->partials[$index] = '';
        }

        $this->blocks[$index] = $block;
    }

    /** @param  array<string, mixed>  $event */
    private function blockDelta(array $event): void
    {
        $index = (int) ($event['index'] ?? 0);
        $delta = is_array($event['delta'] ?? null) ? $event['delta'] : [];

        switch ($delta['type'] ?? '') {
            case 'text_delta':
                $text = (string) ($delta['text'] ?? '');
                $this->blocks[$index]['text'] = ($this->blocks[$index]['text'] ?? '').$text;
                $this->emit('text', $text);
                break;

            case 'thinking_delta':
                $thinking = (string) ($delta['thinking'] ?? '');
                $this->blocks[$index]['thinking'] = ($this->blocks[$index]['thinking'] ?? '').$thinking;
                $this->emit('thinking', $thinking);
                break;

            case 'signature_delta':
                // Never handed to a watcher: it is a token the next request has
                // to carry, not something anyone reads.
                $this->blocks[$index]['signature'] =
                    ($this->blocks[$index]['signature'] ?? '').(string) ($delta['signature'] ?? '');
                break;

            case 'input_json_delta':
                $this->partials[$index] = ($this->partials[$index] ?? '').(string) ($delta['partial_json'] ?? '');
                break;
        }
    }

    /** @param  array<string, mixed>  $event */
    private function blockStop(array $event): void
    {
        $index = (int) ($event['index'] ?? 0);

        if (! array_key_exists($index, $this->partials)) {
            return;
        }

        $json = $this->partials[$index];
        unset($this->partials[$index]);

        // A tool called with no arguments sends no deltas at all, rather than
        // the two characters of an empty object.
        $decoded = $json === '' ? [] : json_decode($json, true);

        $this->blocks[$index]['input'] = is_array($decoded) ? $decoded : [];
    }

    /** @param  array<string, mixed>  $event */
    private function messageDelta(array $event): void
    {
        $delta = is_array($event['delta'] ?? null) ? $event['delta'] : [];

        if (is_string($delta['stop_reason'] ?? null)) {
            $this->stopReason = $delta['stop_reason'];
        }

        // Output tokens are only known here, while the input and cache figures
        // came with `message_start` and have to survive — so this merges the
        // fields that are present rather than replacing the array.
        if (is_array($event['usage'] ?? null)) {
            $this->usage = array_merge($this->usage, array_filter(
                $this->readUsage($event['usage']),
                fn ($v) => $v !== null,
            ));
        }
    }

    /**
     * @param  array<string, mixed>  $usage
     * @return array<string, mixed>
     */
    private function readUsage(array $usage): array
    {
        return [
            'input_tokens' => $usage['input_tokens'] ?? null,
            'output_tokens' => $usage['output_tokens'] ?? null,
            'cache_read_input_tokens' => $usage['cache_read_input_tokens'] ?? null,
            'cache_creation_input_tokens' => $usage['cache_creation_input_tokens'] ?? null,
        ];
    }

    private function emit(string $kind, string $text): void
    {
        if ($this->onDelta !== null && $text !== '') {
            ($this->onDelta)($kind, $text);
        }
    }
}
