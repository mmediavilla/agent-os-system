<?php

namespace Tests\Feature\Facts;

use App\Models\Fact;
use App\Services\ClaudeService;
use App\Services\Facts\FactsBlock;
use App\Services\Facts\FactWriter;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * `facts:add` seeds the store by hand; `facts:probe` is the premise test.
 */
class FactsCommandsTest extends TestCase
{
    use RefreshDatabase;

    public function test_add_saves_an_active_manual_fact(): void
    {
        $this->artisan('facts:add', ['category' => 'food', 'key' => 'coffee', 'value' => 'black, no sugar'])
            ->expectsOutputToContain('Saved: food / coffee: black, no sugar (stated)')
            ->assertSuccessful();

        $fact = Fact::sole();
        $this->assertSame([Fact::ACTIVE, 'manual', Fact::STATED], [$fact->status, $fact->source, $fact->confidence]);
    }

    public function test_add_can_mark_a_guess_and_says_what_it_replaced(): void
    {
        $this->artisan('facts:add', ['category' => 'hobby', 'key' => 'basketball', 'value' => 'weekends']);

        $this->artisan('facts:add', ['category' => 'hobby', 'key' => 'basketball', 'value' => 'Sundays', '--inferred' => true])
            ->expectsOutputToContain('(inferred)')
            ->expectsOutputToContain('Replaces: weekends')
            ->assertSuccessful();

        $this->assertSame('Sundays', Fact::active()->sole()->value);
    }

    public function test_add_refuses_bad_input_with_a_sentence(): void
    {
        $this->artisan('facts:add', ['category' => 'food', 'key' => 'coffee', 'value' => str_repeat('x', 400)])
            ->assertFailed();

        $this->assertSame(0, Fact::count());
    }

    public function test_probe_asks_once_without_the_block_and_once_with_it(): void
    {
        app(FactWriter::class)->remember('food', 'pork', 'does not eat it');
        $block = FactsBlock::render();
        $prompts = [];

        $this->mock(ClaudeService::class)
            ->shouldReceive('complete')
            ->twice()
            ->andReturnUsing(function (string $system, string $question) use (&$prompts) {
                $prompts[] = $system;

                return [
                    'text' => count($prompts) === 1 ? 'Adobo.' : 'Chicken adobo, Sir.',
                    'usage' => ['input_tokens' => 10, 'output_tokens' => 3],
                    'model' => 'claude-sonnet-5',
                ];
            });

        $this->artisan('facts:probe', ['question' => 'What should I cook tonight?'])
            ->expectsOutputToContain('Without facts')
            ->expectsOutputToContain('Adobo.')
            ->expectsOutputToContain('With facts')
            ->expectsOutputToContain('Chicken adobo, Sir.')
            ->assertSuccessful();

        // The two prompts differ by the block and by nothing else.
        $this->assertStringNotContainsString(FactsBlock::HEADING, $prompts[0]);
        $this->assertSame($prompts[0].$block, $prompts[1]);
    }

    public function test_probe_with_nothing_on_file_spends_nothing(): void
    {
        $this->mock(ClaudeService::class)->shouldNotReceive('complete');

        $this->artisan('facts:probe', ['question' => 'Anything?'])
            ->expectsOutputToContain('No facts on file')
            ->assertFailed();
    }
}
