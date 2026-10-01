<?php

namespace App\Agent\Support;

use App\Models\Workout;
use App\Models\WorkoutSet;

/**
 * Renders sessions as the compact text a coach reads — `100kg×8@8`, grouped by
 * exercise under a dated header.
 *
 * This was inlined in `InsightController::fitness()`. The agent needs exactly
 * the same rendering (a workout handed to a tool result is unreadable as raw set
 * rows, and costs several times the tokens), so it lives here instead, in
 * App\Agent because the agent is now its principal caller.
 *
 * Deliberately lossy: `superset_id`, ids and timestamps are dropped. This is the
 * form for *reading* a session; a caller that needs to edit one wants the rows.
 */
final class WorkoutTranscript
{
    /**
     * Every session, oldest first, separated by a blank line.
     *
     * @param  iterable<Workout>  $workouts  each with `sets` loaded, ordered by
     *                                       exercise_title then set_index
     */
    public static function render(iterable $workouts): string
    {
        $sessions = [];
        foreach ($workouts as $workout) {
            $sessions[] = self::session($workout);
        }

        return implode("\n\n", $sessions);
    }

    /** A dated header line followed by one indented line per exercise. */
    public static function session(Workout $workout): string
    {
        $date = $workout->started_at->toDateString();
        $duration = $workout->duration_minutes !== null ? $workout->duration_minutes.' min' : null;
        $header = $date.': '.$workout->title.($duration ? " ({$duration})" : '');

        $exercises = $workout->sets
            ->groupBy('exercise_title')
            ->map(fn ($sets, $title) => '  '.$title.': '.$sets->map(self::set(...))->implode(' | '))
            ->implode("\n");

        return $header."\n".$exercises;
    }

    /**
     * One set, e.g. `100kg×8@8`. Parts are concatenated without separators —
     * each carries its own unit, and the run-together form is both unambiguous
     * and the cheapest to tokenize.
     */
    public static function set(WorkoutSet $set): string
    {
        $parts = [];

        if ($set->set_type === 'warmup') {
            $parts[] = 'warmup';
        }
        if ($set->weight_kg !== null) {
            $parts[] = $set->weight_kg.'kg';
        }
        if ($set->reps !== null) {
            $parts[] = '×'.$set->reps;
        }
        if ($set->distance_km !== null) {
            $parts[] = $set->distance_km.'km';
        }
        if ($set->duration_seconds !== null) {
            $parts[] = $set->duration_seconds.'s';
        }
        if ($set->rpe !== null) {
            $parts[] = '@'.$set->rpe;
        }

        return implode('', $parts);
    }
}
