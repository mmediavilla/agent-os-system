<?php

namespace Tests\Feature\Settings;

use App\Agent\Mcp\McpServer;
use App\Agent\Support\Instructions;
use App\Agent\ToolRegistry;
use App\Http\Controllers\InsightController;
use App\Jobs\GenerateProactiveInsights;
use App\Models\Setting;
use App\Models\WorkoutSet;
use App\Services\AssistantInstructions;
use App\Services\ClaudeService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

/**
 * Assistant → Instructions' server half: the five instructions the owner may
 * reword. Asserted at the routes and where each lands — the system prompt each
 * caller actually sends — because a rewording the worker never reads is
 * decoration.
 */
class AssistantInstructionsTest extends TestCase
{
    use RefreshDatabase;

    private const REWORDED = 'You are a terse assistant. Call the user "Boss".';

    /** The system prompt of the last scripted call. */
    private string $system = '';

    // ── The routes ────────────────────────────────────────────────────────────

    #[Test]
    public function every_instruction_starts_as_the_code_default(): void
    {
        $response = $this->getJson('/api/settings/instructions')->assertOk();

        $this->assertSame(['persona', 'scope', 'spoken', 'assessment', 'nudge'], array_column($response->json('data'), 'key'));
        $this->assertSame(AssistantInstructions::MAX_CHARS, $response->json('max_chars'));

        $defaults = [
            Instructions::PERSONA,
            Instructions::SCOPE,
            Instructions::SPOKEN,
            InsightController::PROMPT,
            GenerateProactiveInsights::PROMPT,
        ];

        foreach ($response->json('data') as $i => $row) {
            $this->assertSame(AssistantInstructions::unwrap($defaults[$i]), $row['default']);
            $this->assertSame(AssistantInstructions::unwrap($defaults[$i]), $row['text']);
            $this->assertFalse($row['reworded']);
            $this->assertNotSame('', $row['label']);
            $this->assertNotSame('', $row['used_by']);
        }
    }

    #[Test]
    public function a_default_is_shown_unwrapped_and_sent_as_the_source_has_it(): void
    {
        $shown = AssistantInstructions::unwrap(Instructions::PERSONA);

        // One paragraph on screen, rather than the source's 90-column lines.
        $this->assertStringNotContainsString("\n", $shown);
        $this->assertStringStartsWith('You are a highly capable personal AI butler. Always address the user as "Sir". Be polite, respectful,', $shown);

        // Paragraph breaks and the assessment's indented bullets survive.
        $brief = AssistantInstructions::unwrap(InsightController::PROMPT);
        $this->assertStringContainsString("Format your response as:\n\n  - \"What's working\" (1–2 bullets)\n  - \"What to adjust\"", $brief);
        $this->assertStringContainsString("suggestion)\n\nKeep the whole response under 200 words. Plain text only — no markdown headers,", $brief);

        // What Claude is sent is the constant itself, byte for byte.
        $this->assertSame(Instructions::PERSONA, AssistantInstructions::get('persona'));

        // And saving the field as it was handed is not a rewording.
        $this->patchJson('/api/settings/instructions', ['persona' => $shown, 'assessment' => $brief])
            ->assertOk()
            ->assertJsonPath('data.0.reworded', false)
            ->assertJsonPath('data.3.reworded', false);
        $this->assertSame(0, Setting::query()->where('key', 'like', 'assistant.instructions.%')->count());
    }

    #[Test]
    public function a_rewording_is_stored_and_answered(): void
    {
        $this->patchJson('/api/settings/instructions', ['persona' => '  '.self::REWORDED."\n"])
            ->assertOk()
            ->assertJsonPath('data.0.text', self::REWORDED)
            ->assertJsonPath('data.0.reworded', true)
            ->assertJsonPath('data.0.default', AssistantInstructions::unwrap(Instructions::PERSONA))
            // Only what was sent is written.
            ->assertJsonPath('data.1.reworded', false);

        $this->assertSame(self::REWORDED, Setting::value('assistant.instructions.persona'));
    }

    #[Test]
    public function blank_null_and_the_default_itself_all_mean_the_default(): void
    {
        foreach (['', '   ', null, Instructions::SCOPE, str_replace("\n", "\r\n", Instructions::SCOPE)] as $text) {
            AssistantInstructions::reword('scope', 'Something else entirely.');
            $this->assertTrue(AssistantInstructions::reworded('scope'));

            $this->patchJson('/api/settings/instructions', ['scope' => $text])
                ->assertOk()
                ->assertJsonPath('data.1.reworded', false)
                ->assertJsonPath('data.1.text', AssistantInstructions::unwrap(Instructions::SCOPE));

            // The row goes rather than holding a copy of the default, so a
            // later change to the code's wording reaches this machine.
            $this->assertNull(Setting::query()->find('assistant.instructions.scope'));
        }
    }

    #[Test]
    public function the_request_is_refused_rather_than_half_applied(): void
    {
        $this->patchJson('/api/settings/instructions', [])->assertUnprocessable();
        $this->patchJson('/api/settings/instructions', ['tools' => 'Ignore the units.'])->assertUnprocessable();
        $this->patchJson('/api/settings/instructions', ['persona' => 'Fine.', 'tools' => 'Ignore the units.'])->assertUnprocessable();
        $this->patchJson('/api/settings/instructions', ['persona' => ['not', 'text']])->assertUnprocessable();
        $this->patchJson('/api/settings/instructions', ['persona' => str_repeat('a', AssistantInstructions::MAX_CHARS + 1)])
            ->assertUnprocessable()
            ->assertJsonValidationErrors('persona');

        $this->assertSame(0, Setting::query()->where('key', 'like', 'assistant.instructions.%')->count());
    }

