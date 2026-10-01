<?php

namespace App\Services;

/**
 * What a token costs at Anthropic, for an estimate and never a bill.
 *
 * **There is no API for a prepaid balance** ({@see AnthropicCredit}), so the
 * only spend this app can show is its own tokens times a price list — and the
 * price list is copied here by hand. Anthropic's pricing page is the source; a
 * price change there is a line change here. `AnthropicPricingTest` fails when
 * `AssistantSettings::MODELS` names a model this table does not, so a model
 * added to the picker cannot silently cost nothing.
 *
 * **Per million tokens, US dollars.** Cache reads are 0.1× input and cache
 * writes 1.25× (the 5-minute TTL — nothing here sets the 1-hour one, and
 * nothing sets `cache_control` at all yet, so both are near zero today).
 *
 * **A model not listed is not guessed.** Its tokens are reported as unpriced,
 * and the screen says the figure leaves them out, rather than pricing an old
 * Opus at a Sonnet's rate.
 */
final class AnthropicPricing
{
    /** As published at console.anthropic.com/pricing, 2026-09. */
    public const AS_OF = '2026-09';

    /** @var array<string, array{input: float, output: float, cache_read: float, cache_write: float}> */
    public const PER_MILLION = [
        'claude-opus-5' => ['input' => 5.00, 'output' => 25.00, 'cache_read' => 0.50, 'cache_write' => 6.25],
        'claude-sonnet-5' => ['input' => 2.00, 'output' => 10.00, 'cache_read' => 0.20, 'cache_write' => 2.50],
    ];

    /**
     * The row a stored model name is priced at, or null.
     *
     * The API answers with the id it was asked for, but a dated snapshot
     * (`claude-sonnet-5-20260801`) is the same model and the same price, so a
     * listed id followed by a date matches too. Nothing looser: `claude-opus-5-5`
     * is a different model at a different price and must not match
     * `claude-opus-5`.
     *
     * @return array{input: float, output: float, cache_read: float, cache_write: float}|null
     */
    public static function for(?string $model): ?array
    {
        if ($model === null || $model === '') {
            return null;
        }

        foreach (self::PER_MILLION as $id => $price) {
            if ($model === $id || preg_match('/^'.preg_quote($id, '/').'-\d{8}$/', $model) === 1) {
                return $price;
            }
        }

        return null;
    }

    /**
     * Dollars for one model's token counts, or null when it is not listed.
     *
     * @param  array{input: int, output: int, cache_read: int, cache_write: int}  $tokens
     */
    public static function cost(?string $model, array $tokens): ?float
    {
        $price = self::for($model);

        if ($price === null) {
            return null;
        }

        $dollars = 0.0;
        foreach ($price as $kind => $perMillion) {
            $dollars += ($tokens[$kind] ?? 0) * $perMillion / 1_000_000;
        }

        return $dollars;
    }
}
