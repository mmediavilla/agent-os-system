<?php

namespace Tests\Feature\Facts;

use App\Agent\Support\Instructions;
use App\Agent\ToolRegistry;
use App\Models\Fact;
use App\Services\Facts\FactsBlock;
use App\Services\Facts\FactWriter;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * What the assistant knows about the owner, as the last section of its prompt.
 */
class FactsBlockTest extends TestCase
{
    use RefreshDatabase;

    private function remember(string $category, string $key, string $value, string $confidence = Fact::STATED): Fact
    {
        return app(FactWriter::class)->remember($category, $key, $value, $confidence);
    }

    public function test_an_empty_store_adds_nothing_not_an_empty_heading(): void
    {
        $this->assertSame('', FactsBlock::render());

        $prompt = Instructions::systemPrompt(app(ToolRegistry::class));
        $this->assertStringEndsWith(Instructions::TOOLS, $prompt);
        $this->assertStringNotContainsString(FactsBlock::HEADING, $prompt);
    }

    public function test_the_block_is_the_last_thing_in_the_prompt(): void
    {
        $this->remember('food', 'coffee', 'black, no sugar');

        $prompt = Instructions::systemPrompt(app(ToolRegistry::class));

        // After TOOLS: the one section that changes mid-conversation goes
        // behind everything that does not.
        $this->assertStringEndsWith(FactsBlock::render(), $prompt);
        $this->assertGreaterThan(strpos($prompt, Instructions::TOOLS), strpos($prompt, FactsBlock::HEADING));
        $this->assertStringContainsString(FactsBlock::GUIDANCE, $prompt);
    }

    public function test_each_line_says_what_how_sure_and_when(): void
    {
        $this->travelTo('2026-08-14 12:00:00');
        $this->remember('food', 'coffee', 'black, no sugar');
        $this->remember('hobby', 'basketball', 'plays on weekends', Fact::INFERRED);

        $block = FactsBlock::render();

        $this->assertStringContainsString('- food / coffee: black, no sugar (stated, 2026-08)', $block);
        $this->assertStringContainsString('- hobby / basketball: plays on weekends (inferred, 2026-08)', $block);
    }

    public function test_the_month_is_the_owners_not_the_servers(): void
    {
        // 20:00 UTC on the last of August is already September in Manila.
        config(['agent.timezone' => 'Asia/Manila']);
        $this->travelTo('2026-08-31 20:00:00');
        $this->remember('food', 'coffee', 'black');

        $this->assertStringContainsString('(stated, 2026-09)', FactsBlock::render());
    }

    public function test_newest_first(): void
    {
        $this->travelTo('2026-06-01');
        $this->remember('hobby', 'basketball', 'plays on weekends');
        $this->travelTo('2026-08-01');
        $this->remember('food', 'coffee', 'black');

        $block = FactsBlock::render();

        $this->assertLessThan(strpos($block, 'basketball'), strpos($block, 'coffee'));
    }

    public function test_only_active_facts_are_shown(): void
    {
        $this->remember('food', 'coffee', 'with milk');
        $this->remember('food', 'coffee', 'black');   // supersedes the first

        foreach ([Fact::PROPOSED, Fact::REJECTED] as $status) {
            Fact::create([
                'category' => 'work', 'key' => $status, 'value' => "a {$status} claim",
                'confidence' => Fact::INFERRED, 'source' => 'extracted',
                'status' => $status, 'learned_at' => now(),
            ]);
        }

        $block = FactsBlock::render();

        $this->assertStringContainsString('food / coffee: black', $block);
        $this->assertStringNotContainsString('with milk', $block);
        $this->assertStringNotContainsString('proposed claim', $block);
        $this->assertStringNotContainsString('rejected claim', $block);
    }

    public function test_past_the_cap_the_oldest_are_left_out_and_counted(): void
    {
        $this->travelTo('2026-01-01');
        for ($i = 0; $i < 40; $i++) {
            $this->travel(1)->days();
            $this->remember('misc', "thing {$i}", str_repeat('x', 80)." {$i}");
        }

        $block = FactsBlock::render();
        $lines = array_filter(explode("\n", $block), fn ($l) => str_starts_with($l, '- '));

        $this->assertLessThanOrEqual(FactsBlock::MAX_BYTES, strlen(implode("\n", $lines)));
        $this->assertLessThan(40, count($lines));

        // The newest survive and the model is told its memory has a horizon.
        $this->assertStringContainsString('misc / thing 39:', $block);
        $this->assertStringNotContainsString('misc / thing 0:', $block);
        $this->assertStringEndsWith((40 - count($lines)).' older facts are not shown.', $block);
    }

    public function test_under_the_cap_nothing_is_said_about_a_horizon(): void
    {
        $this->remember('food', 'coffee', 'black');

        $this->assertStringNotContainsString('not shown', FactsBlock::render());
    }

    public function test_the_shared_half_never_carries_facts(): void
    {
        // An MCP host is sent TOOLS alone, and what the app knows about its
        // owner has no business in somebody else's Claude Code session.
        $this->remember('food', 'coffee', 'black');

        $this->assertStringNotContainsString('coffee', Instructions::TOOLS);
        $this->assertStringNotContainsString(FactsBlock::HEADING, Instructions::TOOLS);
    }
}
