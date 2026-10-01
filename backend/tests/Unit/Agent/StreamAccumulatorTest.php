<?php

namespace Tests\Unit\Agent;

use App\Agent\Support\StreamAccumulator;
use PHPUnit\Framework\TestCase;

/**
 * Reassembling a streamed turn.
 *
 * A plain PHPUnit test with no application booted: the accumulator takes wire
 * arrays and returns a wire array, so the whole of it can be exercised off
 * literals — which matters more here than usual, because the thing being
 * checked is *byte fidelity*. A signature stitched together wrong or a tool
 * input decoded from half its JSON does not fail here; it fails on the next
 * request, as a validation error about a block nobody edited.
 */
class StreamAccumulatorTest extends TestCase
{
    private function start(array $block, int $index = 0): array
    {
        return ['type' => 'content_block_start', 'index' => $index, 'content_block' => $block];
    }

    private function delta(array $delta, int $index = 0): array
    {
        return ['type' => 'content_block_delta', 'index' => $index, 'delta' => $delta];
    }

    private function stop(int $index = 0): array
    {
        return ['type' => 'content_block_stop', 'index' => $index];
    }

    /** @param  list<array<string, mixed>>  $events */
    private function consume(array $events, ?callable $onDelta = null): array
    {
        $accumulator = new StreamAccumulator($onDelta);

        foreach ($events as $event) {
            $accumulator->push($event);
        }

        return $accumulator->result();
    }

    public function test_it_rebuilds_a_plain_answer(): void
    {
        $result = $this->consume([
            ['type' => 'message_start', 'message' => [
                'model' => 'claude-sonnet-5',
                'usage' => ['input_tokens' => 120, 'output_tokens' => 1, 'cache_read_input_tokens' => 90],
            ]],
            $this->start(['type' => 'text', 'text' => '']),
            $this->delta(['type' => 'text_delta', 'text' => 'You trained ']),
            $this->delta(['type' => 'text_delta', 'text' => 'four times.']),
            $this->stop(),
            ['type' => 'message_delta', 'delta' => ['stop_reason' => 'end_turn'], 'usage' => ['output_tokens' => 42]],
            ['type' => 'message_stop'],
        ]);

        $this->assertSame([['type' => 'text', 'text' => 'You trained four times.']], $result['content']);
        $this->assertSame('end_turn', $result['stop_reason']);
        $this->assertSame('claude-sonnet-5', $result['model']);

        // Input and cache counts arrive with `message_start` and the output
        // count only at the end, so the two have to be merged rather than the
        // second replacing the first.
        $this->assertSame(120, $result['usage']['input_tokens']);
        $this->assertSame(90, $result['usage']['cache_read_input_tokens']);
        $this->assertSame(42, $result['usage']['output_tokens']);
    }

    public function test_it_reassembles_a_tool_input_split_across_deltas(): void
    {
        $result = $this->consume([
            $this->start(['type' => 'tool_use', 'id' => 'toolu_1', 'name' => 'list_workouts', 'input' => []]),
            // Split mid-key and mid-value, which is what the API actually does.
            $this->delta(['type' => 'input_json_delta', 'partial_json' => '{"li']),
            $this->delta(['type' => 'input_json_delta', 'partial_json' => 'mit":1']),
            $this->delta(['type' => 'input_json_delta', 'partial_json' => '0}']),
            $this->stop(),
            ['type' => 'message_delta', 'delta' => ['stop_reason' => 'tool_use']],
        ]);

        $this->assertSame([[
            'type' => 'tool_use',
            'id' => 'toolu_1',
            'name' => 'list_workouts',
            'input' => ['limit' => 10],
        ]], $result['content']);
        $this->assertSame('tool_use', $result['stop_reason']);
    }

