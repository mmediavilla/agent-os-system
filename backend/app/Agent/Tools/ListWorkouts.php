<?php

namespace App\Agent\Tools;

use App\Agent\CapabilityGroup;
use App\Agent\Support\WorkoutTranscript;
use App\Models\Workout;
use App\Models\WorkoutSet;

class ListWorkouts extends BaseTool
{
    private const DEFAULT_LIMIT = 20;

    public function name(): string
    {
        return 'list_workouts';
    }

    public function group(): CapabilityGroup
    {
        return CapabilityGroup::Fitness;
    }

    public function description(): string
    {
        return <<<'TEXT'
        Recent training sessions, newest first, optionally narrowed by date or by an exercise
        they contain. Returns one summary row per session: title, date, duration, and how many
        sets and distinct exercises it held.

        Use this for questions about specific sessions — "what did I do on Tuesday", "when did
        I last squat", "how long were last week's sessions". For trends, totals or progress
        call get_fitness_stats instead; it already aggregates all of this, and will be both
        cheaper and more accurate than summing these rows by hand.

        Set include_sets to true to get each session's exercises and sets rendered compactly
        (e.g. "Bench Press: 60kg×5 | 100kg×8@8"). That is the fastest way to see what was
        actually lifted, but it is far larger per row — pair it with a small limit. To edit a
        session use get_workout, which returns the structured form update_workout accepts.
        TEXT;
    }

    public function inputSchema(): array
    {
        return $this->object([
            'from' => $this->string('Only sessions on or after this date (YYYY-MM-DD).'),
            'to' => $this->string('Only sessions on or before this date (YYYY-MM-DD), inclusive.'),
            'exercise' => $this->string(
                'Only sessions containing this exercise, matched on the exact title as stored. '.
                'Use search_exercises first if unsure of the spelling.'
            ),
            'include_sets' => $this->boolean(
                'Attach a compact transcript of every set to each session. False by default; '.
                'roughly ten times larger per row, so lower the limit when turning it on.'
            ),
            'limit' => $this->limitProperty(self::DEFAULT_LIMIT),
        ]);
    }

    public function handle(array $input): array
    {
        $input = $this->validate($input, [
            'from' => ['nullable', 'date'],
            'to' => ['nullable', 'date'],
            'exercise' => ['nullable', 'string', 'max:120'],
            'include_sets' => ['nullable', 'boolean'],
            'limit' => ['nullable', 'integer'],
        ]);

        $limit = $this->limit($input, self::DEFAULT_LIMIT);
        $withSets = (bool) ($input['include_sets'] ?? false);

        $query = Workout::query()
            ->withCount('sets as set_count')
            ->addSelect([
                'exercise_count' => WorkoutSet::selectRaw('count(distinct exercise_title)')
                    ->whereColumn('workout_id', 'workouts.id'),
            ])
            ->orderByDesc('started_at');

        if (! empty($input['from'])) {
            $query->whereDate('started_at', '>=', $input['from']);
        }
        if (! empty($input['to'])) {
            // Compared as a date, not a timestamp, so "to 2026-09-04" includes
            // that day's session rather than stopping at its midnight.
            $query->whereDate('started_at', '<=', $input['to']);
        }
        if (! empty($input['exercise'])) {
            $query->whereHas('sets', fn ($q) => $q->where('exercise_title', $input['exercise']));
        }

        // Counted before the limit, so the model can tell "these are all of them"
        // from "these are the first 20 of 137" and offer to narrow.
        $total = (clone $query)->count();

        if ($withSets) {
            $query->with(['sets' => fn ($q) => $q->orderBy('exercise_title')->orderBy('set_index')]);
        }

        $workouts = $query->limit($limit)->get();

        return [
            // Explicit projection rather than toArray(): Workout appends
            // duration_minutes and carries user_id and both timestamps, which
            // cost tokens on every row and mean nothing to the model.
            'workouts' => $workouts->map(fn (Workout $w) => array_filter([
                'id' => $w->id,
                'title' => $w->title,
                'started_at' => $w->started_at->toDateTimeString(),
                'duration_minutes' => $w->duration_minutes,
                'set_count' => (int) $w->set_count,
                'exercise_count' => (int) $w->exercise_count,
                'notes' => $w->notes,
                'sets' => $withSets ? WorkoutTranscript::session($w) : null,
            ], fn ($v) => $v !== null))->all(),
            'returned' => $workouts->count(),
            'total_matching' => $total,
        ];
    }
}
