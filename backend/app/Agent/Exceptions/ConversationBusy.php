<?php

namespace App\Agent\Exceptions;

use RuntimeException;

/**
 * Thrown when a conversation is asked to move while a proposed write is still
 * undecided.
 *
 * Not a niceness check. The transcript at that moment ends with an assistant
 * turn holding `tool_use` blocks that have no results yet; appending a fresh
 * user message would produce a request the API rejects outright, and the
 * conversation would be unrecoverable rather than merely confused.
 */
class ConversationBusy extends RuntimeException
{
    public static function make(): self
    {
        return new self('This conversation is waiting on a decision. Approve or decline the pending action first.');
    }
}
