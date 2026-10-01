<?php

namespace App\Agent\Exceptions;

use RuntimeException;

/**
 * A camera frame this app will not carry.
 *
 * Every reason is the user's to see rather than the model's: the frame never
 * reaches a transcript, so there is no `tool_result` to mark `is_error` and no
 * self-correction to invite. It is an HTTP answer, and it carries its own
 * status because the three refusals are genuinely different — a frame that is
 * too big (413) is a bug in whoever encoded it, a frame that is not an image
 * (422) is a bad request, and the daily ceiling (429) is the one refusal that
 * goes away on its own.
 */
class SnapshotRejected extends RuntimeException
{
    public function __construct(string $message, public readonly int $status = 422)
    {
        parent::__construct($message);
    }

    public static function unsupportedType(string $type): self
    {
        return new self("Snapshots must be JPEG, PNG or WebP; this one said {$type}.", 422);
    }

    public static function notBase64(): self
    {
        return new self('The snapshot was not valid base64.', 422);
    }

    public static function notAnImage(): self
    {
        return new self('The snapshot did not decode to an image.', 422);
    }

    public static function mismatched(string $declared, string $actual): self
    {
        return new self("The snapshot says it is {$declared} and is actually {$actual}.", 422);
    }

    public static function tooLarge(int $bytes, int $limit): self
    {
        $kb = static fn (int $n): int => (int) ceil($n / 1024);

        return new self(
            "The snapshot is {$kb($bytes)}KB and the limit is {$kb($limit)}KB. Capture it at a smaller size.",
            413,
        );
    }

    public static function overDailyCeiling(int $ceiling): self
    {
        return new self(
            "That is {$ceiling} snapshots today, which is the daily ceiling. It resets at midnight.",
            429,
        );
    }
}
