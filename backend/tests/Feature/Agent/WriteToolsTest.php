<?php

namespace Tests\Feature\Agent;

use App\Agent\ToolRegistry;
use App\Models\Exercise;
use App\Models\WorkoutSet;
use App\Services\Owner;
use Illuminate\Database\Eloquent\ModelNotFoundException;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Validation\ValidationException;
use Tests\TestCase;

/**
 * One test per write tool.
 *
 * The confirmation gate that decides *whether* these run lives in the runner
 * (Phase 3); what is asserted here is that when one does run it writes exactly
 * what the HTTP endpoint would have written, and that bad input is rejected by
 * throwing — which is what the runner turns into an `is_error` tool result the
 * model can correct, rather than a 500.
 */
class WriteToolsTest extends TestCase
{
    use RefreshDatabase;

    private function tool(string $tool, array $input = []): array
    {
        return app(ToolRegistry::class)->get($tool)->handle($input);
    }

    private function payload(array $overrides = []): array
    {
        return array_merge([
            'title' => 'Push Day',
            'started_at' => '2026-09-01 18:00:00',
            'exercises' => [[
                'exercise_title' => 'Bench Press',
                'sets' => [
                    ['set_type' => 'warmup', 'weight_kg' => 60, 'reps' => 5],
                    ['set_type' => 'normal', 'weight_kg' => 100, 'reps' => 8, 'rpe' => 8],
                ],
            ]],
        ], $overrides);
    }

    // ── log_workout ───────────────────────────────────────────────────────────

    public function test_log_workout_writes_the_session_and_its_sets(): void
    {
        $result = $this->tool('log_workout', $this->payload());

        $this->assertTrue($result['saved']);
        $this->assertSame(2, $result['set_count']);

        $this->assertDatabaseHas('workouts', ['id' => $result['id'], 'title' => 'Push Day']);
        $this->assertDatabaseHas('workout_sets', [
            'workout_id' => $result['id'],
            'exercise_title' => 'Bench Press',
            'set_index' => 1,
            'weight_kg' => 100,
            'rpe' => 8,
        ]);
    }

    public function test_log_workout_indexes_sets_within_their_exercise(): void
    {
        $result = $this->tool('log_workout', $this->payload(['exercises' => [
            ['exercise_title' => 'Bench Press', 'sets' => [['set_type' => 'normal', 'reps' => 5]]],
            ['exercise_title' => 'Squat', 'sets' => [['set_type' => 'normal', 'reps' => 5]]],
        ]]));

        // Both are set 0 of their own exercise, not sets 0 and 1 of the session.
        $this->assertSame([0, 0], WorkoutSet::where('workout_id', $result['id'])->pluck('set_index')->all());
    }

    public function test_log_workout_rejects_an_unknown_set_type(): void
    {
        $this->expectException(ValidationException::class);

        $this->tool('log_workout', $this->payload(['exercises' => [
            ['exercise_title' => 'Bench Press', 'sets' => [['set_type' => 'amrap', 'reps' => 5]]],
        ]]));
    }

    public function test_log_workout_rejects_a_session_with_no_exercises(): void
    {
        $this->expectException(ValidationException::class);

        $this->tool('log_workout', $this->payload(['exercises' => []]));
    }

    public function test_log_workout_writes_nothing_when_validation_fails(): void
    {
        try {
            $this->tool('log_workout', $this->payload(['started_at' => 'yesterday-ish']));
        } catch (ValidationException) {
            // Expected — the point is what did not happen.
        }

        $this->assertDatabaseCount('workouts', 0);
    }

    // ── update_workout ────────────────────────────────────────────────────────

