<?php

namespace App\Services\News;

use App\Models\PinnedArticle;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;

/**
 * The one place a pin is written, `FactWriter`'s rule on a reading list.
 *
 * The `pin_articles` tool and the HUD's Pin button both come through here, and
 * both send **an id, never a URL**: each is resolved against the item registry
 * ({@see NewsService::item()}), so what lands on the list is something the
 * service itself handed out. The row is a snapshot of that item, because the
 * registry forgets and a pin must not.
 *
 * **All or nothing.** Every id is resolved before anything is written, and the
 * writes share one transaction, so "pin these three" with a stale third id
 * pins none — the model is told which, fetches again, and asks once more,
 * rather than leaving the owner with two of three and a card that said three.
 */
final class PinWriter
{
    public const PINNED = 'pinned';

    public const ALREADY_PINNED = 'already_pinned';

    public function __construct(private readonly NewsService $news) {}

    /**
     * Pin each item, once.
     *
     * A `title`, where one is given, must be the one held under that id: it is
     * what the approval card shows the owner, so a title that disagrees with
     * the id would have them approve one story and pin another.
     *
     * **Re-pinning is a no-op that returns the row** — read or not. It is the
     * same article, and pinning it again is not news; a read pin is reopened
     * with its own route.
     *
     * @param  list<array{id: string, title?: ?string}>  $items
     * @return list<array{pin: PinnedArticle, outcome: 'pinned'|'already_pinned'}>
     *
     * @throws ArticleNotHeld
     */
    public function pin(array $items): array
    {
        $plan = [];

        foreach ($items as $item) {
            $id = (string) $item['id'];

            if (isset($plan[$id])) {
                continue;
            }

            $existing = PinnedArticle::where('item_id', $id)->first();
            $held = $existing === null ? $this->news->item($id) : null;

            if ($existing === null && $held === null) {
                throw ArticleNotHeld::id($id);
            }

            $title = $existing?->title ?? $held['title'];

            if (isset($item['title']) && self::normal($item['title']) !== self::normal($title)) {
                throw ArticleNotHeld::title($id);
            }

            $plan[$id] = $existing ?? $held;
        }

        return DB::transaction(fn () => array_values(array_map(function (PinnedArticle|array $entry) {
            if ($entry instanceof PinnedArticle) {
                return ['pin' => $entry, 'outcome' => self::ALREADY_PINNED];
            }

            return ['pin' => PinnedArticle::create([
                'item_id' => $entry['id'],
                'title' => mb_substr($entry['title'], 0, 500),
                'source' => mb_substr($entry['source'], 0, 160),
                'link' => $entry['link'],
                'summary' => $entry['summary'] ?? null,
                'published_at' => $entry['published_at'] === null ? null : CarbonImmutable::parse($entry['published_at']),
            ]), 'outcome' => self::PINNED];
        }, $plan)));
    }

    /** Mark read. Marking twice keeps the first time, the deadlines' rule. */
    public function read(PinnedArticle $pin): PinnedArticle
    {
        if ($pin->read_at === null) {
            $pin->forceFill(['read_at' => now()])->save();
        }

        return $pin;
    }

    /** Back on the unread list, for a mis-click or a second look. */
    public function reopen(PinnedArticle $pin): PinnedArticle
    {
        if ($pin->read_at !== null) {
            $pin->forceFill(['read_at' => null])->save();
        }

        return $pin;
    }

    /** Off the list. A pin is a bookmark, so nothing else goes with it. */
    public function remove(PinnedArticle $pin): void
    {
        $pin->delete();
    }

    /** Case and spacing aside, the same words. */
    private static function normal(string $title): string
    {
        return mb_strtolower(trim(preg_replace('/\s+/u', ' ', $title) ?? $title));
    }
}
