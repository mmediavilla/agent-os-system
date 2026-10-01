<?php

namespace Tests\Unit;

use App\Services\AnthropicPricing;
use App\Services\AssistantSettings;
use PHPUnit\Framework\Attributes\Test;
use PHPUnit\Framework\TestCase;

/**
 * The price list is copied by hand, so what is pinned here is that it stays
 * complete and that nothing matches a model it does not name.
 */
class AnthropicPricingTest extends TestCase
{
    #[Test]
    public function every_model_the_picker_offers_has_a_price(): void
    {
        foreach (AssistantSettings::MODELS as $model) {
            $this->assertNotNull(AnthropicPricing::for($model), "{$model} is offered in Assistant → Settings but has no price.");
        }
    }

    #[Test]
    public function a_dated_snapshot_matches_and_a_newer_model_does_not(): void
    {
        $this->assertSame(AnthropicPricing::PER_MILLION['claude-sonnet-5'], AnthropicPricing::for('claude-sonnet-5-20260801'));
        $this->assertNull(AnthropicPricing::for('claude-sonnet-5-5'));
        $this->assertNull(AnthropicPricing::for('claude-opus-5-5'));
        $this->assertNull(AnthropicPricing::for(null));
        $this->assertNull(AnthropicPricing::for(''));
    }

    #[Test]
    public function cost_is_per_million_across_all_four_counts(): void
    {
        $cost = AnthropicPricing::cost('claude-opus-5', ['input' => 1_000_000, 'output' => 1_000_000, 'cache_read' => 1_000_000, 'cache_write' => 1_000_000]);

        $this->assertEqualsWithDelta(5.00 + 25.00 + 0.50 + 6.25, $cost, 1e-9);
        $this->assertNull(AnthropicPricing::cost('claude-mystery', ['input' => 1, 'output' => 1, 'cache_read' => 0, 'cache_write' => 0]));
    }

    #[Test]
    public function cache_rates_follow_the_published_multiples(): void
    {
        foreach (AnthropicPricing::PER_MILLION as $model => $price) {
            $this->assertEqualsWithDelta($price['input'] * 0.1, $price['cache_read'], 1e-9, $model);
            $this->assertEqualsWithDelta($price['input'] * 1.25, $price['cache_write'], 1e-9, $model);
        }
    }
}
