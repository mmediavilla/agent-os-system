<?php

namespace App\Services\Documents;

use App\Agent\Exceptions\SnapshotRejected;
use RuntimeException;

/**
 * A file this app will not keep.
 *
 * Shaped like {@see SnapshotRejected} and for the same
 * reason: the two refusals want different things done about them, so each
 * carries its own status rather than being flattened into one 422. A file that
 * is too big (413) is a choice the owner can make again with a smaller scan; a
 * file whose bytes are not a document at all (422) is a bad request.
 *
 * Every message is written for the owner, who is standing at the form — there
 * is no model here to self-correct.
 */
class DocumentRejected extends RuntimeException
{
    public function __construct(string $message, public readonly int $status = 422)
    {
        parent::__construct($message);
    }

    public static function tooLarge(int $bytes, int $limit): self
    {
        $mb = static fn (int $n): string => number_format($n / 1048576, 1);

        return new self(
            "That file is {$mb($bytes)}MB and the limit is {$mb($limit)}MB.",
            413,
        );
    }

    /**
     * PHP dropped the file before Laravel saw it, because it is over
     * `upload_max_filesize` — Herd ships 2M, a tenth of `documents.max_kb`.
     * Without this the owner reads "The file failed to upload.", which names
     * neither the cause nor the fix.
     */
    public static function overPhpLimit(): self
    {
        return new self(
            'That file is bigger than PHP on this machine accepts (upload_max_filesize is '
            .ini_get('upload_max_filesize').'). Raise it in Herd — PHP → Max file upload size — or upload a smaller scan.',
            413,
        );
    }

    public static function unsupported(): self
    {
        return new self(
            'A document has to be a PDF or a picture (JPEG, PNG or WebP). Those bytes are neither.',
            422,
        );
    }
}
