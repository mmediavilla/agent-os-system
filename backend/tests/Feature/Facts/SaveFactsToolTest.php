<?php

namespace Tests\Feature\Facts;

use App\Agent\Contracts\MutatingTool;
use App\Agent\Support\Instructions;
use App\Agent\ToolRegistry;
use App\Models\Fact;
use App\Services\Facts\FactWriter;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Validation\ValidationException;
use Tests\TestCase;

/**
 * `save_facts`: a write behind the approval card, typed chat only, and one call
 * for everything a message asked to be remembered.
 */
class SaveFactsToolTest extends TestCase
{
    use RefreshDatabase;

    private function save(array $facts): array
    {
        return app(ToolRegistry::class)->get('save_facts')->handle(['facts' => $facts]);
    }

    private function fact(string $key, string $value, string $confidence = 'stated', string $category = 'food'): array
    {
        return compact('category', 'key', 'value', 'confidence');
    }

    public function test_it_is_gated_and_voice_never_sees_it(): void
    {
        $registry = app(ToolRegistry::class);

        $this->assertInstanceOf(MutatingTool::class, $registry->get('save_facts'));
        $this->assertArrayNotHasKey('save_facts', $registry->readOnly()->all());
        // The gated-tool paragraph is derived from the registry, so it names it.
        $this->assertStringContainsString('save_facts', Instructions::systemPrompt($registry));
    }

    public function test_one_call_saves_several_facts_as_stated_or_inferred_chat_facts(): void
    {
        $result = $this->save([
            $this->fact('pork', "Doesn't eat it."),
            $this->fact('coffee', 'Black, no sugar.', 'inferred'),
        ]);

        $this->assertSame(['saved', 'saved'], array_column($result['facts'], 'outcome'));
        $this->assertSame(2, Fact::active()->where('source', 'chat')->count());
        $this->assertSame('inferred', Fact::where('key', 'coffee')->value('confidence'));
    }

    public function test_the_result_says_what_was_replaced_and_what_was_already_known(): void
    {
        app(FactWriter::class)->remember('food', 'coffee', 'With milk');
        app(FactWriter::class)->remember('food', 'tea', 'Green');

        $result = $this->save([
            $this->fact('Coffee', 'Black.'),
            $this->fact('tea', 'green'),
        ]);

        $this->assertSame('replaced', $result['facts'][0]['outcome']);
        $this->assertSame('With milk', $result['facts'][0]['replaced']);
        $this->assertSame('already_on_file', $result['facts'][1]['outcome']);
        $this->assertNull($result['facts'][1]['replaced']);
        $this->assertSame(1, Fact::where('status', Fact::SUPERSEDED)->count());
    }

    public function test_one_bad_fact_saves_none_of_them(): void
    {
        foreach ([
            [],
            [$this->fact('pork', "Doesn't eat it."), $this->fact('coffee', 'Black', 'certain')],
            [$this->fact('pork', "Doesn't eat it."), $this->fact('coffee', str_repeat('x', FactWriter::MAX_VALUE + 1))],
            array_fill(0, 11, $this->fact('pork', "Doesn't eat it.")),
        ] as $facts) {
            try {
                $this->save($facts);
                $this->fail('Accepted '.count($facts).' facts');
            } catch (ValidationException) {
                // expected — the runner hands this back to the model as is_error
            }
        }

        $this->assertSame(0, Fact::count());
    }

    public function test_the_schema_agrees_with_the_writer(): void
    {
        $item = app(ToolRegistry::class)->get('save_facts')->inputSchema()['properties']['facts']['items'];

        $this->assertSame(Fact::CONFIDENCES, $item['properties']['confidence']['enum']);
        $this->assertSame(['category', 'key', 'value', 'confidence'], $item['required']);
    }
}
