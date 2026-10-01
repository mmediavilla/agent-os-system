<?php

namespace App\Agent\Tools;

use App\Agent\CapabilityGroup;
use App\Agent\Contracts\MutatingTool;
use App\Agent\Tools\Concerns\DescribesWorkoutPayload;
use App\Models\Workout;
use App\Services\WorkoutWriter;

class UpdateWorkout extends BaseTool implements MutatingTool
{
    use DescribesWorkoutPayload;

    public function __construct(private readonly WorkoutWriter $writer) {}

    public function name(): string
    {
        return 'update_workout';
    }

    public function group(): CapabilityGroup
    {
        return CapabilityGroup::Fitness;
    }

    public function description(): string
    {
        return <<<'TEXT'
        Correct an existing session by replacing it outright.

        This is a full replace, not a patch: every set on the session is deleted and re-created
        from what is sent. Anything omitted is gone. So always call get_workout first, change
        what needs changing in that result, and send the whole thing back — building the
        payload from anything else will silently drop the parts not mentioned.

        Fixing one number in one set still means sending every exercise and every set.
        TEXT;
    }

    public function inputSchema(): array
    {
        return $this->object(
            ['id' => $this->integer('The workout id to replace, from list_workouts or get_workout.')]
                + $this->workoutProperties(),
            ['id', ...$this->workoutRequired()],
        );
    }

    public function handle(array $input): array
    {
        $data = $this->validate($input, ['id' => ['required', 'integer']] + WorkoutWriter::RULES);

        $workout = Workout::findOrFail($data['id']);

        $workout = $this->writer->replace($workout, $data);

        return [
            'id' => $workout->id,
            'title' => $workout->title,
            'started_at' => $workout->started_at->toDateTimeString(),
            'set_count' => $workout->sets()->count(),
            'replaced' => true,
        ];
    }
}
