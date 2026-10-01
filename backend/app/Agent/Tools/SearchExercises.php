<?php

namespace App\Agent\Tools;

use App\Agent\CapabilityGroup;
use App\Models\Exercise;

class SearchExercises extends BaseTool
{
    private const DEFAULT_LIMIT = 25;

    public function name(): string
    {
        return 'search_exercises';
    }

    public function group(): CapabilityGroup
    {
        return CapabilityGroup::Fitness;
    }

    public function description(): string
    {
        return <<<'TEXT'
        The exercise catalog — the movements the user has defined, with the muscle each trains,
        the equipment it needs and how it is measured.

        This is the vocabulary. Workout sets reference exercises by name, so use this to find
        the exact stored spelling before passing an exercise title to any other tool, and to
        answer "what can I do for X" from what the user actually has set up rather than from
        general knowledge.

        Note this is the catalog, not the training history — it says an exercise exists, never
        whether or when it was performed. For that, use list_workouts with an exercise filter.
        TEXT;
    }

    public function inputSchema(): array
    {
        return $this->object([
            'search' => $this->string('Case-insensitive substring of the exercise name.'),
            'primary_muscle' => $this->string(
                'Exact muscle group, as spelled in the catalog (e.g. "Chest", "Quads"). '.
                'Call with no arguments first to see which values are in use.'
            ),
            'equipment' => $this->string('Exact equipment name, as spelled in the equipment catalog.'),
            'exercise_type' => $this->string(
                'How the exercise is measured.',
                Exercise::TYPES,
            ),
            'limit' => $this->limitProperty(self::DEFAULT_LIMIT),
        ]);
    }

    public function handle(array $input): array
    {
        $input = $this->validate($input, [
            'search' => ['nullable', 'string', 'max:255'],
            'primary_muscle' => ['nullable', 'string', 'max:100'],
            'equipment' => ['nullable', 'string', 'max:100'],
            'exercise_type' => ['nullable', 'string', 'in:'.implode(',', Exercise::TYPES)],
            'limit' => ['nullable', 'integer'],
        ]);

        $limit = $this->limit($input, self::DEFAULT_LIMIT);

        // Same scopes the Exercises screen uses, so a tool answer and the list
        // the user is looking at cannot disagree about what matches.
        $query = Exercise::orderBy('primary_muscle')
            ->orderBy('name')
            ->searchName($input['search'] ?? null)
            ->applyFilters($input);

        $total = (clone $query)->count();

        return [
            'exercises' => $query->limit($limit)->get()
                ->map(fn (Exercise $e) => array_filter([
                    'id' => $e->id,
                    'name' => $e->name,
                    'primary_muscle' => $e->primary_muscle,
                    'equipment' => $e->equipment,
                    'exercise_type' => $e->exercise_type,
                    'notes' => $e->notes,
                ], fn ($v) => $v !== null))->all(),
            'total_matching' => $total,
        ];
    }
}
