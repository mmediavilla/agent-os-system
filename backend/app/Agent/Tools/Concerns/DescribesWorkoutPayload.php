<?php

namespace App\Agent\Tools\Concerns;

use App\Services\WorkoutWriter;

/**
 * The nested exercises/sets payload shared by log_workout and update_workout.
 *
 * One copy rather than two, because the two tools take the identical body and a
 * description that drifted between them would be worse than no description: the
 * model would learn the two shapes differ when they do not.
 *
 * The enum and the max lengths are read off WorkoutWriter::RULES rather than
 * restated, so a rule change cannot leave the schema advertising a set type the
 * writer will reject.
 */
trait DescribesWorkoutPayload
{
    /** @return array<string, array> */
    protected function workoutProperties(): array
    {
        return [
            'title' => $this->string('Session name, e.g. "Push Day" or "Legs". Required.'),
            'started_at' => $this->string(
                'When the session started, as "YYYY-MM-DD HH:MM:SS". Required. Ask the user '.
                'rather than guessing a time — this is what every date filter and streak sorts on.'
            ),
            'ended_at' => $this->string(
                'When it finished, same format. Optional; supplying it is what gives the '.
                'session a duration. Must not be before started_at.'
            ),
            'notes' => $this->string('Free-text note about the whole session.'),
            'exercises' => $this->array(
                'The exercises performed, in order. At least one is required, and each needs '.
                'at least one set.',
                $this->object([
                    'exercise_title' => $this->string(
                        'The exercise name. Match the catalog spelling exactly (search_exercises) '.
                        'so the set groups with its history — a typo silently creates a separate lift.'
                    ),
                    'exercise_notes' => $this->string('Free-text note about this exercise in this session.'),
                    'sets' => $this->array('The sets performed, in order.', $this->object([
                        'set_type' => $this->string(
                            'Warmup sets are excluded from volume and personal-record maths; '.
                            'failure and dropset both count as working sets.',
                            WorkoutWriter::setTypes(),
                        ),
                        'weight_kg' => $this->number('Load in kilograms. The database is always metric — convert before sending.'),
                        'reps' => $this->integer('Repetitions completed.'),
                        'rpe' => $this->number('Rate of perceived exertion, 0-10.'),
                        'distance_km' => $this->number('Distance in kilometres, for cardio.'),
                        'duration_seconds' => $this->integer('Time under load or elapsed time, in seconds.'),
                    ], ['set_type'])),
                ], ['exercise_title', 'sets']),
            ),
        ];
    }

    /** @return list<string> */
    protected function workoutRequired(): array
    {
        return ['title', 'started_at', 'exercises'];
    }
}
