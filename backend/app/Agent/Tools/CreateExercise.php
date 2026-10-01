<?php

namespace App\Agent\Tools;

use App\Agent\CapabilityGroup;
use App\Agent\Contracts\MutatingTool;
use App\Models\Exercise;
use App\Services\ExerciseWriter;

class CreateExercise extends BaseTool implements MutatingTool
{
    public function __construct(private readonly ExerciseWriter $writer) {}

    public function name(): string
    {
        return 'create_exercise';
    }

    public function group(): CapabilityGroup
    {
        return CapabilityGroup::Fitness;
    }

    public function description(): string
    {
        return <<<'TEXT'
        Add a movement to the exercise catalog.

        Only when it is genuinely missing: search_exercises first, and prefer an existing entry
        even if the name is not what the user said. Near-duplicates are the failure mode that
        matters — "Incline DB Press" alongside "Incline Dumbbell Press" splits one lift's
        history into two, and every trend and personal record for it silently halves.

        The name must be unique. equipment should match a name from list_equipment, since that
        is how the two catalogs are linked.
        TEXT;
    }

    public function inputSchema(): array
    {
        return $this->object([
            'name' => $this->string('The exercise name, as it should appear in workout logs. Must be unique.'),
            'primary_muscle' => $this->string(
                'The muscle group it mainly trains. Free text, but reuse a value already in the '.
                'catalog (search_exercises) — the muscle-split breakdown groups on this string exactly.'
            ),
            'equipment' => $this->string('Name of the equipment it needs, matching the equipment catalog. Omit for bodyweight.'),
            'exercise_type' => $this->string(
                'How the exercise is measured, which decides what a set records: '.
                'weight_reps (load and reps), reps_only (bodyweight), duration (a hold or a plank), '.
                'distance_duration (cardio).',
                Exercise::TYPES,
            ),
            'notes' => $this->string('Cues, setup or anything worth remembering about the movement.'),
        ], ['name', 'primary_muscle', 'exercise_type']);
    }

    public function handle(array $input): array
    {
        // Owner is null in the single-user phase, matching what the HTTP
        // controller writes; the uniqueness rule is scoped the same way, so the
        // agent cannot create a duplicate the form would have rejected.
        $data = $this->validate($input, ExerciseWriter::rules());

        $exercise = $this->writer->create($data);

        return [
            'id' => $exercise->id,
            'name' => $exercise->name,
            'primary_muscle' => $exercise->primary_muscle,
            'exercise_type' => $exercise->exercise_type,
            'saved' => true,
        ];
    }
}
