<?php

namespace Tests\Feature\Agent;

use App\Agent\Support\Instructions;
use App\Agent\ToolRegistry;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * The split between what both drivers say and what only this app says.
 *
 * `TOOLS` is sent verbatim by the loop and by every MCP host; the persona is
 * sent by the loop alone. That boundary is the whole reason the persona is a
 * separate constant, and it is exactly the sort of thing a later edit
 * ("everything the assistant is told, in one place") quietly undoes.
 */
class InstructionsTest extends TestCase
{
    use RefreshDatabase;

    public function test_the_loop_leads_with_the_persona(): void
    {
        $prompt = Instructions::systemPrompt(app(ToolRegistry::class));

        $this->assertStringContainsString(Instructions::PERSONA, $prompt);

        // Leads, rather than merely appearing: who is speaking comes before the
        // rules about how to do the job.
        $this->assertStringStartsWith('You are a highly capable personal AI butler.', trim($prompt));

        // And the rest of the prompt is still there underneath it.
        $this->assertStringContainsString('Today is ', $prompt);
        $this->assertStringContainsString(Instructions::TOOLS, $prompt);
    }

    public function test_the_shared_half_carries_no_persona(): void
    {
        // An MCP host prepends TOOLS to a system prompt of its own, so a butler
        // in here would be this app telling Claude Code how to address its user.
        $this->assertStringNotContainsString('Sir', Instructions::TOOLS);
        $this->assertStringNotContainsString('butler', Instructions::TOOLS);
    }

    public function test_the_loop_says_it_is_not_only_a_training_log(): void
    {
        $prompt = Instructions::systemPrompt(app(ToolRegistry::class));

        // Before this, asked about the weather, it offered "your training log,
        // calendar events, or exercise records instead" — a list of tools read
        // as a list of permitted subjects.
        $this->assertStringContainsString(Instructions::SCOPE, $prompt);
        $this->assertStringContainsString('not only their training log', Instructions::SCOPE);

        // The news came off the out-of-reach list when get_news arrived (19.1);
        // prices and scores are still out of reach, and it still says so.
        $this->assertStringContainsString('the weather, or the news', Instructions::SCOPE);
        $this->assertStringNotContainsString('— news,', Instructions::SCOPE);
        $this->assertStringContainsString('prices, scores', Instructions::SCOPE);

        // Straight after the persona: what the job is, before how to do it.
        $this->assertLessThan(strpos($prompt, 'Write in plain prose'), strpos($prompt, Instructions::SCOPE));
        $this->assertGreaterThan(strpos($prompt, Instructions::PERSONA), strpos($prompt, Instructions::SCOPE));

        // The spoken path is the same loop, and gets it too.
        $this->assertStringContainsString(
            Instructions::SCOPE,
            Instructions::systemPrompt(app(ToolRegistry::class)->readOnly(), Instructions::SPOKEN),
        );
    }

    public function test_the_shared_half_does_not_tell_a_host_what_it_may_answer(): void
    {
        // An MCP host arrives with a scope of its own. Telling Claude Code what
        // it may talk about would be the persona mistake again, one layer down.
        $this->assertStringNotContainsString(Instructions::SCOPE, Instructions::TOOLS);
        $this->assertStringNotContainsString('general assistant', Instructions::TOOLS);
    }

    public function test_the_shared_half_names_the_weather(): void
    {
        $this->assertStringContainsString('get_weather', Instructions::TOOLS);
    }

    public function test_the_shared_half_says_nothing_about_being_spoken(): void
    {
        // Same boundary, one layer along: a host's session is read, not heard,
        // and "two or three short sentences, no markdown" arriving in Claude
        // Code would be this app deciding how somebody else's answers look.
        $this->assertStringNotContainsString('read out loud', Instructions::TOOLS);
        $this->assertStringNotContainsString(Instructions::SPOKEN, Instructions::TOOLS);
    }

    public function test_a_registry_with_no_writes_is_told_so_rather_than_told_nothing(): void
    {
        $prompt = Instructions::systemPrompt(app(ToolRegistry::class)->readOnly());

        // The gate paragraph built from an empty list reads "  are proposed to
        // the user" — describing a mechanism this caller does not have, in a
        // sentence that is also not English.
        $this->assertStringNotContainsString('are proposed to the', $prompt);
        $this->assertStringContainsString('not one of them writes', $prompt);
        $this->assertStringContainsString('has to be typed into the app', $prompt);
    }

    public function test_the_full_registry_still_names_the_gated_tools(): void
    {
        $prompt = Instructions::systemPrompt(app(ToolRegistry::class));

        $this->assertStringContainsString('are proposed to the', $prompt);
        $this->assertStringContainsString('log_workout', $prompt);
        $this->assertStringNotContainsString('not one of them writes', $prompt);
    }

    public function test_an_addendum_goes_last_and_is_absent_by_default(): void
    {
        $tools = app(ToolRegistry::class);

        $this->assertStringNotContainsString(Instructions::SPOKEN, Instructions::systemPrompt($tools));

        $prompt = Instructions::systemPrompt($tools, Instructions::SPOKEN);

        // Last, because everything above it is a standing rule and this is a
        // fact about the turn being taken right now.
        $this->assertGreaterThan(
            strpos($prompt, 'Today is '),
            strpos($prompt, Instructions::SPOKEN),
        );
        $this->assertStringContainsString(Instructions::TOOLS, $prompt);
    }
}
