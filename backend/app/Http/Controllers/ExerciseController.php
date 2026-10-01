<?php

namespace App\Http\Controllers;

use App\Http\Controllers\Concerns\PaginatesIndex;
use App\Models\Exercise;
use App\Models\Workout;
use App\Models\WorkoutSet;
use App\Services\ExerciseWriter;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class ExerciseController extends Controller
{
    use PaginatesIndex;

    public function __construct(private readonly ExerciseWriter $writer) {}

    public function index(Request $request)
    {
        // Search and filters are model scopes so the agent's search_exercises
        // tool narrows the catalog exactly as this screen does.
        $query = Exercise::orderBy('primary_muscle')
            ->orderBy('name')
            ->searchName($request->query('search'))
            ->applyFilters($request->query());

        return $this->paginatedResponse($request, $query);
    }

    public function store(Request $request)
    {
        $data = $request->validate(ExerciseWriter::rules());

        $exercise = $this->writer->create($data);

        return response()->json($exercise, 201);
    }

    public function show(Exercise $exercise)
    {
        return response()->json($exercise);
    }

    public function update(Request $request, Exercise $exercise)
    {
        $data = $request->validate(ExerciseWriter::rules($exercise));

        $originalName = $exercise->name;

        DB::transaction(function () use ($exercise, $data, $originalName) {
            $exercise->update($data);

            // workout_sets stores the exercise name as a denormalized string, so a
            // rename has to be propagated or every historical set stays pinned to
            // the old name and stops grouping with the renamed exercise.
            if ($originalName !== $exercise->name) {
                WorkoutSet::where('exercise_title', $originalName)
                    ->whereIn('workout_id', Workout::where('user_id', $exercise->user_id)->select('id'))
                    ->update(['exercise_title' => $exercise->name]);
            }
        });

        return response()->json($exercise);
    }

    public function destroy(Exercise $exercise)
    {
        $exercise->delete();

        return response()->json(null, 204);
    }
}