    public function test_update_workout_replaces_every_set(): void
    {
        $id = $this->tool('log_workout', $this->payload())['id'];

        $result = $this->tool('update_workout', $this->payload([
            'id' => $id,
            'title' => 'Push Day (corrected)',
            'exercises' => [[
                'exercise_title' => 'Bench Press',
                'sets' => [['set_type' => 'normal', 'weight_kg' => 102.5, 'reps' => 8]],
            ]],
        ]));

        $this->assertTrue($result['replaced']);
        $this->assertSame(1, $result['set_count']);
        $this->assertDatabaseHas('workouts', ['id' => $id, 'title' => 'Push Day (corrected)']);
        // The two original sets are gone, not merged with the new one.
        $this->assertSame(1, WorkoutSet::where('workout_id', $id)->count());
    }

    public function test_update_workout_404s_on_a_missing_id(): void
    {
        $this->expectException(ModelNotFoundException::class);

        $this->tool('update_workout', $this->payload(['id' => 999]));
    }

    public function test_update_workout_leaves_the_session_untouched_when_validation_fails(): void
    {
        $id = $this->tool('log_workout', $this->payload())['id'];

        try {
            $this->tool('update_workout', $this->payload(['id' => $id, 'title' => '']));
        } catch (ValidationException) {
            // Expected.
        }

        $this->assertDatabaseHas('workouts', ['id' => $id, 'title' => 'Push Day']);
        $this->assertSame(2, WorkoutSet::where('workout_id', $id)->count());
    }

    // ── create_exercise ───────────────────────────────────────────────────────

    public function test_create_exercise_adds_to_the_catalog(): void
    {
        $result = $this->tool('create_exercise', [
            'name' => 'Incline Dumbbell Press',
            'primary_muscle' => 'Chest',
            'equipment' => 'Dumbbell',
            'exercise_type' => 'weight_reps',
        ]);

        $this->assertTrue($result['saved']);

        // The owner is stamped even here, where there is no request to read a user
        // from — which is the whole reason `BelongsToOwner` does it at `creating`
        // rather than each writer doing it for itself.
        $this->assertDatabaseHas('exercises', [
            'id' => $result['id'],
            'name' => 'Incline Dumbbell Press',
            'user_id' => Owner::id(),
        ]);
    }

    public function test_create_exercise_rejects_a_duplicate_name(): void
    {
        Exercise::create([
            'name' => 'Bench Press',
            'primary_muscle' => 'Chest',
            'exercise_type' => 'weight_reps',
        ]);

        $this->expectException(ValidationException::class);

        // Scoped to the owner, exactly as the form's rule is — an agent must not be
        // able to insert a duplicate the screen would have refused.
        $this->tool('create_exercise', [
            'name' => 'Bench Press',
            'primary_muscle' => 'Chest',
            'exercise_type' => 'weight_reps',
        ]);
    }

    public function test_create_exercise_rejects_an_unknown_type(): void
    {
        $this->expectException(ValidationException::class);

        $this->tool('create_exercise', [
            'name' => 'Sled Push',
            'primary_muscle' => 'Quads',
            'exercise_type' => 'vibes',
        ]);
    }

    // ── save_insight ──────────────────────────────────────────────────────────

    public function test_save_insight_lands_on_the_insights_screen(): void
    {
        $result = $this->tool('save_insight', [
            'domain' => 'fitness',
            'kind' => 'plateau_review',
            'title' => 'Why bench stalled',
            'response' => 'Volume has been flat for five weeks.',
        ]);

        $this->assertTrue($result['saved']);
        $this->assertDatabaseHas('insights', ['id' => $result['id'], 'kind' => 'plateau_review']);

        // The endpoint the frontend already renders picks it up unchanged.
        $this->getJson('/api/insights?domain=fitness')
            ->assertOk()
            ->assertJsonPath('data.0.title', 'Why bench stalled');
    }

    public function test_save_insight_rejects_an_unknown_domain(): void
    {
        $this->expectException(ValidationException::class);

        $this->tool('save_insight', [
            'domain' => 'astrology',
            'kind' => 'reading',
            'title' => 'Mercury',
            'response' => 'Retrograde.',
        ]);
    }
}
