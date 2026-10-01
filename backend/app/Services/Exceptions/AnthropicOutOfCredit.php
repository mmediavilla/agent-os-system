<?php

namespace App\Services\Exceptions;

use RuntimeException;
use Throwable;

/**
 * Thrown when Anthropic refuses a call because the account has no credit.
 *
 * Its own type for `AnthropicDisabled`'s reason: the SDK's message is a
 * pretty-printed JSON dump of the response, which is what the chat banner used
 * to show, and "out of credit" needs different words from "the call failed" —
 * the fix is a top-up, not a retry and not `.env`.
 */
class AnthropicOutOfCredit extends RuntimeException
{
    public const MESSAGE = 'The Anthropic account is out of credit. Top up at console.anthropic.com/settings/billing, then ask again.';

    public function __construct(?Throwable $previous = null)
    {
        parent::__construct(self::MESSAGE, 0, $previous);
    }
}
