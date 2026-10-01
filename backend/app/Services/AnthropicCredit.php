<?php

namespace App\Services;

use Anthropic\Core\Exceptions\APIStatusException;
use Anthropic\ErrorType;
use App\Models\Setting;
use Carbon\CarbonImmutable;
use Throwable;

/**
 * Whether the Anthropic account ran out of credit, as last seen.
 *
 * **There is no API that reports a prepaid balance**, so this is not a number.
 * It is the one fact a failed call proves: Anthropic refused to bill for it.
 * `ClaudeService` records that here the moment a call is refused, and clears it
 * the moment one succeeds, so the flag follows the account without anyone
 * resetting it — topping up and asking again is the whole recovery.
 *
 * **A row, not the cache**, for `AnthropicSwitch`'s reason: the 07:00 nudge and
 * fact extraction fail on a worker with no browser open, and the HUD has to
 * learn it from `/api/health`. A cache flush would turn an empty account back
 * into a green light with nothing on screen to say otherwise.
 *
 * **It never blocks a call.** A flag that stopped calls could only be cleared by
 * hand, and a top-up would then look like it had not worked. Every call still
 * goes out; the one after a top-up succeeds and clears it.
 */
final class AnthropicCredit
{
    public const KEY = 'anthropic.credit_exhausted';

    /**
     * Whether an exception is Anthropic refusing to bill, anywhere in its chain.
     *
     * The type is the contract (`billing_error`, a 402). The wording is a
     * second test because the credit-balance refusal has also been sent as a
     * 400 `invalid_request_error` — reading it as an ordinary bad request would
     * report a request bug for an empty wallet.
     */
    public static function isBillingError(Throwable $e): bool
    {
        for ($current = $e; $current !== null; $current = $current->getPrevious()) {
            if (! $current instanceof APIStatusException) {
                continue;
            }

            if ($current->type === ErrorType::BILLING_ERROR || $current->status === 402) {
                return true;
            }

            if (stripos($current->getMessage(), 'credit balance') !== false) {
                return true;
            }
        }

        return false;
    }

    /** Stamp the refusal. The first one's time is kept: "since" is when it ran out. */
    public static function record(): void
    {
        $now = CarbonImmutable::now()->toIso8601String();
        $since = self::stored()['since'] ?? $now;

        Setting::put(self::KEY, ['since' => $since, 'last_refused_at' => $now]);
    }

    /**
     * A call went through, so there is credit again.
     *
     * Read before written: this runs after every successful call, and a write
     * per call against the WAL database would be a writer for a flag that is
     * almost always already clear.
     */
    public static function clear(): void
    {
        if (self::stored() !== null) {
            Setting::query()->whereKey(self::KEY)->delete();
        }
    }

    public static function exhausted(): bool
    {
        return self::stored() !== null;
    }

    /**
     * The flag as `/api/health` reports it.
     *
     * @return array{exhausted: bool, since: string|null, last_refused_at: string|null}
     */
    public static function state(): array
    {
        $stored = self::stored();

        return [
            'exhausted' => $stored !== null,
            'since' => $stored['since'] ?? null,
            'last_refused_at' => $stored['last_refused_at'] ?? null,
        ];
    }

    /** @return array{since: string, last_refused_at: string}|null */
    private static function stored(): ?array
    {
        $value = Setting::value(self::KEY);

        // A hand-edited row that is not this shape is read as clear rather
        // than as a refusal nobody can date.
        return is_array($value) && is_string($value['since'] ?? null) && is_string($value['last_refused_at'] ?? null)
            ? $value
            : null;
    }
}