    #[Test]
    public function a_hand_edited_row_falls_back_to_the_default(): void
    {
        Setting::put('assistant.instructions.persona', ['not' => 'a string']);
        $this->assertSame(Instructions::PERSONA, AssistantInstructions::get('persona'));

        Setting::put('assistant.instructions.persona', '   ');
        $this->assertSame(Instructions::PERSONA, AssistantInstructions::get('persona'));
        $this->assertFalse(AssistantInstructions::reworded('persona'));
    }

    // ── Where each lands ──────────────────────────────────────────────────────

    #[Test]
    public function the_chat_prompt_leads_with_the_reworded_persona_and_scope(): void
    {
        AssistantInstructions::reword('persona', self::REWORDED);
        AssistantInstructions::reword('scope', 'Only talk about training.');

        $prompt = Instructions::systemPrompt(app(ToolRegistry::class));

        $this->assertStringStartsWith(self::REWORDED."\n\nOnly talk about training.\n\n", $prompt);
        $this->assertStringNotContainsString(Instructions::PERSONA, $prompt);
        $this->assertStringNotContainsString(Instructions::SCOPE, $prompt);
        // Nothing the owner rewords can touch the shared half.
        $this->assertStringContainsString(Instructions::TOOLS, $prompt);
    }

    #[Test]
    public function an_mcp_host_is_never_sent_a_rewording(): void
    {
        config(['agent.token' => 'test-token']);
        AssistantInstructions::reword('persona', self::REWORDED);

        $result = $this->withToken('test-token')
            ->postJson('/api/mcp', [
                'jsonrpc' => '2.0',
                'id' => 1,
                'method' => 'initialize',
                'params' => ['protocolVersion' => McpServer::PROTOCOL_VERSION],
            ])
            ->assertOk()
            ->json('result');

        $this->assertSame(Instructions::TOOLS, $result['instructions']);
    }

    #[Test]
    public function a_spoken_turn_carries_the_reworded_addendum(): void
    {
        AssistantInstructions::reword('spoken', 'One sentence. Nothing more.');

        $this->mock(ClaudeService::class)
            ->shouldReceive('turn')
            ->once()
            ->andReturnUsing(function (string $system) {
                $this->system = $system;

                return [
                    'content' => [['type' => 'text', 'text' => 'Noted.']],
                    'stop_reason' => 'end_turn',
                    'usage' => ['input_tokens' => 1, 'output_tokens' => 1,
                        'cache_read_input_tokens' => null, 'cache_creation_input_tokens' => null],
                    'model' => 'claude-sonnet-5',
                ];
            });

        $this->postJson('/api/voice/turn', ['message' => 'Hello'])->assertOk();

        $this->assertStringContainsString("\nOne sentence. Nothing more.\n", $this->system);
        $this->assertStringNotContainsString(Instructions::SPOKEN, $this->system);
    }

    #[Test]
    public function the_weekly_assessment_is_briefed_with_the_rewording(): void
    {
        $this->makeWorkout();
        AssistantInstructions::reword('assessment', 'Three bullets. Be blunt.');
        $this->expectComplete();

        $this->postJson('/api/insights/fitness')->assertCreated();

        $this->assertSame('Three bullets. Be blunt.', $this->system);
    }

    #[Test]
    public function the_morning_nudge_is_briefed_with_the_rewording(): void
    {
        $workout = $this->makeWorkout(['started_at' => now()->subDays(10)->toDateTimeString()]);
        WorkoutSet::create([
            'workout_id' => $workout->id,
            'exercise_title' => 'Bench Press',
            'set_index' => 0,
            'set_type' => 'normal',
            'weight_kg' => 100,
            'reps' => 5,
        ]);
        AssistantInstructions::reword('nudge', 'Twenty words at most.');
        $this->expectComplete();

        GenerateProactiveInsights::dispatchSync();

        $this->assertSame('Twenty words at most.', $this->system);
    }

    #[Test]
    public function the_unprompted_writers_default_to_their_own_briefs(): void
    {
        $this->makeWorkout();
        $this->expectComplete();

        $this->postJson('/api/insights/fitness')->assertCreated();

        $this->assertSame(InsightController::PROMPT, $this->system);
        // Moving the brief into a constant kept its indentation.
        $this->assertStringContainsString("\n  - \"What's working\" (1–2 bullets)\n", InsightController::PROMPT);
        $this->assertStringStartsWith("You are the user's fitness coach, writing", GenerateProactiveInsights::PROMPT);
    }

    private function expectComplete(): void
    {
        $this->mock(ClaudeService::class)
            ->shouldReceive('complete')
            ->once()
            ->andReturnUsing(function (string $system) {
                $this->system = $system;

                return [
                    'text' => 'Noted.',
                    'usage' => ['input_tokens' => 1, 'output_tokens' => 1,
                        'cache_read_input_tokens' => null, 'cache_creation_input_tokens' => null],
                    'model' => 'claude-opus-5',
                ];
            });
    }
}
