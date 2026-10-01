<?php

namespace App\Services\Auth;

use RuntimeException;

/**
 * A sign-in that did not end in a token, carrying the sentence the login screen
 * shows. The message is written for a person and never quotes the code, the
 * state or anything Google sent back.
 */
final class SignInRefused extends RuntimeException
{
    public function __construct(
        string $message,
        public readonly int $status,
        public readonly string $reason,
    ) {
        parent::__construct($message);
    }
}
