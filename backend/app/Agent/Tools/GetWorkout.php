<?php

namespace App\Agent\Tools;

use App\Agent\CapabilityGroup;
use App\Models\Workout;
use App\Models\WorkoutSet;

class GetWorkout extends BaseTool
{
    public function name(): string
    {
        return 'get_workout';
    }

    public function group(): CapabilityGroup
    {
        return CapabilityGroup::Fitness;
    }

    public function description(): string
    {
        return <<<'TEXT'
        One session in full: its metadata plus every exercise and set, structured.

        The exercises array comes back in exactly the shape update_workout expects, so the way
        to change a session is to read it here, modify what needs changing, and send the whole
        thing back. update_workout replaces a session outright — anything left out of that
        payload is deleted, so it must be built from this result rather than from memory.

        For simply reading what was lifted, list_workouts with include_sets is cheaper.
        TEXT;
    }

    public function inputSchema(): array
    {
        return $this->object([
            'id' => $this->integer('The workout id, as returned by list_workouts.'),
        ], ['id']);
    }

    public function handle(array $input): array
    {
        $input = $this->validate($input, [
            'id' => ['required', 'integer'],
        ]);

        $workout = Workout::with(['sets' => fn ($q) => $q->orderBy('exercise_title')->orderBy('set_index')])
            ->findOrFail($input['id']);

        return [
            'id' => $workout->id,
            'title' => $workout->title,
            'started_at' => $workout->started_at->toDateTimeString(),
            'ended_at' => $workout->ended_at?->toDateTimeString(),
            'duration_minutes' => $workout->duration_minutes,
            'notes' => $workout->notes,
            // Grouped back into the nested exercises/sets form, because that is
            // what the writer takes. The rows are stored flat with a
            // denormalized exercise_title; regrouping here is what makes a
            // read-modify-write round trip possible at all.
            'exercises' => $workout->sets
                ->groupBy('exercise_title')
                ->map(fn ($sets, $title) => [
                    'exercise_title' => $title,
                    'exercise_notes' => $sets->first()->exercise_notes,
                    'sets' => $sets->map(fn (WorkoutSet $s) => array_filter([
                        'set_type' => $s->set_type,
                        'weight_kg' => $s->weight_kg,
                        'reps' => $s->reps,
                        'rpe' => $s->rpe,
                        'distance_km' => $s->distance_km,
                        'duration_seconds' => $s->duration_seconds,
                    ], fn ($v) => $v !== null))->values()->all(),
                ])
                ->values()
                ->all(),
        ];
    }
}
