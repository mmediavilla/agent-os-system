<?php

namespace App\Services;

use App\Models\Workout;
use App\Models\WorkoutSet;
use Illuminate\Support\Facades\DB;

/**
 * The one place a workout and its sets are written.
 *
 * `WorkoutController::store()` and `update()` were ~95% the same code — the same
 * fifteen validation rules, the same transaction, the same nested set insert —
 * which meant a rule added to one silently did not apply to the other. They now
 * share this class, and so does the agent's `log_workout` / `update_workout`.
 *
 * Create and replace are separate methods rather than one upsert because the two
 * differ in exactly one line (existing sets are deleted before the re-insert),
 * and hiding that behind a nullable argument would make the destructive path the
 * easier one to reach by accident.
 */
class WorkoutWriter
{
    /**
     * Validation contract for a whole workout payload, shared by the HTTP
     * controller and the agent's tool schemas. Public because a tool's
     * hand-written JSON Schema is checked against it in the tests — a required
     * property the writer does not know about is a schema that lies.
     */
    public const RULES = [
        'title' => ['required', 'string', 'max:120'],
        'started_at' => ['required', 'date'],
        'ended_at' => ['nullable', 'date', 'after_or_equal:started_at'],
        'notes' => ['nullable', 'string', 'max:2000'],
        'exercises' => ['required', 'array', 'min:1'],
        'exercises.*.exercise_title' => ['required', 'string', 'max:120'],
        'exercises.*.exercise_notes' => ['nullable', 'string', 'max:500'],
        'exercises.*.sets' => ['required', 'array', 'min:1'],
        'exercises.*.sets.*.set_type' => ['required', 'string', 'in:normal,warmup,failure,dropset'],
        'exercises.*.sets.*.weight_kg' => ['nullable', 'numeric', 'min:0', 'max:9999'],
        'exercises.*.sets.*.reps' => ['nullable', 'integer', 'min:0', 'max:9999'],
        'exercises.*.sets.*.rpe' => ['nullable', 'numeric', 'min:0', 'max:10'],
        'exercises.*.sets.*.distance_km' => ['nullable', 'numeric', 'min:0'],
        'exercises.*.sets.*.duration_seconds' => ['nullable', 'integer', 'min:0'],
    ];

    /** Set types a `set_type` may name, derived from the rule so the two cannot drift. */
    public static function setTypes(): array
    {
        $rule = collect(self::RULES['exercises.*.sets.*.set_type'])
            ->first(fn ($r) => is_string($r) && str_starts_with($r, 'in:'));

        return explode(',', substr($rule, 3));
    }

    /**
     * Insert a workout and its sets.
     *
     * @param  array  $data  a payload already validated against self::RULES
     */
    public function create(array $data): Workout
    {
        return DB::transaction(function () use ($data) {
            $workout = Workout::create($this->attributes($data));

            $this->insertSets($workout, $data['exercises']);

            return $workout;
        });
    }

    /**
     * Overwrite a workout and every set on it.
     *
     * Full replace rather than a diff: the form submits the whole session, and
     * matching submitted sets back onto stored rows would need a stable set id
     * the client does not have.
     *
     * @param  array  $data  a payload already validated against self::RULES
     */
    public function replace(Workout $workout, array $data): Workout
    {
        return DB::transaction(function () use ($workout, $data) {
            $workout->update($this->attributes($data));

            $workout->sets()->delete();
            $this->insertSets($workout, $data['exercises']);

            return $workout;
        });
    }

    /** Session-level columns. Sets are handled separately. */
    private function attributes(array $data): array
    {
        return [
            'title' => $data['title'],
            'started_at' => $data['started_at'],
            'ended_at' => $data['ended_at'] ?? null,
            'notes' => $data['notes'] ?? null,
        ];
    }

    /**
     * `set_index` is the position within its exercise, not within the session,
     * which is what lets a set be read back as "3rd set of Bench Press".
     */
    private function insertSets(Workout $workout, array $exercises): void
    {
        foreach ($exercises as $exercise) {
            foreach ($exercise['sets'] as $index => $set) {
                WorkoutSet::create([
                    'workout_id' => $workout->id,
                    'exercise_title' => $exercise['exercise_title'],
                    'exercise_notes' => $exercise['exercise_notes'] ?? null,
                    'set_index' => $index,
                    'set_type' => $set['set_type'],
                    'weight_kg' => $set['weight_kg'] ?? null,
                    'reps' => $set['reps'] ?? null,
                    'rpe' => $set['rpe'] ?? null,
                    'distance_km' => $set['distance_km'] ?? null,
                    'duration_seconds' => $set['duration_seconds'] ?? null,
                ]);
            }
        }
    }
}
