<?php

namespace App\Agent\Support;

use App\Agent\Exceptions\SnapshotRejected;
use App\Models\Conversation;
use App\Models\Snapshot;
use App\Services\AssistantSettings;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;

/**
 * Where a camera frame goes, and what it costs to keep sending it.
 *
 * Two decisions live here and both are about the second half of that sentence.
 *
 * **The bytes are not in the transcript.** A snapshot is stored on the private
 * disk and the turn holds a reference to it, so opening a thread ships a URL
 * rather than a hundred kilobytes of base64 to the browser, and a client can
 * let the browser cache the picture the way it caches an equipment photo. The
 * cost of that is one exception to MessageCodec's "stored verbatim, replayed
 * verbatim" rule, and it is a narrow one: the rule exists to protect *assistant*
 * turns, whose thinking signatures must come back byte-identical. A user's
 * image block is not something the model wrote.
 *
 * **An image is not paid for once.** It is re-sent on every subsequent turn of
 * every subsequent loop, which is the same trap ResultEncoder's 20KB cap exists
 * for and a more expensive one — a 1024px frame is around eleven hundred tokens
 * every time the transcript goes back up. So only the most recent few are
 * carried; older ones degrade to a line of text saying a picture used to be
 * there. That is visible to the model rather than silent, for the same reason
 * an over-budget tool result says it was truncated.
 *
 * The daily ceiling is the third control and the bluntest. It is not there for
 * a person pressing a button — nobody presses it forty times — but for the
 * failure where something else does.
 */
final class SnapshotStore
{
    /** What the Messages API accepts, intersected with what a canvas emits. */
    public const MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

    /** Ceiling, size and replay depth, in case config is missing them. */
    public const PER_DAY = 25;

    public const MAX_KB = 1500;

    public const REPLAY = 3;

    /** On the private disk: `snapshots/{conversation}/{ulid}.{ext}`. */
    public const DIRECTORY = 'snapshots';

    /**
     * Decode, check and keep one frame.
     *
     * @param  string  $data  bare base64 — a `data:` URL is the client's to unwrap
     *
     * @throws SnapshotRejected
     */
    public static function store(Conversation $conversation, string $data, string $mediaType): Snapshot
    {
        if (! in_array($mediaType, self::MEDIA_TYPES, true)) {
            throw SnapshotRejected::unsupportedType($mediaType);
        }

        $binary = base64_decode($data, true);

        if ($binary === false || $binary === '') {
            throw SnapshotRejected::notBase64();
        }

        $limit = self::maxBytes();

        if (strlen($binary) > $limit) {
            throw SnapshotRejected::tooLarge(strlen($binary), $limit);
        }

        // Not belt and braces: without this, arbitrary bytes are written to disk
        // and streamed back later under an image content type, on the strength
        // of a header the client chose. `getimagesizefromstring` is ext/standard
        // rather than GD, so it is there in every build this runs on.
        $size = @getimagesizefromstring($binary);

        if ($size === false) {
            throw SnapshotRejected::notAnImage();
        }

        $actual = $size['mime'] ?? '';

        if ($actual !== $mediaType) {
            throw SnapshotRejected::mismatched($mediaType, $actual !== '' ? $actual : 'something else');
        }

        $path = sprintf('%s/%d/%s.%s', self::DIRECTORY, $conversation->id, Str::ulid(), self::extension($mediaType));

        Storage::put($path, $binary);

        return Snapshot::create([
            'conversation_id' => $conversation->id,
            'path' => $path,
            'media_type' => $mediaType,
            'bytes' => strlen($binary),
            'width' => $size[0] ?? null,
            'height' => $size[1] ?? null,
        ]);
    }

    /**
     * Frame files on the disk that no row points at — the one definition both
     * the Storage check and Troubleshoot's `prune_orphan_snapshots` read, so what
     * the report counts is what the fix deletes.
     *
     * @return list<string>
     */
    public static function orphanFiles(): array
    {
        $known = array_flip(Snapshot::query()->pluck('path')->filter()->all());

        return array_values(array_filter(
            Storage::allFiles(self::DIRECTORY),
            fn (string $path) => ! isset($known[$path]),
        ));
    }

