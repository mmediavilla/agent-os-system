<?php

namespace App\Http\Controllers;

use App\Models\Fact;
use App\Services\Facts\FactNotPending;
use App\Services\Facts\FactWriter;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;

/**
 * The Facts overlay: what the assistant has on file about the owner, what it
 * would like to add, and a way to tell it something directly.
 *
 * **Not a management system.** No filters and no pagination: facts are never
 * the point of a screen, they change every other answer, and the list is where
 * the owner checks what the assistant believes. The prompt block caps itself at
 * 2KB, so the whole set stays a page long for a long time.
 *
 * Every write goes through {@see FactWriter}, and a decision that finds its fact
 * already decided — in another tab — is a 409 sentence, never a second write.
 */
class FactController extends Controller
{
    public function __construct(private readonly FactWriter $writer) {}

    /** GET /api/facts → { active, proposed } */
    public function index(): JsonResponse
    {
        $active = Fact::active()->orderBy('category')->orderBy('key')->get();

        $proposed = Fact::query()
            ->where('status', Fact::PROPOSED)
            ->orderByDesc('learned_at')
            ->orderByDesc('id')
            ->get();

        // A proposal for a key already on file is a replacement, and the screen
        // shows it beside what it would replace. Read off the active list rather
        // than queried per row.
        $current = $active->keyBy(fn (Fact $fact) => $fact->category."\0".$fact->key);

        return response()->json([
            'active' => $active->map(fn (Fact $fact) => $this->present($fact))->all(),
            'proposed' => $proposed->map(fn (Fact $fact) => $this->present($fact) + [
                'replaces' => $current->get($fact->category."\0".$fact->key)?->value,
            ])->all(),
        ]);
    }

    /**
     * POST /api/facts { category, key, value }
     *
     * Typed by the owner, so it is `stated`, `manual` and on file at once. A
     * restatement of what is already there answers 200 with the existing row.
     */
    public function store(Request $request): JsonResponse
    {
        $data = $request->validate([
            'category' => ['required', 'string'],
            'key' => ['required', 'string'],
            'value' => ['required', 'string'],
        ]);

        // FactWriter normalises and validates the lengths itself, so its limits
        // are written down once.
        $fact = $this->writer->remember($data['category'], $data['key'], $data['value']);

        return response()->json($this->present($fact), $fact->wasRecentlyCreated ? 201 : 200);
    }

    /** PATCH /api/facts/{fact} { decision: keep|reject } — for a proposal. */
    public function update(Request $request, Fact $fact): JsonResponse
    {
        $data = $request->validate([
            'decision' => ['required', Rule::in(['keep', 'reject'])],
        ]);

        try {
            $fact = $data['decision'] === 'keep' ? $this->writer->keep($fact) : $this->writer->reject($fact);
        } catch (FactNotPending $e) {
            return response()->json(['message' => $e->getMessage()], 409);
        }

        return response()->json($this->present($fact));
    }

    /** DELETE /api/facts/{fact} — forget an active fact, history and all. */
    public function destroy(Fact $fact): JsonResponse
    {
        try {
            $forgotten = $this->writer->forget($fact);
        } catch (FactNotPending $e) {
            return response()->json(['message' => $e->getMessage()], 409);
        }

        return response()->json(['forgotten' => $forgotten]);
    }

    /** @return array<string, mixed> */
    private function present(Fact $fact): array
    {
        return [
            'id' => $fact->id,
            'category' => $fact->category,
            'key' => $fact->key,
            'value' => $fact->value,
            'confidence' => $fact->confidence,
            'source' => $fact->source,
            'status' => $fact->status,
            'conversation_id' => $fact->conversation_id,
            'learned_at' => $fact->learned_at?->toIso8601String(),
            'decided_at' => $fact->decided_at?->toIso8601String(),
        ];
    }
}
