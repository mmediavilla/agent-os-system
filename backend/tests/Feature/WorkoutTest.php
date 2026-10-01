<?php

namespace Tests\Feature;

use App\Models\Workout;
use App\Models\WorkoutSet;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Tests\TestCase;

class WorkoutTest extends TestCase
{
    use RefreshDatabase;

    // ── Helpers ───────────────────────────────────────────────────────────────

    private function makeSet(Workout $workout, array $attrs = []): WorkoutSet
    {
        return WorkoutSet::create(array_merge([
            'workout_id' => $workout->id,
            'exercise_title' => 'Bench Press',
            'set_index' => 0,
            'set_type' => 'normal',
            'weight_kg' => 80,
            'reps' => 8,
        ], $attrs));
    }

    private function csvUpload(string $content): UploadedFile
    {
        $tmp = tempnam(sys_get_temp_dir(), 'hevy').'.csv';
        file_put_contents($tmp, $content);

        return new UploadedFile($tmp, 'workouts.csv', 'text/csv', null, true);
    }

    // ── GET /api/workouts ─────────────────────────────────────────────────────

    public function test_index_returns_set_count_exercise_count_and_duration(): void
    {
        $w = $this->makeWorkout(['started_at' => '2026-04-24 16:09:00', 'ended_at' => '2026-04-24 17:45:00']);
        $this->makeSet($w, ['exercise_title' => 'Bench Press', 'set_index' => 0]);
        $this->makeSet($w, ['exercise_title' => 'Bench Press', 'set_index' => 1]);
        $this->makeSet($w, ['exercise_title' => 'Squat',       'set_index' => 0]);

        $this->getJson('/api/workouts')
            ->assertOk()
            ->assertJsonPath('data.0.set_count', 3)
            ->assertJsonPath('data.0.exercise_count', 2)
            ->assertJsonPath('data.0.duration_minutes', 96); // 16:09 → 17:45 = 96 min
    }

    public function test_index_duration_null_when_no_end_time(): void
    {
        $this->makeWorkout(['ended_at' => null]);

        $this->getJson('/api/workouts')
            ->assertOk()
            ->assertJsonPath('data.0.duration_minutes', null);
    }

    public function test_index_returns_summary_block(): void
    {
        $this->makeWorkout(['started_at' => now()->toDateTimeString(), 'ended_at' => now()->addHour()->toDateTimeString()]);

        $this->getJson('/api/workouts')
            ->assertOk()
            ->assertJsonStructure(['data', 'summary' => ['week_count', 'week_goal', 'streak_days', 'last_session']]);
    }

    public function test_index_meta_counts_the_whole_table_not_the_page(): void
    {
        for ($i = 0; $i < 5; $i++) {
            $this->makeWorkout(['started_at' => now()->subDays($i)->toDateTimeString()]);
        }

        $this->getJson('/api/workouts?limit=2')
            ->assertOk()
            ->assertJsonCount(2, 'data')
            ->assertJsonPath('meta.total', 5)
            ->assertJsonPath('meta.returned', 2)
            ->assertJsonPath('meta.limit', 2);
    }

    public function test_index_meta_reports_the_clamped_limit(): void
    {
        $this->makeWorkout();

        $this->getJson('/api/workouts?limit=5000')
            ->assertOk()
            ->assertJsonPath('meta.limit', 200)
            ->assertJsonPath('meta.total', 1);
    }

    // ── POST /api/workouts ────────────────────────────────────────────────────

    public function test_store_creates_session_and_sets(): void
    {
        $payload = [
            'title' => 'Upper 2',
            'started_at' => '2026-04-24T16:09:00',
            'ended_at' => '2026-04-24T17:45:00',
            'exercises' => [
                [
                    'exercise_title' => 'Bench Press',
                    'sets' => [
                        ['set_type' => 'warmup', 'weight_kg' => 40, 'reps' => 10],
                        ['set_type' => 'normal', 'weight_kg' => 80, 'reps' => 8, 'rpe' => 8],
                    ],
                ],
                [
                    'exercise_title' => 'Squat',
                    'sets' => [
                        ['set_type' => 'normal', 'weight_kg' => 100, 'reps' => 5],
                    ],
                ],
            ],
        ];

        $this->postJson('/api/workouts', $payload)
            ->assertCreated()
            ->assertJsonPath('title', 'Upper 2')
            ->assertJsonCount(3, 'sets');

        $this->assertDatabaseCount('workouts', 1);
        $this->assertDatabaseCount('workout_sets', 3);
        $this->assertDatabaseHas('workout_sets', ['exercise_title' => 'Bench Press', 'set_type' => 'warmup', 'set_index' => 0]);
        $this->assertDatabaseHas('workout_sets', ['exercise_title' => 'Bench Press', 'set_type' => 'normal', 'set_index' => 1]);
        $this->assertDatabaseHas('workout_sets', ['exercise_title' => 'Squat', 'set_index' => 0]);
    }