    /**
     * Refuse before anything is decoded, if today is already spent.
     *
     * The window is the *user's* day, not the server's. This machine runs on
     * UTC and its owner is eight hours ahead of it, so a ceiling that reset at
     * midnight UTC would reset in the middle of their afternoon — the same
     * reason the calendar's times are wall clock.
     *
     * @throws SnapshotRejected
     */
    public static function guardDailyCeiling(): void
    {
        $ceiling = self::perDay();

        if (self::takenToday() >= $ceiling) {
            throw SnapshotRejected::overDailyCeiling($ceiling);
        }
    }

    /** How many snapshots have been stored so far on the user's own day. */
    public static function takenToday(): int
    {
        $zone = config('agent.timezone', 'UTC');

        $startOfDay = Carbon::now($zone)->startOfDay()->utc();

        return Snapshot::query()->where('created_at', '>=', $startOfDay)->count();
    }

    // -- the transcript's side ------------------------------------------------

    /**
     * The block a stored turn carries in place of the picture.
     *
     * Deliberately shaped like a wire image block with an unfamiliar `source`
     * rather than as a type of its own: everything that walks a transcript
     * already knows to leave a block type it does not recognise alone, and this
     * way a reader that only asks "is this an image?" gets the right answer.
     *
     * @return array<string, mixed>
     */
    public static function block(Snapshot $snapshot): array
    {
        return [
            'type' => 'image',
            'source' => [
                'type' => 'snapshot',
                'id' => $snapshot->id,
                'media_type' => $snapshot->media_type,
            ],
        ];
    }

    /** The snapshot id a reference block points at, or null for anything else. */
    public static function referencedId(mixed $block): ?int
    {
        if (! is_array($block) || ($block['type'] ?? null) !== 'image') {
            return null;
        }

        $source = $block['source'] ?? null;

        if (! is_array($source) || ($source['type'] ?? null) !== 'snapshot') {
            return null;
        }

        $id = $source['id'] ?? null;

        return is_int($id) || (is_string($id) && ctype_digit($id)) ? (int) $id : null;
    }

    /**
     * The same block with the bytes in it, as the API takes an image.
     *
     * @return array<string, mixed>
     */
    public static function inlineBlock(Snapshot $snapshot, string $binary): array
    {
        return [
            'type' => 'image',
            'source' => [
                'type' => 'base64',
                'media_type' => $snapshot->media_type,
                'data' => base64_encode($binary),
            ],
        ];
    }

    /**
     * What stands in for a picture that is no longer being carried.
     *
     * A text block rather than a dropped one. Silently removing it would leave
     * "what do you make of this?" with nothing to make anything of, and the
     * model has no way to tell that apart from a question that never had a
     * picture — so it says which, and when.
     *
     * @return array<string, mixed>
     */
    public static function droppedBlock(?Snapshot $snapshot): array
    {
        $when = $snapshot?->created_at?->setTimezone(config('agent.timezone', 'UTC'))->format('D j M, H:i');

        return [
            'type' => 'text',
            'text' => $when
                ? "[A camera snapshot taken on {$when} was attached here. It is no longer being sent, to keep this conversation affordable. Ask for a fresh one if you need to see it.]"
                : '[A camera snapshot was attached here and is no longer available.]',
        ];
    }

    // -- settings -------------------------------------------------------------

    public static function perDay(): int
    {
        return max(0, (int) config('agent.snapshots.per_day', self::PER_DAY));
    }

    public static function maxBytes(): int
    {
        return max(1, (int) config('agent.snapshots.max_kb', self::MAX_KB)) * 1024;
    }

    /** How many of a transcript's snapshots still go back up with it. */
    public static function replayDepth(): int
    {
        return AssistantSettings::snapshotReplay();
    }

    private static function extension(string $mediaType): string
    {
        return match ($mediaType) {
            'image/png' => 'png',
            'image/webp' => 'webp',
            default => 'jpg',
        };
    }
}