    public function test_a_tool_called_with_no_arguments_gets_an_empty_input(): void
    {
        // No `input_json_delta` at all, rather than one carrying "{}".
        $result = $this->consume([
            $this->start(['type' => 'tool_use', 'id' => 'toolu_1', 'name' => 'get_fitness_stats', 'input' => []]),
            $this->stop(),
        ]);

        $this->assertSame([], $result['content'][0]['input']);
    }

    public function test_a_truncated_tool_input_becomes_empty_rather_than_broken_json(): void
    {
        // The turn ran out of tokens mid-argument. An empty object is a tool
        // call the model can be told is wrong; half a JSON document is not.
        $result = $this->consume([
            $this->start(['type' => 'tool_use', 'id' => 'toolu_1', 'name' => 'log_workout', 'input' => []]),
            $this->delta(['type' => 'input_json_delta', 'partial_json' => '{"title":"Push']),
            $this->stop(),
        ]);

        $this->assertSame([], $result['content'][0]['input']);
    }

    public function test_a_thinking_block_keeps_its_text_and_its_signature(): void
    {
        $result = $this->consume([
            $this->start(['type' => 'thinking', 'thinking' => '', 'signature' => '']),
            $this->delta(['type' => 'thinking_delta', 'thinking' => 'Checking the ']),
            $this->delta(['type' => 'thinking_delta', 'thinking' => 'last four weeks.']),
            // Signatures arrive in pieces too, and the API requires the whole
            // of it back unaltered on the next turn.
            $this->delta(['type' => 'signature_delta', 'signature' => 'abc']),
            $this->delta(['type' => 'signature_delta', 'signature' => 'def']),
            $this->stop(),
        ]);

        $this->assertSame([[
            'type' => 'thinking',
            'thinking' => 'Checking the last four weeks.',
            'signature' => 'abcdef',
        ]], $result['content']);
    }

    public function test_blocks_come_back_in_index_order(): void
    {
        $result = $this->consume([
            $this->start(['type' => 'text', 'text' => ''], 0),
            $this->delta(['type' => 'text_delta', 'text' => 'Let me check.'], 0),
            $this->stop(0),
            $this->start(['type' => 'tool_use', 'id' => 'toolu_1', 'name' => 'list_workouts', 'input' => []], 1),
            $this->stop(1),
        ]);

        $this->assertSame(['text', 'tool_use'], array_column($result['content'], 'type'));
    }

    public function test_it_reports_text_and_thinking_to_a_watcher_and_nothing_else(): void
    {
        $seen = [];

        $this->consume([
            $this->start(['type' => 'thinking', 'thinking' => '', 'signature' => '']),
            $this->delta(['type' => 'thinking_delta', 'thinking' => 'Hmm.']),
            // A signature is a token for the next request, not something to read.
            $this->delta(['type' => 'signature_delta', 'signature' => 'sig']),
            $this->stop(),
            $this->start(['type' => 'text', 'text' => ''], 1),
            $this->delta(['type' => 'text_delta', 'text' => 'Four.'], 1),
            // An empty slice is not worth waking anybody for.
            $this->delta(['type' => 'text_delta', 'text' => ''], 1),
            $this->stop(1),
        ], function (string $kind, string $slice) use (&$seen) {
            $seen[] = [$kind, $slice];
        });

        $this->assertSame([['thinking', 'Hmm.'], ['text', 'Four.']], $seen);
    }

    public function test_an_unknown_event_type_is_ignored(): void
    {
        // The API gains event types; a turn must not be lost to one of them.
        $result = $this->consume([
            $this->start(['type' => 'text', 'text' => '']),
            ['type' => 'something_added_later', 'index' => 0],
            $this->delta(['type' => 'text_delta', 'text' => 'Fine.']),
            $this->stop(),
        ]);

        $this->assertSame('Fine.', $result['content'][0]['text']);
    }

    public function test_a_stream_that_says_nothing_still_returns_a_usable_shape(): void
    {
        $result = $this->consume([]);

        $this->assertSame([], $result['content']);
        $this->assertSame('unknown', $result['stop_reason']);
    }
}