    public function test_store_validates_required_fields(): void
    {
        $this->postJson('/api/workouts', [])
            ->assertUnprocessable()
            ->assertJsonValidationErrors(['title', 'started_at', 'exercises']);
    }

    public function test_store_validates_ended_at_after_started_at(): void
    {
        $this->postJson('/api/workouts', [
            'title' => 'Bad session',
            'started_at' => '2026-04-24T17:00:00',
            'ended_at' => '2026-04-24T16:00:00',
            'exercises' => [['exercise_title' => 'X', 'sets' => [['set_type' => 'normal']]]],
        ])->assertUnprocessable()
            ->assertJsonValidationErrors(['ended_at']);
    }

    public function test_store_accepts_all_set_types(): void
    {
        foreach (['normal', 'warmup', 'failure', 'dropset'] as $type) {
            $this->postJson('/api/workouts', [
                'title' => "Session $type",
                'started_at' => '2026-04-24T10:00:00',
                'exercises' => [['exercise_title' => 'Squat', 'sets' => [['set_type' => $type]]]],
            ])->assertCreated();
        }
        $this->assertDatabaseCount('workouts', 4);
    }

    // ── Workout model accessor ────────────────────────────────────────────────

    public function test_duration_minutes_accessor_computes_correctly(): void
    {
        $w = $this->makeWorkout(['started_at' => '2026-04-24 16:00:00', 'ended_at' => '2026-04-24 17:30:00']);
        $this->assertSame(90, $w->duration_minutes);
    }

    public function test_duration_minutes_accessor_null_without_end_time(): void
    {
        $w = $this->makeWorkout(['ended_at' => null]);
        $this->assertNull($w->duration_minutes);
    }

    public function test_duration_minutes_present_on_show_endpoint(): void
    {
        $w = $this->makeWorkout(['started_at' => '2026-04-24 16:00:00', 'ended_at' => '2026-04-24 17:00:00']);

        $this->getJson("/api/workouts/{$w->id}")
            ->assertOk()
            ->assertJsonPath('duration_minutes', 60);
    }

    // ── POST /api/workouts/import ─────────────────────────────────────────────

    private string $validHeaders = 'title,start_time,end_time,description,exercise_title,superset_id,exercise_notes,set_index,set_type,weight_kg,reps,distance_km,duration_seconds,rpe';

    public function test_import_creates_sessions_and_sets(): void
    {
        $csv = $this->validHeaders."\n"
            .'"Upper A","May 1, 2026, 10:00 AM","May 1, 2026, 11:00 AM",,Bench Press,,,0,normal,80,8,,,8'."\n"
            .'"Upper A","May 1, 2026, 10:00 AM","May 1, 2026, 11:00 AM",,Squat,,,0,normal,100,5,,,9';

        $this->postJson('/api/workouts/import', ['file' => $this->csvUpload($csv)])
            ->assertOk()
            ->assertJson(['imported_sessions' => 1, 'imported_sets' => 2, 'skipped_sessions' => 0]);

        $this->assertDatabaseCount('workouts', 1);
        $this->assertDatabaseCount('workout_sets', 2);
        $this->assertDatabaseHas('workouts', ['title' => 'Upper A', 'ended_at' => '2026-05-01 11:00:00']);
    }

    public function test_import_skips_duplicate_sessions(): void
    {
        $csv = $this->validHeaders."\n"
            .'"Upper A","May 1, 2026, 10:00 AM","May 1, 2026, 11:00 AM",,Bench Press,,,0,normal,80,8,,,8';

        $this->postJson('/api/workouts/import', ['file' => $this->csvUpload($csv)])->assertOk();

        // Import again — should skip
        $this->postJson('/api/workouts/import', ['file' => $this->csvUpload($csv)])
            ->assertOk()
            ->assertJson(['imported_sessions' => 0, 'skipped_sessions' => 1]);

        $this->assertDatabaseCount('workouts', 1);
    }

    public function test_import_warns_on_invalid_end_time_but_still_imports(): void
    {
        $csv = $this->validHeaders."\n"
            .'"Upper A","May 1, 2026, 10:00 AM","NOT_A_DATE",,Bench Press,,,0,normal,80,8,,,8';

        $response = $this->postJson('/api/workouts/import', ['file' => $this->csvUpload($csv)])
            ->assertOk()
            ->assertJson(['imported_sessions' => 1, 'skipped_sessions' => 0]);

        $errors = $response->json('errors');
        $this->assertCount(1, $errors);
        $this->assertStringContainsString('end_time', $errors[0]['warning']);
        $this->assertDatabaseHas('workouts', ['title' => 'Upper A', 'ended_at' => null]);
    }

