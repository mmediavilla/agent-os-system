<?php

namespace App\Agent\Tools;

use App\Agent\CapabilityGroup;
use App\Models\Equipment;

class ListEquipment extends BaseTool
{
    private const DEFAULT_LIMIT = 50;

    public function name(): string
    {
        return 'list_equipment';
    }

    public function group(): CapabilityGroup
    {
        return CapabilityGroup::Fitness;
    }

    public function description(): string
    {
        return <<<'TEXT'
        The equipment catalog: what the user owns, what is broken, and what is on the wishlist.

        Use this before suggesting any exercise or programme — a recommendation that needs a
        cable machine the user does not have is worse than no recommendation. Check status:
        "broken" items exist in the catalog but cannot be trained on right now, and "wishlist"
        items are not owned at all.

        Equipment names are what exercises reference, so this is also where to find the exact
        spelling for search_exercises' equipment filter.
        TEXT;
    }

    public function inputSchema(): array
    {
        return $this->object([
            'search' => $this->string('Case-insensitive substring of the equipment name.'),
            'equipment_type' => $this->string(
                'Exact category, as spelled in the catalog (e.g. "Free Weights", "Cardio"). '.
                'Free text rather than a fixed set — call with no arguments first to see what is in use.'
            ),
            'status' => $this->string(
                'Only items in this state. Omit to get everything, including broken and wishlist items.',
                Equipment::STATUSES,
            ),
            'limit' => $this->limitProperty(self::DEFAULT_LIMIT),
        ]);
    }

    public function handle(array $input): array
    {
        $input = $this->validate($input, [
            'search' => ['nullable', 'string', 'max:255'],
            'equipment_type' => ['nullable', 'string', 'max:100'],
            'status' => ['nullable', 'string', 'in:'.implode(',', Equipment::STATUSES)],
            'limit' => ['nullable', 'integer'],
        ]);

        $limit = $this->limit($input, self::DEFAULT_LIMIT);

        $query = Equipment::orderBy('equipment_type')
            ->orderBy('name')
            ->searchName($input['search'] ?? null)
            ->applyFilters($input);

        $total = (clone $query)->count();

        return [
            'equipment' => $query->limit($limit)->get()
                ->map(fn (Equipment $e) => array_filter([
                    'id' => $e->id,
                    'name' => $e->name,
                    'equipment_type' => $e->equipment_type,
                    'status' => $e->status,
                    'notes' => $e->notes,
                ], fn ($v) => $v !== null))->all(),
            'total_matching' => $total,
        ];
    }
}
