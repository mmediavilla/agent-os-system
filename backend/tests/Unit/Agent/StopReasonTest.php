<?php

namespace Tests\Unit\Agent;

use Anthropic\Messages\StopReason;
use App\Services\ClaudeService;
use PHPUnit\Framework\TestCase;

/**
 * `$response->stopReason` throws — the SDK overrides the property and demands
 * array access, which then yields a `StopReason` enum rather than a string.
 * That cost the error path in `complete()` a confusing SDK exception instead of
 * the message it was building, and the agent loop reads the same field on every
 * turn, so the unwrapping is pinned here.
 */
class StopReasonTest extends TestCase
{
    public function test_an_enum_is_unwrapped_to_its_wire_value(): void
    {
        $this->assertSame('tool_use', ClaudeService::stopReason(['stopReason' => StopReason::TOOL_USE]));
        $this->assertSame('max_tokens', ClaudeService::stopReason(['stopReason' => StopReason::MAX_TOKENS]));
    }

    public function test_a_plain_string_passes_through(): void
    {
        // A turn rehydrated from stored JSON is a plain array, not an SDK object.
        $this->assertSame('end_turn', ClaudeService::stopReason(['stopReason' => 'end_turn']));
    }

    public function test_a_missing_reason_is_reported_as_unknown(): void
    {
        $this->assertSame('unknown', ClaudeService::stopReason([]));
        $this->assertSame('unknown', ClaudeService::stopReason(['stopReason' => null]));
    }
}