    public function test_import_skips_rows_with_blank_exercise_title_and_warns(): void
    {
        $csv = $this->validHeaders."\n"
            .'"Upper A","May 1, 2026, 10:00 AM","May 1, 2026, 11:00 AM",,Bench Press,,,0,normal,80,8,,,8'."\n"
            .'"Upper A","May 1, 2026, 10:00 AM","May 1, 2026, 11:00 AM",,,,,1,normal,80,8,,,8';

        $response = $this->postJson('/api/workouts/import', ['file' => $this->csvUpload($csv)])
            ->assertOk()
            ->assertJson(['imported_sessions' => 1, 'imported_sets' => 1]);

        $errors = $response->json('errors');
        $this->assertCount(1, $errors);
        $this->assertStringContainsString('exercise_title', $errors[0]['warning']);
    }

    public function test_import_skips_entire_session_when_all_rows_have_blank_exercise_title(): void
    {
        $csv = $this->validHeaders."\n"
            .'"Upper A","May 1, 2026, 10:00 AM","May 1, 2026, 11:00 AM",,,,,0,normal,80,8,,,8';

        $this->postJson('/api/workouts/import', ['file' => $this->csvUpload($csv)])
            ->assertOk()
            ->assertJson(['imported_sessions' => 0, 'skipped_sessions' => 1]);

        $this->assertDatabaseCount('workouts', 0);
    }

    public function test_import_rejects_missing_required_columns(): void
    {
        $csv = "date,exercise,reps\n2026-04-01,Squat,5";

        $this->postJson('/api/workouts/import', ['file' => $this->csvUpload($csv)])
            ->assertUnprocessable()
            ->assertJsonPath('message', 'CSV is missing required Hevy columns');
    }

    public function test_import_normalises_unknown_set_type_and_warns(): void
    {
        $csv = $this->validHeaders."\n"
            .'"Upper A","May 1, 2026, 10:00 AM","May 1, 2026, 11:00 AM",,Bench Press,,,0,supermaximal,80,8,,,8';

        $response = $this->postJson('/api/workouts/import', ['file' => $this->csvUpload($csv)])
            ->assertOk()
            ->assertJson(['imported_sessions' => 1, 'imported_sets' => 1]);

        $errors = $response->json('errors');
        $this->assertCount(1, $errors);
        $this->assertStringContainsString('supermaximal', $errors[0]['warning']);
        $this->assertDatabaseHas('workout_sets', ['set_type' => 'normal']);
    }

    public function test_import_handles_multiple_sessions(): void
    {
        $csv = $this->validHeaders."\n"
            .'"Session A","May 1, 2026, 10:00 AM","May 1, 2026, 11:00 AM",,Bench Press,,,0,normal,80,8,,,8'."\n"
            .'"Session B","May 2, 2026, 10:00 AM","May 2, 2026, 11:00 AM",,Squat,,,0,normal,100,5,,,9'."\n"
            .'"Session B","May 2, 2026, 10:00 AM","May 2, 2026, 11:00 AM",,Deadlift,,,0,normal,120,3,,,9';

        $this->postJson('/api/workouts/import', ['file' => $this->csvUpload($csv)])
            ->assertOk()
            ->assertJson(['imported_sessions' => 2, 'imported_sets' => 3, 'skipped_sessions' => 0]);
    }

    // ── PUT /api/workouts/{workout} ───────────────────────────────────────────

    public function test_update_changes_metadata_and_replaces_sets(): void
    {
        $w = $this->makeWorkout(['title' => 'Old Title']);
        $this->makeSet($w, ['exercise_title' => 'Bench Press', 'set_index' => 0]);
        $this->makeSet($w, ['exercise_title' => 'Bench Press', 'set_index' => 1]);

        $payload = [
            'title' => 'New Title',
            'started_at' => '2026-04-24T16:00:00',
            'ended_at' => '2026-04-24T17:30:00',
            'exercises' => [
                [
                    'exercise_title' => 'Squat',
                    'sets' => [
                        ['set_type' => 'warmup', 'weight_kg' => 60,  'reps' => 10],
                        ['set_type' => 'normal', 'weight_kg' => 100, 'reps' => 5, 'rpe' => 8],
                        ['set_type' => 'normal', 'weight_kg' => 105, 'reps' => 4, 'rpe' => 9],
                    ],
                ],
            ],
        ];

        $this->putJson("/api/workouts/{$w->id}", $payload)
            ->assertOk()
            ->assertJsonPath('title', 'New Title')
            ->assertJsonCount(3, 'sets');

        // Full replace: original 2 Bench Press sets gone, 3 Squat sets inserted
        $this->assertDatabaseCount('workout_sets', 3);
        $this->assertDatabaseHas('workout_sets', ['exercise_title' => 'Squat', 'set_type' => 'warmup', 'set_index' => 0]);
        $this->assertDatabaseMissing('workout_sets', ['exercise_title' => 'Bench Press']);
    }

