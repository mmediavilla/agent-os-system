<?php

namespace App\Http\Controllers;

use App\Http\Controllers\Concerns\PaginatesIndex;
use App\Models\Equipment;
use App\Models\Exercise;
use App\Services\Owner;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Storage;
use Illuminate\Validation\Rule;
use Symfony\Component\HttpFoundation\StreamedResponse;

/**
 * CRUD for the equipment catalog.
 *
 * Fields travel as JSON; the photo has its own endpoints. Keeping them apart
 * avoids multipart PUT (which PHP does not parse) and the `_method` spoofing
 * workaround, at the cost of create-with-photo being two requests. The record
 * is created first, so a failed upload leaves a usable row rather than losing
 * the whole form.
 */
class EquipmentController extends Controller
{
    use PaginatesIndex;

    /** Photos live on the private disk under this prefix. */
    private const IMAGE_DIR = 'equipment';

    public function index(Request $request)
    {
        // Search and filters are model scopes so the agent's list_equipment tool
        // narrows the catalog exactly as this screen does. The closed sets the
        // rules validate against live on the model for the same reason.
        $query = Equipment::orderBy('equipment_type')
            ->orderBy('name')
            ->searchName($request->query('search'))
            ->applyFilters($request->query());

        return $this->paginatedResponse($request, $query);
    }

    public function store(Request $request)
    {
        $data = $request->validate($this->rules());

        // No owner passed: `BelongsToOwner` stamps it at `creating`.
        $equipment = Equipment::create($data);

        return response()->json($equipment, 201);
    }

    public function show(Equipment $equipment)
    {
        return response()->json($equipment);
    }

    public function update(Request $request, Equipment $equipment)
    {
        $data = $request->validate($this->rules($equipment));

        $originalName = $equipment->name;

        DB::transaction(function () use ($equipment, $data, $originalName) {
            $equipment->update($data);

            // exercises.equipment stores the equipment name as a denormalized
            // string, so a rename has to be propagated or every exercise stays
            // pinned to the old name and drops out of the catalog's picker.
            if ($originalName !== $equipment->name) {
                Exercise::where('equipment', $originalName)
                    ->where('user_id', $equipment->user_id)
                    ->update(['equipment' => $equipment->name]);
            }
        });

        return response()->json($equipment);
    }

    public function destroy(Equipment $equipment)
    {
        $this->discardImage($equipment);
        $equipment->delete();

        return response()->json(null, 204);
    }

    // ── Photo ────────────────────────────────────────────────────────────────

    /**
     * Replace this item's photo. Returns the updated record so the client picks
     * up the new, cache-busted image_url without a second round trip.
     */
    public function uploadImage(Request $request, Equipment $equipment)
    {
        $request->validate([
            'image' => ['required', 'image', 'mimes:jpeg,jpg,png,webp', 'max:5120'],
        ]);

        $this->discardImage($equipment);

        $path = $request->file('image')->store(self::IMAGE_DIR);

        // Always saved, even when only the path changed, so updated_at moves and
        // the cache-busting image_url actually changes.
        $equipment->image_path = $path;
        $equipment->save();

        return response()->json($equipment);
    }

    public function deleteImage(Equipment $equipment)
    {
        $this->discardImage($equipment);

        $equipment->image_path = null;
        $equipment->save();

        return response()->json($equipment);
    }

    /**
     * Stream the photo. Served from here rather than a public symlink so a fresh
     * checkout needs no `storage:link`, and so the route can grow an ownership
     * check when auth lands.
     */
    public function image(Equipment $equipment): StreamedResponse
    {
        abort_if(! $equipment->image_path || ! Storage::exists($equipment->image_path), 404);

        return Storage::response($equipment->image_path, null, [
            // Immutable because the URL carries updated_at — a replacement photo
            // is a different URL, so this copy never needs revalidating.
            'Cache-Control' => 'private, max-age=31536000, immutable',
        ]);
    }

    // ── Internals ────────────────────────────────────────────────────────────

    /** Remove the stored file, if any. Leaves the column alone. */
    private function discardImage(Equipment $equipment): void
    {
        if ($equipment->image_path) {
            Storage::delete($equipment->image_path);
        }
    }

    /**
     * Validation rules shared by store() and update(). Names are unique per owner
     * (matching the equipment.[user_id, name] index) because exercises reference
     * equipment by name; update() ignores itself.
     *
     * equipment_type is a free string like exercises.primary_muscle — the pill
     * list is a UI convention that can grow without a migration. status and
     * thumbnail are closed sets, like exercises.exercise_type: behaviour keys
     * off the first, and the second has to name a drawing that exists.
     */
    private function rules(?Equipment $equipment = null): array
    {
        $unique = Rule::unique('equipment', 'name')->where('user_id', Owner::id());

        if ($equipment) {
            $unique = $unique->ignore($equipment->id);
        }

        return [
            'name' => ['required', 'string', 'max:255', $unique],
            'equipment_type' => ['required', 'string', 'max:100'],
            'status' => ['required', 'string', Rule::in(Equipment::STATUSES)],
            // Optional, and explicitly nullable: sending null is how a client
            // hands the pick back to the name-and-category default, which is
            // not the same request as omitting the key on a partial save.
            'thumbnail' => ['nullable', 'string', Rule::in(Equipment::THUMBNAILS)],
            'notes' => ['nullable', 'string'],
        ];
    }
}
