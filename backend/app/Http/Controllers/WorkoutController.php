<?php

namespace App\Http\Controllers;

use App\Models\Workout;
use App\Models\WorkoutSet;
use App\Services\WorkoutWriter;
use Carbon\Carbon;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class WorkoutController extends Controller
{
    public function __construct(private readonly WorkoutWriter $writer) {}

    /**
     * GET /api/workouts
     */
    public function index(Request $request): JsonResponse
    {
        $limit = min((int) $request->query('limit', 50), 200);

        $workouts = Workout::query()
            ->withCount('sets as set_count')
            ->addSelect([
                'exercise_count' => WorkoutSet::selectRaw('count(distinct exercise_title)')
                    ->whereColumn('workout_id', 'workouts.id'),
            ])
            ->orderByDesc('started_at')
            ->limit($limit)
            ->get();

        $startOfWeek = now()->startOfWeek();
        $weekCount = Workout::where('started_at', '>=', $startOfWeek)->count();

        return response()->json([
            'data' => $workouts,
            // `data` is one clamped page, so its size is not the workout count.
            // Clients that label a total need `meta.total`, and the difference
            // against `meta.returned` is what the page is not showing.
            'meta' => [
                'total' => Workout::count(),
                'returned' => $workouts->count(),
                'limit' => $limit,
            ],
            'summary' => [
                'week_count' => $weekCount,
                'week_goal' => 4,
                'streak_days' => $this->currentStreak(),
                'last_session' => $workouts->first(),
            ],
        ]);
    }

    /**
     * POST /api/workouts
     *
     * {
     *   title, started_at, ended_at?, notes?,
     *   exercises: [{ exercise_title, exercise_notes?, sets: [{ set_type, weight_kg?, reps?, rpe?, distance_km?, duration_seconds? }] }]
     * }
     */
    public function store(Request $request): JsonResponse
    {
        $data = $request->validate(WorkoutWriter::RULES);

        $workout = $this->writer->create($data);

        return response()->json($workout->load('sets'), 201);
    }

    public function show(Workout $workout): JsonResponse
    {
        return response()->json($workout->load('sets'));
    }

    /**
     * PUT /api/workouts/{workout}
     *
     * Full replace: metadata update + delete-all-sets + re-insert.
     * Identical validation contract to store().
     */
    public function update(Request $request, Workout $workout): JsonResponse
    {
        $data = $request->validate(WorkoutWriter::RULES);

        $workout = $this->writer->replace($workout, $data);

        return response()->json($workout->load('sets'));
    }

    public function destroy(Workout $workout): JsonResponse
    {
        $workout->delete();

        return response()->json(null, 204);
    }

    /**
     * POST /api/workouts/import
     * Accepts Hevy-format CSV export.
     */
    public function importCsv(Request $request): JsonResponse
    {
        $request->validate([
            'file' => ['required', 'file', 'mimes:csv,txt', 'max:10240'],
        ]);

        $path = $request->file('file')->getRealPath();
        $handle = fopen($path, 'r');
        if ($handle === false) {
            return response()->json(['message' => 'Could not open uploaded file'], 422);
        }

        $headerRow = fgetcsv($handle);
        if ($headerRow === false) {
            fclose($handle);

            return response()->json(['message' => 'CSV is empty'], 422);
        }
        $headers = array_map(fn ($h) => strtolower(trim((string) $h)), $headerRow);

        $required = ['title', 'start_time', 'exercise_title', 'set_type', 'set_index'];
        $missing = array_diff($required, $headers);
        if (! empty($missing)) {
            fclose($handle);

            return response()->json([
                'message' => 'CSV is missing required Hevy columns',
                'missing_columns' => array_values($missing),
                'expected' => $required,
            ], 422);
        }

        // Bucket rows by "title|start_time"
        $sessions = [];
        while (($row = fgetcsv($handle)) !== false) {
            if (count($row) === 1 && trim((string) $row[0]) === '') {
                continue;
            }
            $assoc = [];
            foreach ($headers as $i => $key) {
                $assoc[$key] = isset($row[$i]) ? trim((string) $row[$i]) : null;
            }
            $key = ($assoc['title'] ?? '').'|'.($assoc['start_time'] ?? '');
            $sessions[$key][] = $assoc;
        }
        fclose($handle);

        $importedSessions = 0;
        $importedSets = 0;
        $skippedSessions = 0;
        $errors = [];

        foreach ($sessions as $key => $rows) {
            $first = $rows[0];
            $title = $first['title'] ?? null;
            $startRaw = $first['start_time'] ?? null;
            $endRaw = $first['end_time'] ?? null;

            if (! $title || ! $startRaw) {
                $skippedSessions++;
                $errors[] = ['session' => $key, 'error' => 'Missing title or start_time'];

                continue;
            }

            try {
                $startedAt = Carbon::createFromFormat('M j, Y, g:i A', $startRaw);
            } catch (\Throwable) {
                $skippedSessions++;
                $errors[] = ['session' => $key, 'error' => "Cannot parse start_time: {$startRaw}"];

                continue;
            }

            $endedAt = null;
            if ($endRaw) {
                try {
                    $endedAt = Carbon::createFromFormat('M j, Y, g:i A', $endRaw);
                } catch (\Throwable) {
                    $errors[] = ['session' => $key, 'warning' => "Could not parse end_time \"{$endRaw}\" — session imported without duration"];
                }
            }

            if (Workout::where('title', $title)->where('started_at', $startedAt)->exists()) {
                $skippedSessions++;

                continue;
            }

            // Filter out rows with no exercise_title and warn for each one
            $validRows = [];
            foreach ($rows as $row) {
                if (empty(trim((string) ($row['exercise_title'] ?? '')))) {
                    $errors[] = [
                        'session' => $key,
                        'warning' => 'Row skipped — missing exercise_title (set_index: '.($row['set_index'] ?? '?').')',
                    ];
                } else {
                    $validRows[] = $row;
                }
            }

            if (empty($validRows)) {
                $skippedSessions++;
                $errors[] = ['session' => $key, 'error' => 'All rows skipped — no valid exercise_title found'];

                continue;
            }

            // Normalise unknown set_type values and warn
            $knownSetTypes = ['normal', 'warmup', 'failure', 'dropset'];
            foreach ($validRows as &$row) {
                $rawType = $row['set_type'] ?? 'normal';
                if (! in_array($rawType, $knownSetTypes, true)) {
                    $errors[] = [
                        'session' => $key,
                        'warning' => "Unknown set_type \"{$rawType}\" (exercise: {$row['exercise_title']}, set_index: {$row['set_index']}) — normalised to \"normal\"",
                    ];
                    $row['set_type'] = 'normal';
                }
            }
            unset($row);

            DB::transaction(function () use ($title, $startedAt, $endedAt, $validRows, $first, &$importedSessions, &$importedSets) {
                $workout = Workout::create([
                    'title' => $title,
                    'started_at' => $startedAt,
                    'ended_at' => $endedAt,
                    'description' => ($first['description'] ?? null) ?: null,
                ]);

                foreach ($validRows as $row) {
                    $w = $row['weight_kg'] ?? null;
                    $r = $row['reps'] ?? null;
                    $d = $row['distance_km'] ?? null;
                    $s = $row['duration_seconds'] ?? null;
                    $e = $row['rpe'] ?? null;

                    WorkoutSet::create([
                        'workout_id' => $workout->id,
                        'exercise_title' => $row['exercise_title'],
                        'superset_id' => ($row['superset_id'] ?? null) ?: null,
                        'exercise_notes' => ($row['exercise_notes'] ?? null) ?: null,
                        'set_index' => (int) ($row['set_index'] ?? 0),
                        'set_type' => $row['set_type'] ?? 'normal',
                        'weight_kg' => $w !== null && $w !== '' ? (float) $w : null,
                        'reps' => $r !== null && $r !== '' ? (int) $r : null,
                        'distance_km' => $d !== null && $d !== '' ? (float) $d : null,
                        'duration_seconds' => $s !== null && $s !== '' ? (int) $s : null,
                        'rpe' => $e !== null && $e !== '' ? (float) $e : null,
                    ]);
                    $importedSets++;
                }
                $importedSessions++;
            });
        }

        return response()->json([
            'imported_sessions' => $importedSessions,
            'imported_sets' => $importedSets,
            'skipped_sessions' => $skippedSessions,
            'errors' => $errors,
        ]);
    }

    private function currentStreak(): int
    {
        $days = Workout::query()
            ->selectRaw('DATE(started_at) as d')
            ->groupBy('d')
            ->orderByDesc('d')
            ->pluck('d')
            ->map(fn ($d) => Carbon::parse($d)->toDateString())
            ->all();

        if (empty($days)) {
            return 0;
        }

        $streak = 0;
        $cursor = now()->toDateString();
        foreach ($days as $day) {
            if ($day === $cursor) {
                $streak++;
                $cursor = Carbon::parse($cursor)->subDay()->toDateString();
            } else {
                break;
            }
        }

        return $streak;
    }
}
