<?php

namespace App\Services\Exceptions;

use RuntimeException;

/**
 * Thrown when something asks Claude a question while the switch is off.
 *
 * A distinct type rather than a generic `RuntimeException` for one reason: the
 * two ways a model call can be unavailable need different words and different
 * status codes. A missing `ANTHROPIC_API_KEY` is a machine that was never
 * finished being set up — 502, and the fix is in `.env`. A switch that is off
 * is a decision the user made and can unmake in one tap — 503, and the fix is
 * on the Settings screen. Collapsing them would send someone hunting for a
 * configuration problem they created on purpose.
 */
class AnthropicDisabled extends RuntimeException
{
    public const MESSAGE = 'The Anthropic API is switched off. Turn it back on in Settings to let the assistant answer.';

    public function __construct(string $message = self::MESSAGE)
    {
        parent::__construct($message);
    }
}