    public function test_update_validates_required_fields(): void
    {
        $w = $this->makeWorkout();

        $this->putJson("/api/workouts/{$w->id}", [])
            ->assertUnprocessable()
            ->assertJsonValidationErrors(['title', 'started_at', 'exercises']);
    }

    public function test_update_validates_ended_at_after_started_at(): void
    {
        $w = $this->makeWorkout();

        $this->putJson("/api/workouts/{$w->id}", [
            'title' => 'Bad session',
            'started_at' => '2026-04-24T17:00:00',
            'ended_at' => '2026-04-24T16:00:00',
            'exercises' => [['exercise_title' => 'Squat', 'sets' => [['set_type' => 'normal']]]],
        ])->assertUnprocessable()
            ->assertJsonValidationErrors(['ended_at']);
    }

    public function test_update_returns_404_for_missing_workout(): void
    {
        $this->putJson('/api/workouts/9999', [
            'title' => 'Ghost',
            'started_at' => '2026-04-24T10:00:00',
            'exercises' => [['exercise_title' => 'Squat', 'sets' => [['set_type' => 'normal']]]],
        ])->assertNotFound();
    }

    // ── DELETE /api/workouts/{workout} ────────────────────────────────────────

    public function test_destroy_deletes_workout_and_cascades_sets(): void
    {
        $w = $this->makeWorkout();
        $this->makeSet($w, ['set_index' => 0]);
        $this->makeSet($w, ['set_index' => 1]);

        $this->deleteJson("/api/workouts/{$w->id}")->assertNoContent();

        $this->assertDatabaseCount('workouts', 0);
        $this->assertDatabaseCount('workout_sets', 0);
    }

    public function test_destroy_returns_404_for_missing_workout(): void
    {
        $this->deleteJson('/api/workouts/9999')->assertNotFound();
    }

    // ── GET /api/workouts/{workout} ───────────────────────────────────────────

    public function test_show_returns_404_for_missing_workout(): void
    {
        $this->getJson('/api/workouts/9999')->assertNotFound();
    }

    // ── GET /api/workouts?limit ───────────────────────────────────────────────

    public function test_index_respects_limit_param(): void
    {
        for ($i = 0; $i < 5; $i++) {
            $this->makeWorkout(['started_at' => now()->subDays($i)->toDateTimeString()]);
        }

        $this->getJson('/api/workouts?limit=3')
            ->assertOk()
            ->assertJsonCount(3, 'data');
    }

    // ── notes field ──────────────────────────────────────────────────────────

    public function test_store_persists_notes_field(): void
    {
        $this->postJson('/api/workouts', [
            'title' => 'Noted session',
            'started_at' => '2026-04-24T16:00:00',
            'notes' => 'Felt strong today',
            'exercises' => [['exercise_title' => 'Squat', 'sets' => [['set_type' => 'normal']]]],
        ])->assertCreated();

        $this->assertDatabaseHas('workouts', ['notes' => 'Felt strong today']);
    }

    // ── streak (via summary block) ────────────────────────────────────────────

    public function test_streak_is_zero_with_no_workouts(): void
    {
        $this->getJson('/api/workouts')
            ->assertOk()
            ->assertJsonPath('summary.streak_days', 0);
    }

    public function test_streak_counts_consecutive_days_ending_today(): void
    {
        $this->makeWorkout(['started_at' => now()->toDateTimeString()]);
        $this->makeWorkout(['started_at' => now()->subDay()->toDateTimeString()]);
        $this->makeWorkout(['started_at' => now()->subDays(2)->toDateTimeString()]);

        $this->getJson('/api/workouts')
            ->assertOk()
            ->assertJsonPath('summary.streak_days', 3);
    }

    public function test_streak_is_zero_when_last_session_was_yesterday(): void
    {
        // Streak algorithm starts the cursor at today — if no workout today, streak=0.
        $this->makeWorkout(['started_at' => now()->subDay()->toDateTimeString()]);
        $this->makeWorkout(['started_at' => now()->subDays(2)->toDateTimeString()]);

        $this->getJson('/api/workouts')
            ->assertOk()
            ->assertJsonPath('summary.streak_days', 0);
    }

    public function test_streak_breaks_on_gap_day(): void
    {
        $this->makeWorkout(['started_at' => now()->toDateTimeString()]);
        // Yesterday skipped intentionally
        $this->makeWorkout(['started_at' => now()->subDays(2)->toDateTimeString()]);

        $this->getJson('/api/workouts')
            ->assertOk()
            ->assertJsonPath('summary.streak_days', 1);
    }
}
