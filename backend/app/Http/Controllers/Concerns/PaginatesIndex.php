<?php

namespace App\Http\Controllers\Concerns;

use Illuminate\Database\Eloquent\Builder;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * Page-at-a-time index responses for the catalog endpoints.
 *
 * Pagination is opt-in: a request that names no `per_page` gets every matching
 * row, exactly as it did before pages existed. That is deliberate rather than
 * lazy — the exercise form fetches the whole equipment catalog to fill its
 * picker, and a default page size would silently shorten that vocabulary
 * instead of failing loudly. Screens that show a list ask for a page; callers
 * that need a complete set simply do not.
 *
 * `meta` is present either way, so a caller can label "1–25 of 137" without
 * having to remember which mode it asked for. `per_page` is null in the
 * unpaginated case, where there is no page size to report.
 */
trait PaginatesIndex
{
    /** Ceiling on `per_page`, so one request cannot ask for the whole table back. */
    private const MAX_PER_PAGE = 100;

    /**
     * Run `$query` and wrap it in the `{ data, meta }` envelope both catalogs
     * return. `$query` must already carry its ordering and filters.
     */
    protected function paginatedResponse(Request $request, Builder $query): JsonResponse
    {
        // Eloquent's count() clones the builder and drops the ORDER BY, so this
        // neither disturbs $query nor pays for a sort it throws away.
        $total = $query->count();

        if (! $request->filled('per_page')) {
            return $this->pageResponse($query->get(), page: 1, perPage: null, total: $total, lastPage: 1);
        }

        $perPage = max(1, min((int) $request->query('per_page'), self::MAX_PER_PAGE));
        $lastPage = max(1, (int) ceil($total / $perPage));

        // Clamped rather than rejected: deleting the last row of the last page
        // leaves the client asking for a page that no longer exists, and the
        // final page is a better answer there than an error it has to recover
        // from. `meta.page` reports what was actually served.
        $page = max(1, min((int) $request->query('page', 1), $lastPage));

        return $this->pageResponse(
            $query->forPage($page, $perPage)->get(),
            page: $page,
            perPage: $perPage,
            total: $total,
            lastPage: $lastPage,
        );
    }

    private function pageResponse($rows, int $page, ?int $perPage, int $total, int $lastPage): JsonResponse
    {
        // 1-based bounds of this page within the filtered set, for a "showing
        // x–y of z" label. Null when the page is empty, because there is no
        // first or last row to point at.
        $from = $rows->isEmpty() ? null : ($perPage === null ? 1 : ($page - 1) * $perPage + 1);
        $to = $from === null ? null : $from + $rows->count() - 1;

        return response()->json([
            'data' => $rows,
            'meta' => [
                'page' => $page,
                'per_page' => $perPage,
                'total' => $total,
                'last_page' => $lastPage,
                'from' => $from,
                'to' => $to,
            ],
        ]);
    }
}
