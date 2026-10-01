<?php

namespace App\Agent\Tools;

use App\Agent\CapabilityGroup;
use App\Agent\Contracts\MutatingTool;
use App\Agent\Tools\Concerns\DescribesWorkoutPayload;
use App\Services\WorkoutWriter;

class LogWorkout extends BaseTool implements MutatingTool
{
    use DescribesWorkoutPayload;

    public function __construct(private readonly WorkoutWriter $writer) {}

    public function name(): string
    {
        return 'log_workout';
    }

    public function group(): CapabilityGroup
    {
        return CapabilityGroup::Fitness;
    }

    public function description(): string
    {
        return <<<'TEXT'
        Record a completed training session, with its exercises and every set.

        Writes to the training log, which is what every metric and personal record is computed
        from, so accuracy matters more than speed: confirm the weights, reps and date with the
        user before calling, and never invent a set that was not described. Weights are
        kilograms and distances kilometres — the database has no other unit.

        Use search_exercises first to get the catalog spelling of each exercise. A title that
        does not match an existing exercise still saves, but it will be tracked as a separate
        lift with no history behind it.

        This creates a new session every time it is called. To correct one that already exists,
        use update_workout.
        TEXT;
    }

    public function inputSchema(): array
    {
        return $this->object($this->workoutProperties(), $this->workoutRequired());
    }

    public function handle(array $input): array
    {
        // Validated against the writer's own rules, not the schema: the schema
        // is what the model is told, these are what the database will actually
        // accept, and only one of the two can be authoritative.
        $data = $this->validate($input, WorkoutWriter::RULES);

        $workout = $this->writer->create($data);

        return [
            'id' => $workout->id,
            'title' => $workout->title,
            'started_at' => $workout->started_at->toDateTimeString(),
            'set_count' => $workout->sets()->count(),
            'saved' => true,
        ];
    }
}
