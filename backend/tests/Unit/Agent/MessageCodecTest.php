<?php

namespace Tests\Unit\Agent;

use App\Agent\Support\MessageCodec;
use App\Models\ConversationMessage;
use PHPUnit\Framework\TestCase;

/**
 * The boundary between a stored turn and a wire turn.
 *
 * Small enough to test without a database — every method here is a pure
 * function of arrays, which is the point of keeping the conversions in one place
 * rather than inline in the runner.
 */
class MessageCodecTest extends TestCase
{
    private function message(string $role, array $content): ConversationMessage
    {
        return new ConversationMessage(['role' => $role, 'content' => $content]);
    }

    public function test_tool_result_block_omits_is_error_when_the_call_succeeded(): void
    {
        $block = MessageCodec::toolResultBlock('toolu_1', '{"ok":true}');

        $this->assertSame(
            ['type' => 'tool_result', 'tool_use_id' => 'toolu_1', 'content' => '{"ok":true}'],
            $block
        );
    }

    public function test_tool_result_block_marks_a_failure(): void
    {
        $block = MessageCodec::toolResultBlock('toolu_1', 'The title field is required.', true);

        $this->assertTrue($block['is_error']);
    }

    public function test_transcript_keeps_role_and_content_verbatim(): void
    {
        $wire = MessageCodec::transcript([
            $this->message('user', [['type' => 'text', 'text' => 'hi']]),
            $this->message('assistant', [
                ['type' => 'thinking', 'thinking' => '', 'signature' => 'abc'],
                ['type' => 'text', 'text' => 'hello'],
            ]),
        ]);

        $this->assertSame('user', $wire[0]['role']);
        $this->assertSame('assistant', $wire[1]['role']);
        // The thinking block survives untouched: the API requires it back
        // byte-identical when a tool call follows it.
        $this->assertSame('abc', $wire[1]['content'][0]['signature']);
    }

    public function test_transcript_drops_empty_turns(): void
    {
        $wire = MessageCodec::transcript([
            $this->message('user', [['type' => 'text', 'text' => 'hi']]),
            $this->message('assistant', []),
        ]);

        $this->assertCount(1, $wire);
    }

    public function test_tool_uses_returns_only_tool_use_blocks_in_order(): void
    {
        $uses = MessageCodec::toolUses([
            ['type' => 'thinking', 'thinking' => '', 'signature' => 's'],
            ['type' => 'text', 'text' => 'checking'],
            ['type' => 'tool_use', 'id' => 'toolu_1', 'name' => 'get_fitness_stats', 'input' => []],
            ['type' => 'tool_use', 'id' => 'toolu_2', 'name' => 'list_workouts', 'input' => []],
        ]);

        $this->assertSame(['toolu_1', 'toolu_2'], array_column($uses, 'id'));
    }

    public function test_text_joins_every_text_block_not_just_the_first(): void
    {
        $text = MessageCodec::text([
            ['type' => 'thinking', 'thinking' => 'hidden', 'signature' => 's'],
            ['type' => 'text', 'text' => 'First.'],
            ['type' => 'text', 'text' => 'Second.'],
        ]);

        // ClaudeService::complete() takes the first block and stops, which is
        // fine for a one-shot report and wrong for a turn that speaks twice.
        $this->assertSame("First.\n\nSecond.", $text);
    }

    public function test_text_is_empty_when_a_turn_only_called_a_tool(): void
    {
        $this->assertSame('', MessageCodec::text([
            ['type' => 'tool_use', 'id' => 'toolu_1', 'name' => 'list_workouts', 'input' => []],
        ]));
    }
}
