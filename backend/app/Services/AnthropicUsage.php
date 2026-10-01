<?php

namespace App\Services;

use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;
use Throwable;

/**
 * What each paid Anthropic call used, kept where a thread delete cannot reach.
 *
 * Assistant → Activity's spend used to be summed off the `usage` stored on
 * each chat turn and insight. Deleting a thread deletes its turns, so a month
 * with a few deleted threads read far below the bill ($0.84 against $2.83 on
 * 2026-09-30). Spend is a fact about the account, so it has a table of its own
 * with no foreign key: one row a call, written by `ClaudeService` — the one
 * place every paid call passes through, which is also why fact extraction and
 * `facts:probe` are counted now without a line of their own.
 *
 * **A write per paid call is fine where a write per poll would not be.**
 * `AnthropicCredit::clear()` reads before it writes because it would otherwise
 * add a writer to every call for a flag that is almost always clear; this row
 * is the record the call exists to leave, and a turn is followed by the write
 * of its own message anyway.
 *
 * **It never fails a call.** By the time there is usage to record the call has
 * been paid for and its answer is in hand; losing that answer to a ledger row
 * (an unmigrated checkout, a locked database) would charge twice for it. A
 * failed write is reported and the total runs low by one call.
 */
final class AnthropicUsage
{
    public const TABLE = 'anthropic_usage';

    /** The ledger's columns, by the key the Messages API reports each under. */
    public const COLUMNS = [
        'input_tokens' => 'input_tokens',
        'output_tokens' => 'output_tokens',
        'cache_read_input_tokens' => 'cache_read_tokens',
        'cache_creation_input_tokens' => 'cache_write_tokens',
    ];

    /**
     * @param  array<string, mixed>  $usage  the call's `usage`, as the API reported it
     */
    public static function record(?string $model, array $usage): void
    {
        $row = [];
        foreach (self::COLUMNS as $key => $column) {
            $row[$column] = max(0, (int) ($usage[$key] ?? 0));
        }

        // A response that reported nothing has nothing to price; a row of
        // zeros would only be a call counted that the totals cannot see.
        if (array_sum($row) === 0) {
            return;
        }

        try {
            DB::table(self::TABLE)->insert([
                'model' => $model,
                ...$row,
                'created_at' => CarbonImmutable::now(),
            ]);
        } catch (Throwable $e) {
            report($e);
        }
    }
}
