<?php

namespace App\Http\Controllers;

use App\Http\Controllers\Concerns\PaginatesIndex;
use App\Models\Deadline;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;

/**
 * Dates somebody must act on, and whether they have been.
 *
 * Every row answers with its `document` loaded (or null), so the Deadlines tab
 * can name and open the policy a renewal is about without a second request.
 *
 * **Completing is its own route**, and so is taking it back. A PATCH carries
 * fields and nothing else, so an edit cannot tick a deadline off by accident,
 * and a mis-click on Done is one request to undo rather than a lost row.
 */
class DeadlineController extends Controller
{
    use PaginatesIndex;

    /**
     * GET /api/deadlines
     *
     * **Every row by default, open and completed alike** — the catalog rule
     * applied to a status rather than a page: a default that hid completed
     * rows would silently shorten the one caller that shows them.
     * `status=open|completed` narrows it; `per_page` pages it.
     */
    public function index(Request $request): JsonResponse
    {
        $request->validate([
            'status' => ['nullable', Rule::in(Deadline::STATUSES)],
        ]);

        $query = Deadline::with('document')
            ->status($request->query('status'))
            ->searchText($request->query('search'))
            ->applyFilters($request->query())
            ->inAgendaOrder();

        return $this->paginatedResponse($request, $query);
    }

    /** POST /api/deadlines */
    public function store(Request $request): JsonResponse
    {
        // No owner passed: `BelongsToOwner` stamps it at `creating`.
        $deadline = Deadline::create($request->validate($this->rules()));

        return response()->json($deadline->load('document'), 201);
    }

    /** PATCH /api/deadlines/{deadline} — any of the writable fields. */
    public function update(Request $request, Deadline $deadline): JsonResponse
    {
        $deadline->update($request->validate($this->rules(partial: true)));

        return response()->json($deadline->load('document'));
    }

    /** DELETE /api/deadlines/{deadline} — the linked document is untouched. */
    public function destroy(Deadline $deadline): JsonResponse
    {
        $deadline->delete();

        return response()->json(null, 204);
    }

    /**
     * POST /api/deadlines/{deadline}/complete
     *
     * **Completing twice keeps the first date.** A second tab, or a double
     * click, must not move "done on the 3rd" to the 5th — the date is the
     * answer to "when did I last do this", and restating it is not new
     * information. `FactWriter`'s rule about re-saving what is on file.
     */
    public function complete(Deadline $deadline): JsonResponse
    {
        if ($deadline->completed_at === null) {
            $deadline->forceFill(['completed_at' => now()])->save();
        }

        return response()->json($deadline->load('document'));
    }

    /** DELETE /api/deadlines/{deadline}/complete — open again, for a mis-click. */
    public function reopen(Deadline $deadline): JsonResponse
    {
        if ($deadline->completed_at !== null) {
            $deadline->forceFill(['completed_at' => null])->save();
        }

        return response()->json($deadline->load('document'));
    }

    /**
     * The row's writable fields.
     *
     * `kind` is free text, `Document::KINDS`' rule. `due_on` is required — a
     * deadline without a date is a note, and notes are what a document's
     * `notes` are for. The format is pinned to `Y-m-d` because the column is a
     * wall-calendar date: `2026-04-15T00:00:00Z` parsed on this UTC server
     * would land on the right day by luck, and one with an offset would not.
     *
     * `partial` is what a PATCH sends: every rule keeps its own validation and
     * only becomes optional, so a field that *is* sent is never half-checked.
     */
    private function rules(bool $partial = false): array
    {
        $sometimes = $partial ? ['sometimes'] : [];

        return [
            'title' => [...$sometimes, 'required', 'string', 'max:160'],
            'due_on' => [...$sometimes, 'required', 'date_format:Y-m-d'],
            'kind' => [...$sometimes, 'required', 'string', 'max:40'],
            'document_id' => ['nullable', 'integer', Rule::exists('documents', 'id')],
            'notes' => ['nullable', 'string'],
        ];
    }
}
