<?php

namespace App\Services\Facts;

use App\Models\Fact;

/**
 * The section of the loop's system prompt that says what it knows about the owner.
 *
 * **A prompt block, not a tool.** A `recall_facts` tool is one the model would
 * have to think to call, and the facts that matter most — "doesn't eat pork" —
 * are exactly the ones nobody asks about directly. In the prompt they shape
 * every answer, typed or spoken, at the cost of a few hundred tokens a turn.
 *
 * **Last in the prompt, after `Instructions::TOOLS`.** It is the one part that
 * changes between turns of the same day, so it sits behind everything that does
 * not — which is also where a cached prefix would want it, the day one exists.
 *
 * **Capped at {@see self::MAX_BYTES}, newest first.** Past the cap the oldest
 * are left out and the block says how many, so the model knows its memory has a
 * horizon rather than believing it knows everything. A `search_facts` tool comes
 * only when that line starts appearing.
 */
final class FactsBlock
{
    public const MAX_BYTES = 2048;

    public const HEADING = 'What you know about the user, learned over time.';

    /**
     * How to hold what follows. The last sentence is open question 1's default:
     * the assistant does not narrate its memory ("as you mentioned…") every
     * turn, only where a fact is the reason for the answer, and then it says so
     * — which is also how a wrong fact gets noticed and corrected.
     */
    public const GUIDANCE = <<<'TEXT'
    Dates are when each was learned: treat an old one as possibly out of date. "inferred" is
    your own guess from something the user said, not their word, so never present it as
    something they told you. Let these shape your answers without reciting them; mention one
    only when it is the reason for what you say, and then say plainly that it is what you
    have on file, so a wrong one can be corrected.
    TEXT;

    /** The block, leading blank line included, or '' when nothing is known. */
    public static function render(): string
    {
        $facts = Fact::active()
            ->orderByDesc('learned_at')
            ->orderByDesc('id')
            ->get(['category', 'key', 'value', 'confidence', 'learned_at']);

        if ($facts->isEmpty()) {
            return '';
        }

        $zone = config('agent.timezone');
        $lines = [];
        $bytes = 0;

        foreach ($facts as $fact) {
            $line = sprintf(
                '- %s / %s: %s (%s, %s)',
                $fact->category,
                $fact->key,
                $fact->value,
                $fact->confidence,
                $fact->learned_at->timezone($zone)->format('Y-m'),
            );

            $bytes += strlen($line) + 1;
            if ($bytes > self::MAX_BYTES) {
                break;
            }
            $lines[] = $line;
        }

        $hidden = $facts->count() - count($lines);
        if ($hidden > 0) {
            $lines[] = "{$hidden} older ".($hidden === 1 ? 'fact is' : 'facts are').' not shown.';
        }

        return "\n\n".self::HEADING.' '.self::GUIDANCE."\n\n".implode("\n", $lines);
    }
}
