<?php

namespace App\Agent\Support;

use App\Models\ConversationMessage;
use App\Models\Snapshot;

/**
 * The one place a stored turn becomes a wire turn, and back.
 *
 * It is much smaller than it was designed to be. The plan assumed a snake_case ↔
 * camelCase mapping in both directions; a spike showed the API accepts
 * `json_encode($response->content)` handed straight back as an assistant turn,
 * thinking signatures and all. So there is no mapping — the transcript is stored
 * in wire shape and replayed verbatim, and what remains here is the small amount
 * of block-shaped reading and writing the runner does either side of that.
 *
 * The invariant every method depends on: **`content` is always a list of blocks,
 * never a string.** The API accepts a bare string as shorthand for one text
 * block, and taking that shorthand would mean every reader below branching on
 * the shape it found.
 */
final class MessageCodec
{
    /**
     * One `tool_result` block.
     *
     * `is_error` is not a transport failure — it is how the model is shown that
     * *this call* was wrong so it can fix its arguments and try again. A tool
     * that throws, and a write the user declined, both arrive this way.
     */
    public static function toolResultBlock(string $toolUseId, string $content, bool $isError = false): array
    {
        return array_filter([
            'type' => 'tool_result',
            'tool_use_id' => $toolUseId,
            'content' => $content,
            'is_error' => $isError ?: null,
        ], fn ($v) => $v !== null);
    }

    /**
     * A stored transcript as the `messages` parameter.
     *
     * Empty turns are dropped rather than sent: the API rejects a message with
     * no content, and one would otherwise be able to reach the transcript from a
     * turn that stopped before emitting a block.
     *
     * **Camera snapshots are the one thing not replayed verbatim**, and the
     * exception is narrower than it sounds. The verbatim rule exists to protect
     * assistant turns — a thinking block's signature has to come back
     * byte-identical or the next request is refused — and a snapshot is
     * something the *user* attached. Its bytes live on disk rather than in the
     * turn, so they are put back here; and only the most recent few are, because
     * an image is re-sent on every later turn of every later loop and a
     * transcript with six of them in it costs six of them every time. See
     * {@see SnapshotStore}.
     *
     * @param  iterable<ConversationMessage>  $messages
     * @return list<array<string, mixed>>
     */
    public static function transcript(iterable $messages): array
    {
        $messages = is_array($messages) ? $messages : iterator_to_array($messages);

        $snapshots = self::snapshotContext($messages);

        $wire = [];

        foreach ($messages as $message) {
            $content = $message->content;

            if (! is_array($content) || $content === []) {
                continue;
            }

            $wire[] = [
                'role' => $message->role,
                'content' => $snapshots === null
                    ? array_values($content)
                    : array_values(array_map(fn ($block) => self::withSnapshot($block, $snapshots), $content)),
            ];
        }

        return $wire;
    }

    /**
     * Every snapshot this transcript mentions, and which of them still go up —
     * or null when it mentions none, which is every conversation that never
     * used the camera.
     *
     * Null rather than an empty map so that the ordinary case costs no query,
     * no config read and no second pass over the blocks. `MessageCodecTest` is
     * a unit test with no database behind it, and this is what keeps it one.
     *
     * *Every* one is loaded rather than only the carried few, because a picture
     * that is being dropped still has to say when it was taken — a note with no
     * date on it is barely better than the silence it replaces.
     *
     * @param  list<ConversationMessage>  $messages
     * @return array{rows: array<int, Snapshot>, carried: array<int, true>}|null
     */
    private static function snapshotContext(array $messages): ?array
    {
        $ids = [];

        foreach ($messages as $message) {
            foreach (is_array($message->content) ? $message->content : [] as $block) {
                if (($id = SnapshotStore::referencedId($block)) !== null) {
                    $ids[] = $id;
                }
            }
        }

        if ($ids === []) {
            return null;
        }

        $depth = SnapshotStore::replayDepth();

        // `array_slice($ids, -0)` is the whole array, not none of it, which
        // would make a replay depth of zero mean "carry everything".
        $carried = $depth === 0 ? [] : array_slice($ids, -$depth);

        return [
            'rows' => Snapshot::query()->whereIn('id', $ids)->get()->keyBy('id')->all(),
            'carried' => array_fill_keys($carried, true),
        ];
    }

    /**
     * One block, with a referenced snapshot put back into it.
     *
     * A snapshot that is not being carried, has been deleted, or whose file has
     * gone becomes a line of text saying so — never a dropped block. The
     * question attached to a picture usually does not make sense without one,
     * and the model cannot tell an image it was not shown from an image that
     * never existed unless it is told.
     *
     * @param  array{rows: array<int, Snapshot>, carried: array<int, true>}  $snapshots
     * @return array<string, mixed>|mixed
     */
    private static function withSnapshot(mixed $block, array $snapshots): mixed
    {
        $id = SnapshotStore::referencedId($block);

        if ($id === null) {
            return $block;
        }

        $snapshot = $snapshots['rows'][$id] ?? null;
        $binary = isset($snapshots['carried'][$id]) ? $snapshot?->contents() : null;

        return $snapshot && $binary !== null
            ? SnapshotStore::inlineBlock($snapshot, $binary)
            : SnapshotStore::droppedBlock($snapshot);
    }

    /**
     * The `tool_use` blocks of one assistant turn, in the order they were
     * emitted — which is the order their results go back in.
     *
     * @param  list<array<string, mixed>>  $content
     * @return list<array<string, mixed>>
     */
    public static function toolUses(array $content): array
    {
        return array_values(array_filter(
            $content,
            fn ($block) => is_array($block) && ($block['type'] ?? null) === 'tool_use',
        ));
    }

    /**
     * The prose of a turn.
     *
     * Every text block, joined — not the first one, which is what
     * `ClaudeService::complete()` takes. A turn that thinks, answers, calls a
     * tool and then answers again is normal here, and reading only the first
     * text block would quietly drop half of what was said.
     *
     * @param  list<array<string, mixed>>  $content
     */
    public static function text(array $content): string
    {
        $parts = [];

        foreach ($content as $block) {
            if (is_array($block) && ($block['type'] ?? null) === 'text' && is_string($block['text'] ?? null)) {
                $parts[] = $block['text'];
            }
        }

        return trim(implode("\n\n", $parts));
    }
}
