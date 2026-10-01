<?php

namespace App\Agent\Support;

/**
 * Encodes a tool result for the wire, under a hard size cap.
 *
 * The cap exists because a tool result is not paid for once: every subsequent
 * turn of the loop re-sends the whole transcript, so one unbounded result is
 * charged again on every following request and can crowd out the conversation
 * that motivated it. Row limits alone are not enough — fifty workouts with a
 * hundred sets each is still enormous.
 *
 * When a payload is over budget, rows are dropped from its longest list and the
 * result says so in words. Truncating silently is the one thing that must not
 * happen: a model that cannot tell a short list from a complete one will answer
 * "you have trained 12 times" off a list that was cut at 12.
 */
final class ResultEncoder
{
    /** Roughly 5k tokens — large enough for a real answer, small enough to re-send a dozen times. */
    public const MAX_BYTES = 20000;

    public static function encode(array $result): string
    {
        $json = self::json($result);

        if (strlen($json) <= self::MAX_BYTES) {
            return $json;
        }

        $key = self::longestList($result);

        // Nothing list-shaped to trim: the payload is one large object, so say
        // so rather than returning something that will not fit.
        if ($key === null) {
            return self::json([
                'error' => 'Result too large to return ('.strlen($json).' bytes, limit '.self::MAX_BYTES.
                    '). Narrow the request — a shorter date range or a more specific filter.',
            ]);
        }

        $rows = $result[$key];
        $dropped = 0;

        // One row at a time from the end, so the rows that survive are the ones
        // the query ordered first. Bisecting would be faster and would return an
        // arbitrary prefix length; this is called on a handful of results.
        while (count($rows) > 0 && strlen($json) > self::MAX_BYTES) {
            array_pop($rows);
            $dropped++;
            $result[$key] = $rows;
            $result['truncated'] = [
                'field' => $key,
                'omitted' => $dropped,
                'reason' => 'Result exceeded '.self::MAX_BYTES.' bytes. The last '.$dropped.
                    " row(s) of `{$key}` were dropped — ask again with a narrower filter or a lower limit to see them.",
            ];
            $json = self::json($result);
        }

        return $json;
    }

    /** The top-level key holding the longest list, or null if there is none. */
    private static function longestList(array $result): ?string
    {
        $best = null;
        $bestCount = 0;

        foreach ($result as $key => $value) {
            if (is_array($value) && array_is_list($value) && count($value) > $bestCount) {
                $best = $key;
                $bestCount = count($value);
            }
        }

        return $best;
    }

    private static function json(array $value): string
    {
        // Unescaped slashes and unicode because the model reads this: "×" is
        // three tokens where "×" is one, and escaping buys nothing inside JSON.
        return json_encode($value, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    }
}
