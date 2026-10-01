<?php

namespace Tests\Feature\Agent;

use App\Models\Equipment;
use App\Models\Exercise;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * The search and filter scopes both catalog screens and both catalog tools run
 * through.
 *
 * The blank cases are the point. These replaced `$request->filled()` in the two
 * controllers, and `filled()` treats a whitespace-only value as absent — so a
 * naive null/'' check silently turns "?status= " from "show everything" into a
 * filter that matches nothing. Nothing in the screen tests would have caught it,
 * because they mock the API.
 */
class FiltersCatalogTest extends TestCase
{
    use RefreshDatabase;

    private function twoExercises(): void
    {
        Exercise::create(['name' => 'Bench Press', 'primary_muscle' => 'Chest', 'exercise_type' => 'weight_reps']);
        Exercise::create(['name' => 'Squat', 'primary_muscle' => 'Quads', 'exercise_type' => 'weight_reps']);
    }

    public function test_search_matches_a_substring(): void
    {
        $this->twoExercises();

        $this->assertSame(['Bench Press'], Exercise::searchName('bench')->pluck('name')->all());
    }

    public function test_a_blank_search_is_not_a_filter(): void
    {
        $this->twoExercises();

        foreach ([null, '', '   '] as $term) {
            $this->assertCount(2, Exercise::searchName($term)->get(), 'a blank search must not narrow anything');
        }
    }

    public function test_search_escapes_like_metacharacters(): void
    {
        Exercise::create(['name' => '50% Deload', 'primary_muscle' => 'Chest', 'exercise_type' => 'weight_reps']);
        Exercise::create(['name' => 'Squat', 'primary_muscle' => 'Quads', 'exercise_type' => 'weight_reps']);

        $this->assertCount(1, Exercise::searchName('50%')->get());
        $this->assertCount(0, Exercise::searchName('%z%')->get());
    }

    public function test_filters_match_exactly(): void
    {
        $this->twoExercises();

        $this->assertSame(['Squat'], Exercise::applyFilters(['primary_muscle' => 'Quads'])->pluck('name')->all());
    }

    public function test_blank_filter_values_are_ignored(): void
    {
        $this->twoExercises();

        // " " is the case a null/'' check gets wrong: filtering on it matches no
        // row, where the controllers this replaced returned the whole catalog.
        foreach ([null, '', '   '] as $value) {
            $this->assertCount(2, Exercise::applyFilters(['primary_muscle' => $value])->get());
        }
    }

    public function test_unlisted_keys_cannot_reach_a_column(): void
    {
        $this->twoExercises();

        // `notes` is a real column but not in Exercise::FILTERS, so it is ignored
        // rather than becoming an arbitrary where clause from a query string.
        $this->assertCount(2, Exercise::applyFilters(['notes' => 'anything'])->get());
    }

    public function test_the_equipment_catalog_filters_the_same_way(): void
    {
        Equipment::create(['name' => 'Barbell', 'equipment_type' => 'Free Weights', 'status' => 'active']);
        Equipment::create(['name' => 'Sled', 'equipment_type' => 'Conditioning', 'status' => 'wishlist']);

        $this->assertSame(['Sled'], Equipment::applyFilters(['status' => 'wishlist'])->pluck('name')->all());
        $this->assertCount(2, Equipment::applyFilters(['status' => '  '])->get());
    }
}
