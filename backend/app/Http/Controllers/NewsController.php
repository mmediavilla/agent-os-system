<?php

namespace App\Http\Controllers;

use App\Agent\Tools\GetNews;
use App\Models\PinnedArticle;
use App\Services\News\ArticleNotHeld;
use App\Services\News\NewsService;
use App\Services\News\PinWriter;
use App\Services\NewsSettings;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;

/**
 * The news for the HUD, and the owner's reading list.
 *
 * **The HUD reads without marking.** `get_news` flags what the assistant has
 * already told the owner; browsing the overlay is not being told, so this
 * reads with `markSeen` off and a later briefing is not thinned by it.
 *
 * **The browser never sends a URL.** Pinning posts an `item_id` the service
 * handed out, and {@see PinWriter} resolves it, `pin_articles`' rule — so the
 * reading list only ever holds what the service itself read.
 *
 * Nothing here calls a model, so none of it is under `throttle:agent`. A read
 * asks an outlet only once its own cache is due, so an overlay left open costs
 * what the assistant's reads already cost.
 */
class NewsController extends Controller
{
    public function __construct(
        private readonly NewsService $news,
        private readonly PinWriter $writer,
    ) {}

    /**
     * GET /api/news?beat=&query=
     *
     * A beat's latest (the first beat when none is named), or the owner's
     * interests. Each item says whether it is pinned, and by which pin, and `beats` lists every
     * beat in the order it is offered, so the screen keeps no copy of the
     * config.
     */
    public function index(Request $request): JsonResponse
    {
        $beats = $this->news->beats();

        $data = $request->validate([
            'beat' => ['nullable', 'string', Rule::in([...array_keys($beats), GetNews::INTERESTS])],
            'query' => ['nullable', 'string', 'max:100'],
        ]);

        $beat = $data['beat'] ?? array_key_first($beats);

        $result = $beat === GetNews::INTERESTS
            ? $this->news->interests(NewsSettings::interests())
            : $this->news->beat($beat, $data['query'] ?? null);

        // `pin_id` beside `pinned`: unpinning deletes the pin's row, and the
        // overlay has nothing else to name it by.
        $pins = PinnedArticle::whereIn('item_id', array_column($result['items'], 'id'))->pluck('id', 'item_id')->all();
        $result['items'] = array_map(fn (array $item) => $item + [
            'pinned' => isset($pins[$item['id']]),
            'pin_id' => $pins[$item['id']] ?? null,
        ], $result['items']);

        return response()->json($result + [
            'beats' => [
                ...array_map(fn (string $key, string $label) => ['key' => $key, 'label' => $label], array_keys($beats), $beats),
                ['key' => GetNews::INTERESTS, 'label' => 'Your interests'],
            ],
        ]);
    }

    /** GET /api/news/pins — unread first, then read, each newest pin first. */
    public function pins(): JsonResponse
    {
        return response()->json([
            'data' => PinnedArticle::inReadingOrder()->get(),
            'unread' => PinnedArticle::status('unread')->count(),
        ]);
    }

    /**
     * POST /api/news/pins { item_id }
     *
     * 201 with the new row, or 200 with the one already there. An id the
     * registry no longer holds is a 422 sentence — the item was handed out
     * more than `news.item_days` ago, and reading the news again gives a
     * fresh one.
     */
    public function pin(Request $request): JsonResponse
    {
        $data = $request->validate([
            'item_id' => ['required', 'string', 'regex:/^[0-9a-f]{12}$/'],
        ]);

        try {
            [$done] = $this->writer->pin([['id' => $data['item_id']]]);
        } catch (ArticleNotHeld $e) {
            throw ValidationException::withMessages(['item_id' => $e->getMessage()]);
        }

        return response()->json($done['pin'], $done['outcome'] === PinWriter::PINNED ? 201 : 200);
    }

    /** POST /api/news/pins/{pin}/read — marking twice keeps the first time. */
    public function read(PinnedArticle $pin): JsonResponse
    {
        return response()->json($this->writer->read($pin));
    }

    /** DELETE /api/news/pins/{pin}/read — back on the unread list. */
    public function reopen(PinnedArticle $pin): JsonResponse
    {
        return response()->json($this->writer->reopen($pin));
    }

    /** DELETE /api/news/pins/{pin} — off the list. */
    public function unpin(PinnedArticle $pin): JsonResponse
    {
        $this->writer->remove($pin);

        return response()->json(null, 204);
    }
}
