<?php

namespace App\Services\Documents;

use App\Models\Document;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;

/**
 * The one place a document's bytes are written, read for their type, or
 * deleted — `FactWriter`'s rule, applied to a disk instead of a table.
 *
 * Three callers reach it: the upload route, the route that clears a file, and
 * the model's `deleting` hook. Keeping them all here is what makes "a stored
 * file always has a row pointing at it, and the type in that row is the type of
 * the bytes" true by construction rather than by three people remembering.
 *
 * **The bytes decide the type, and nothing else does.** The browser's declared
 * content type is never consulted: it is chosen by whoever is uploading, and a
 * file stored on its word would be streamed back later under a content type it
 * does not have — which is how a served "document" becomes something a browser
 * executes. A PDF is recognised by its `%PDF-` magic and a picture by
 * `getimagesize`, and anything neither of those recognises is refused.
 *
 * Storage is the equipment photo's, again: the private disk, streamed by a
 * route. Not the `public` disk with `storage:link`, which is one more step to
 * get wrong on a fresh checkout and needs privileges on Windows that are not
 * always there — and, since Phase 14, a route is the only kind of read that can
 * be put behind the gate.
 */
final class DocumentStore
{
    /** Everything lives under this prefix on the private disk. */
    public const DIR = 'documents';

    /** What a document may be, as recognised from its own first bytes. */
    public const MEDIA_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];

    /** The size cap, in case config is missing it. */
    public const MAX_KB = 20480;

    /**
     * Put this file on the record, replacing whatever was there.
     *
     * The row is always saved, even when only the path changed, so `updated_at`
     * moves — the signed URL carries it as `?v=`, and a replacement that did not
     * change the URL would be served from the browser's cache as the old file
     * for as long as `immutable` says to.
     *
     * @throws DocumentRejected
     */
    public static function attach(Document $document, UploadedFile $file): Document
    {
        $limit = self::maxBytes();
        $bytes = (int) $file->getSize();

        // Checked before anything is read or written: a 20MB refusal should
        // cost a stat() rather than a copy onto the disk it was refused from.
        if ($bytes > $limit) {
            throw DocumentRejected::tooLarge($bytes, $limit);
        }

        $mime = self::inspect($file->getRealPath());

        self::discard($document);

        $path = Storage::putFileAs(self::DIR, $file, Str::ulid().'.'.self::extension($mime));

        $document->forceFill([
            'file_path' => $path,
            'mime' => $mime,
            'size_bytes' => $bytes,
        ])->save();

        return $document;
    }

    /**
     * Take the file off the record and off the disk. The row stays: a document
     * somebody has not scanned yet is still a document they are keeping track
     * of.
     */
    public static function detach(Document $document): Document
    {
        self::discard($document);

        $document->forceFill([
            'file_path' => null,
            'mime' => null,
            'size_bytes' => null,
        ])->save();

        return $document;
    }

    /**
     * Delete the file alone, leaving the columns as they are.
     *
     * Called by the model's `deleting` hook as well as from here, which is why
     * it is safe to call for a row that has no file: missing is the desired end
     * state, and a checkout whose storage folder was never copied reaches it
     * without any of this having run.
     */
    public static function discard(Document $document): void
    {
        if ($document->file_path && Storage::exists($document->file_path)) {
            Storage::delete($document->file_path);
        }
    }

    public static function maxBytes(): int
    {
        return max(1, (int) config('documents.max_kb', self::MAX_KB)) * 1024;
    }

    /**
     * What these bytes actually are.
     *
     * @throws DocumentRejected when they are not a document this app serves
     */
    private static function inspect(string $path): string
    {
        // The header is five bytes at offset zero; a thousand is read because
        // that is one cheap fread either way.
        $head = (string) @file_get_contents($path, false, null, 0, 1024);

        if (str_starts_with($head, '%PDF-')) {
            return 'application/pdf';
        }

        // ext/standard rather than GD, so it is present in every build this
        // runs on — the same call that vets a camera frame.
        $size = @getimagesize($path);
        $mime = is_array($size) ? ($size['mime'] ?? '') : '';

        if (in_array($mime, self::MEDIA_TYPES, true)) {
            return $mime;
        }

        throw DocumentRejected::unsupported();
    }

    private static function extension(string $mime): string
    {
        return match ($mime) {
            'application/pdf' => 'pdf',
            'image/png' => 'png',
            'image/webp' => 'webp',
            default => 'jpg',
        };
    }
}
