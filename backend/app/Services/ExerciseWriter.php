<?php

namespace App\Services;

use App\Models\Exercise;
use Illuminate\Validation\Rule;

/**
 * The one place an exercise is validated and created.
 *
 * Extracted from `ExerciseController` because the agent's `create_exercise` tool
 * has to enforce the same uniqueness rule the form does — an agent that could
 * insert a second "Bench Press" would break `workout_sets`' name-based join to
 * the catalog, which is what `FitnessStatsService` reads muscle groups through.
 *
 * Only create lives here. Update stays on the controller: renaming propagates
 * into `workout_sets.exercise_title` inside a transaction, and no v1 tool
 * renames anything.
 */
class ExerciseWriter
{
    /**
     * Validation rules for an exercise.
     *
     * Names are unique per owner, matching the exercises.[user_id, name] index —
     * which since the owner backfill is an index that actually enforces
     * something, so this rule and the database now agree instead of the rule
     * standing alone. `$ignore` excludes the row being updated from the check.
     */
    public static function rules(?Exercise $ignore = null): array
    {
        $unique = Rule::unique('exercises', 'name')->where('user_id', Owner::id());

        if ($ignore) {
            $unique = $unique->ignore($ignore->id);
        }

        return [
            'name' => ['required', 'string', 'max:255', $unique],
            'primary_muscle' => ['required', 'string', 'max:100'],
            'equipment' => ['nullable', 'string', 'max:100'],
            'exercise_type' => ['required', 'string', Rule::in(Exercise::TYPES)],
            'notes' => ['nullable', 'string'],
        ];
    }

    /**
     * The owner is not passed in: `BelongsToOwner` stamps it at `creating`, so
     * every writer gets it whether or not it remembered to ask.
     *
     * @param  array  $data  a payload already validated against self::rules()
     */
    public function create(array $data): Exercise
    {
        return Exercise::create($data);
    }
}
