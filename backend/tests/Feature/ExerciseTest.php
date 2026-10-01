<?php

namespace Tests\Feature;

use App\Models\Exercise;
use App\Models\Workout;
use App\Models\WorkoutSet;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class ExerciseTest extends TestCase
{
    use RefreshDatabase;

    // ── Helpers ───────────────────────────────────────────────────────────────

    private function makeExercise(array $attrs = []): Exercise
    {
        return Exercise::create(array_merge([
            'name' => 'Bench Press',
            'primary_muscle' => 'Chest',
            'equipment' => 'Barbell',
            'exercise_type' => 'weight_reps',
        ], $attrs));
    }

    private function makeSet(Workout $workout, string $exerciseTitle, array $attrs = []): WorkoutSet
    {
        return WorkoutSet::create(array_merge([
            'workout_id' => $workout->id,
            'exercise_title' => $exerciseTitle,
            'set_index' => 0,
            'set_type' => 'normal',
            'weight_kg' => 80,
            'reps' => 8,
        ], $attrs));
    }

    private function validPayload(array $overrides = []): array
    {
        return array_merge([
            'name' => 'Incline Bench Press',
            'primary_muscle' => 'Chest',
            'equipment' => 'Dumbbell',
            'exercise_type' => 'weight_reps',
        ], $overrides);
    }

    // ── GET /api/exercises ────────────────────────────────────────────────────

    public function test_index_returns_exercises_ordered_by_muscle_then_name(): void
    {
        $this->makeExercise(['name' => 'Squat',      'primary_muscle' => 'Legs']);
        $this->makeExercise(['name' => 'Bench Press', 'primary_muscle' => 'Chest']);
        $this->makeExercise(['name' => 'Arnold Press', 'primary_muscle' => 'Chest']);

        $this->getJson('/api/exercises')
            ->assertOk()
            ->assertJsonCount(3, 'data')
            ->assertJsonPath('data.0.name', 'Arnold Press') // Chest, alphabetically first
            ->assertJsonPath('data.1.name', 'Bench Press')
            ->assertJsonPath('data.2.name', 'Squat');       // Legs
    }

    public function test_index_returns_empty_data_when_no_exercises_exist(): void
    {
        $this->getJson('/api/exercises')
            ->assertOk()
            ->assertJsonCount(0, 'data');
    }

    public function test_index_filters_by_search_term(): void
    {
        $this->makeExercise(['name' => 'Bench Press']);
        $this->makeExercise(['name' => 'Incline Bench Press']);
        $this->makeExercise(['name' => 'Squat', 'primary_muscle' => 'Legs']);

        $this->getJson('/api/exercises?search=bench')
            ->assertOk()
            ->assertJsonCount(2, 'data');
    }

    public function test_index_search_is_case_insensitive(): void
    {
        $this->makeExercise(['name' => 'Bench Press']);

        $this->getJson('/api/exercises?search=BENCH')
            ->assertOk()
            ->assertJsonCount(1, 'data');
    }

    public function test_index_treats_percent_in_search_as_a_literal(): void
    {
        $this->makeExercise(['name' => 'Bench Press']);
        $this->makeExercise(['name' => 'Squat 50% 1RM', 'primary_muscle' => 'Legs']);

        // Without escaping, "%" would act as a wildcard and match everything.
        $this->getJson('/api/exercises?search='.urlencode('50%'))
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.name', 'Squat 50% 1RM');
    }

    public function test_index_treats_underscore_in_search_as_a_literal(): void
    {
        $this->makeExercise(['name' => 'Warm Up']);
        $this->makeExercise(['name' => 'warm_up', 'primary_muscle' => 'Other']);

        // Unescaped, "_" matches any single character and would return both.
        $this->getJson('/api/exercises?search=warm_up')
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.name', 'warm_up');
    }

    public function test_index_treats_the_escape_character_itself_as_a_literal(): void
    {
        $this->makeExercise(['name' => 'Burpees']);
        $this->makeExercise(['name' => 'Burpees!', 'primary_muscle' => 'Other']);

        // '!' is the ESCAPE character, so it has to be escaped in the term too.
        $this->getJson('/api/exercises?search='.urlencode('Burpees!'))
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.name', 'Burpees!');
    }

    public function test_index_ignores_blank_search_and_returns_all(): void
    {
        $this->makeExercise(['name' => 'Bench Press']);
        $this->makeExercise(['name' => 'Squat', 'primary_muscle' => 'Legs']);

        $this->getJson('/api/exercises?search=')
            ->assertOk()
            ->assertJsonCount(2, 'data');
    }

    // ── GET /api/exercises — filters ──────────────────────────────────────────

    public function test_index_filters_by_primary_muscle(): void
    {
        $this->makeExercise(['name' => 'Bench Press', 'primary_muscle' => 'Chest']);
        $this->makeExercise(['name' => 'Squat', 'primary_muscle' => 'Legs']);

        $this->getJson('/api/exercises?primary_muscle=Legs')
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.name', 'Squat');
    }

    public function test_index_filters_by_equipment(): void
    {
        $this->makeExercise(['name' => 'Bench Press', 'equipment' => 'Barbell']);
        $this->makeExercise(['name' => 'Fly', 'equipment' => 'Cable']);

        $this->getJson('/api/exercises?equipment=Cable')
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.name', 'Fly');
    }

    public function test_index_filters_by_exercise_type(): void
    {
        $this->makeExercise(['name' => 'Bench Press', 'exercise_type' => 'weight_reps']);
        $this->makeExercise(['name' => 'Plank', 'primary_muscle' => 'Core', 'exercise_type' => 'duration']);

        $this->getJson('/api/exercises?exercise_type=duration')
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.name', 'Plank');
    }

    public function test_index_combines_filters_with_the_search_term(): void
    {
        $this->makeExercise(['name' => 'Barbell Row', 'primary_muscle' => 'Back', 'equipment' => 'Barbell']);
        $this->makeExercise(['name' => 'Cable Row', 'primary_muscle' => 'Back', 'equipment' => 'Cable']);
        $this->makeExercise(['name' => 'Barbell Curl', 'primary_muscle' => 'Biceps', 'equipment' => 'Barbell']);

        // Every condition narrows the same set rather than replacing it.
        $this->getJson('/api/exercises?search=row&equipment=Barbell')
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.name', 'Barbell Row');
    }

    public function test_index_ignores_a_blank_filter(): void
    {
        $this->makeExercise(['name' => 'Bench Press']);
        $this->makeExercise(['name' => 'Squat', 'primary_muscle' => 'Legs']);

        // An unset picker sends nothing, but a client that sends the empty
        // string must not be read as asking for exercises with no muscle.
        $this->getJson('/api/exercises?primary_muscle=')
            ->assertOk()
            ->assertJsonCount(2, 'data');
    }

    // ── GET /api/exercises — pagination ───────────────────────────────────────

    /** Creates $count exercises named "Ex 01", "Ex 02", … so page order is readable. */
    private function makeExercises(int $count): void
    {
        for ($i = 1; $i <= $count; $i++) {
            $this->makeExercise(['name' => sprintf('Ex %02d', $i)]);
        }
    }

    public function test_index_returns_every_row_when_no_page_size_is_asked_for(): void
    {
        $this->makeExercises(7);

        // The exercise picker on the Workouts screen needs the complete list,
        // so the default must stay unpaginated.
        $this->getJson('/api/exercises')
            ->assertOk()
            ->assertJsonCount(7, 'data')
            ->assertJsonPath('meta.total', 7)
            ->assertJsonPath('meta.per_page', null)
            ->assertJsonPath('meta.last_page', 1)
            ->assertJsonPath('meta.from', 1)
            ->assertJsonPath('meta.to', 7);
    }

    public function test_index_returns_one_page_when_per_page_is_given(): void
    {
        $this->makeExercises(7);

        $this->getJson('/api/exercises?per_page=3')
            ->assertOk()
            ->assertJsonCount(3, 'data')
            ->assertJsonPath('data.0.name', 'Ex 01')
            ->assertJsonPath('data.2.name', 'Ex 03')
            ->assertJsonPath('meta.page', 1)
            ->assertJsonPath('meta.per_page', 3)
            ->assertJsonPath('meta.total', 7)
            ->assertJsonPath('meta.last_page', 3)
            ->assertJsonPath('meta.from', 1)
            ->assertJsonPath('meta.to', 3);
    }

    public function test_index_returns_the_requested_page(): void
    {
        $this->makeExercises(7);

        $this->getJson('/api/exercises?per_page=3&page=3')
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.name', 'Ex 07')
            ->assertJsonPath('meta.from', 7)
            ->assertJsonPath('meta.to', 7);
    }

    public function test_index_clamps_a_page_beyond_the_last_one(): void
    {
        $this->makeExercises(7);

        // Deleting the last row of the last page leaves a client asking for a
        // page that no longer exists; it gets the final page, and meta.page
        // tells it where it actually landed.
        $this->getJson('/api/exercises?per_page=3&page=99')
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('meta.page', 3);
    }

    public function test_index_counts_the_filtered_set_not_the_table(): void
    {
        $this->makeExercise(['name' => 'Bench Press', 'primary_muscle' => 'Chest']);
        $this->makeExercise(['name' => 'Fly', 'primary_muscle' => 'Chest']);
        $this->makeExercise(['name' => 'Squat', 'primary_muscle' => 'Legs']);

        // meta.total drives the page count, so it has to reflect the filters.
        $this->getJson('/api/exercises?primary_muscle=Chest&per_page=1')
            ->assertOk()
            ->assertJsonPath('meta.total', 2)
            ->assertJsonPath('meta.last_page', 2);
    }

    public function test_index_reports_an_empty_page_without_bounds(): void
    {
        $this->getJson('/api/exercises?per_page=10')
            ->assertOk()
            ->assertJsonCount(0, 'data')
            ->assertJsonPath('meta.total', 0)
            ->assertJsonPath('meta.last_page', 1)
            // No first or last row to point at.
            ->assertJsonPath('meta.from', null)
            ->assertJsonPath('meta.to', null);
    }

    public function test_index_caps_an_oversized_page_size(): void
    {
        $this->makeExercises(3);

        $this->getJson('/api/exercises?per_page=100000')
            ->assertOk()
            ->assertJsonPath('meta.per_page', 100);
    }

    // ── POST /api/exercises ───────────────────────────────────────────────────

    public function test_store_creates_exercise_and_returns_201(): void
    {
        $this->postJson('/api/exercises', $this->validPayload())
            ->assertCreated()
            ->assertJsonPath('name', 'Incline Bench Press')
            ->assertJsonPath('primary_muscle', 'Chest')
            ->assertJsonPath('equipment', 'Dumbbell')
            ->assertJsonPath('exercise_type', 'weight_reps');

        $this->assertDatabaseHas('exercises', ['name' => 'Incline Bench Press']);
    }

    public function test_store_allows_optional_equipment_and_notes_to_be_omitted(): void
    {
        $payload = $this->validPayload();
        unset($payload['equipment']);

        $this->postJson('/api/exercises', $payload)
            ->assertCreated()
            ->assertJsonPath('equipment', null)
            ->assertJsonPath('notes', null);
    }

    public function test_store_requires_name_primary_muscle_and_exercise_type(): void
    {
        $this->postJson('/api/exercises', [])
            ->assertStatus(422)
            ->assertJsonValidationErrors(['name', 'primary_muscle', 'exercise_type']);
    }

    public function test_store_rejects_unknown_exercise_type(): void
    {
        $this->postJson('/api/exercises', $this->validPayload(['exercise_type' => 'bogus']))
            ->assertStatus(422)
            ->assertJsonValidationErrors('exercise_type');
    }

    public function test_store_accepts_every_supported_exercise_type(): void
    {
        foreach (['weight_reps', 'reps_only', 'duration', 'distance_duration'] as $i => $type) {
            $this->postJson('/api/exercises', $this->validPayload([
                'name' => 'Exercise '.$i,
                'exercise_type' => $type,
            ]))->assertCreated();
        }
    }

    public function test_store_rejects_duplicate_name(): void
    {
        $this->makeExercise(['name' => 'Bench Press']);

        $this->postJson('/api/exercises', $this->validPayload(['name' => 'Bench Press']))
            ->assertStatus(422)
            ->assertJsonValidationErrors('name');
    }

    // ── GET /api/exercises/{id} ───────────────────────────────────────────────

    public function test_show_returns_the_exercise(): void
    {
        $exercise = $this->makeExercise();

        $this->getJson("/api/exercises/{$exercise->id}")
            ->assertOk()
            ->assertJsonPath('id', $exercise->id)
            ->assertJsonPath('name', 'Bench Press');
    }

    public function test_show_returns_404_for_unknown_exercise(): void
    {
        $this->getJson('/api/exercises/999')->assertNotFound();
    }

    // ── PUT /api/exercises/{id} ───────────────────────────────────────────────

    public function test_update_modifies_the_exercise(): void
    {
        $exercise = $this->makeExercise();

        $this->putJson("/api/exercises/{$exercise->id}", $this->validPayload([
            'name' => 'Bench Press (Barbell)',
            'primary_muscle' => 'Chest',
            'notes' => 'Pause at the bottom',
        ]))
            ->assertOk()
            ->assertJsonPath('name', 'Bench Press (Barbell)')
            ->assertJsonPath('notes', 'Pause at the bottom');

        $this->assertDatabaseHas('exercises', ['id' => $exercise->id, 'name' => 'Bench Press (Barbell)']);
    }

    public function test_update_allows_keeping_its_own_name(): void
    {
        $exercise = $this->makeExercise(['name' => 'Bench Press']);

        $this->putJson("/api/exercises/{$exercise->id}", $this->validPayload([
            'name' => 'Bench Press',
            'primary_muscle' => 'Shoulders',
        ]))
            ->assertOk()
            ->assertJsonPath('primary_muscle', 'Shoulders');
    }

    public function test_update_rejects_a_name_already_used_by_another_exercise(): void
    {
        $this->makeExercise(['name' => 'Bench Press']);
        $other = $this->makeExercise(['name' => 'Squat', 'primary_muscle' => 'Legs']);

        $this->putJson("/api/exercises/{$other->id}", $this->validPayload(['name' => 'Bench Press']))
            ->assertStatus(422)
            ->assertJsonValidationErrors('name');
    }

    // ── Rename propagation into workout history ───────────────────────────────

    public function test_renaming_an_exercise_updates_matching_workout_sets(): void
    {
        $exercise = $this->makeExercise(['name' => 'Bench Press']);
        $workout = $this->makeWorkout();

        $renamed = $this->makeSet($workout, 'Bench Press');
        $other = $this->makeSet($workout, 'Squat', ['set_index' => 1]);

        $this->putJson("/api/exercises/{$exercise->id}", $this->validPayload([
            'name' => 'Bench Press (Barbell)',
        ]))->assertOk();

        $this->assertSame('Bench Press (Barbell)', $renamed->fresh()->exercise_title);
        $this->assertSame('Squat', $other->fresh()->exercise_title, 'unrelated sets must not be touched');
    }

    public function test_renaming_updates_sets_across_multiple_workouts(): void
    {
        $exercise = $this->makeExercise(['name' => 'Bench Press']);

        $setA = $this->makeSet($this->makeWorkout(['title' => 'Upper 1']), 'Bench Press');
        $setB = $this->makeSet($this->makeWorkout(['title' => 'Upper 2']), 'Bench Press');

        $this->putJson("/api/exercises/{$exercise->id}", $this->validPayload([
            'name' => 'Barbell Bench Press',
        ]))->assertOk();

        $this->assertSame('Barbell Bench Press', $setA->fresh()->exercise_title);
        $this->assertSame('Barbell Bench Press', $setB->fresh()->exercise_title);
    }

    public function test_updating_without_changing_the_name_leaves_sets_alone(): void
    {
        $exercise = $this->makeExercise(['name' => 'Bench Press']);
        $set = $this->makeSet($this->makeWorkout(), 'Bench Press');

        $originalUpdatedAt = $set->updated_at;

        $this->putJson("/api/exercises/{$exercise->id}", $this->validPayload([
            'name' => 'Bench Press',
            'primary_muscle' => 'Shoulders',
        ]))->assertOk();

        $set->refresh();
        $this->assertSame('Bench Press', $set->exercise_title);
        $this->assertEquals($originalUpdatedAt, $set->updated_at, 'sets should not be rewritten when the name is unchanged');
    }

    // ── DELETE /api/exercises/{id} ────────────────────────────────────────────

    public function test_destroy_removes_the_exercise_and_returns_204(): void
    {
        $exercise = $this->makeExercise();

        $this->deleteJson("/api/exercises/{$exercise->id}")->assertNoContent();

        $this->assertDatabaseMissing('exercises', ['id' => $exercise->id]);
    }

    public function test_destroy_leaves_historical_workout_sets_intact(): void
    {
        $exercise = $this->makeExercise(['name' => 'Bench Press']);
        $set = $this->makeSet($this->makeWorkout(), 'Bench Press');

        $this->deleteJson("/api/exercises/{$exercise->id}")->assertNoContent();

        $this->assertSame('Bench Press', $set->fresh()->exercise_title);
    }

    public function test_destroy_returns_404_for_unknown_exercise(): void
    {
        $this->deleteJson('/api/exercises/999')->assertNotFound();
    }
}
