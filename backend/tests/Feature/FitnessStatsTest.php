<?php

namespace Tests\Feature;

use App\Models\Exercise;
use App\Models\User;
use App\Models\Workout;
use App\Models\WorkoutSet;
use App\Services\FitnessSettings;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Tests\TestCase;

class FitnessStatsTest extends TestCase
{
    use RefreshDatabase;

    private function addSet(Workout $w, array $attrs = []): WorkoutSet
    {
        return WorkoutSet::create(array_merge([
            'workout_id' => $w->id,
            'exercise_title' => 'Bench Press',
            'set_index' => 0,
            'set_type' => 'normal',
            'weight_kg' => 100,
            'reps' => 5,
        ], $attrs));
    }

    /** A session `$daysAgo` days back carrying one set. */
    private function logSession(int $daysAgo, array $setAttrs = []): Workout
    {
        $w = $this->makeWorkout(['started_at' => now()->subDays($daysAgo)->toDateTimeString()]);
        $this->addSet($w, $setAttrs);

        return $w;
    }

    // ── Range resolution ─────────────────────────────────────────────────────────

    public function test_empty_database_returns_zeroed_payload_in_the_narrowest_window(): void
    {
        $res = $this->getJson('/api/fitness/stats')->assertOk();

        // A new user should be shown "nothing this month", not "nothing ever".
        $this->assertSame('4w', $res->json('range.resolved'));
        $this->assertNull($res->json('range.data_first'));
        $this->assertSame(0, $res->json('kpis.sessions'));
        $this->assertSame(0, $res->json('kpis.hard_sets'));
        $this->assertSame([], $res->json('heatmap.days'));
        $this->assertSame([], $res->json('muscles.items'));
        $this->assertSame([], $res->json('strength.lifts'));
        $this->assertSame([], $res->json('strength.recent_prs'));
    }

    public function test_auto_widens_past_empty_windows_to_reach_the_data(): void
    {
        $this->logSession(100);

        $res = $this->getJson('/api/fitness/stats')->assertOk();

        // 4w and 12w are both empty; 1y is the narrowest window holding the session.
        $this->assertSame('1y', $res->json('range.resolved'));
        $this->assertSame(1, $res->json('kpis.sessions'));
    }

    public function test_an_explicit_range_is_honoured_even_when_it_is_empty(): void
    {
        $this->logSession(100);

        $res = $this->getJson('/api/fitness/stats?range=4w')->assertOk();

        // Auto widens; an explicit ask never does. An empty 4w is the honest answer.
        $this->assertSame('4w', $res->json('range.resolved'));
        $this->assertSame(0, $res->json('kpis.sessions'));
    }

    public function test_range_all_starts_at_the_first_session(): void
    {
        $this->logSession(400);

        $res = $this->getJson('/api/fitness/stats?range=all')->assertOk();

        $this->assertSame('all', $res->json('range.resolved'));
        $this->assertSame(now()->subDays(400)->toDateString(), $res->json('range.from'));
        $this->assertSame(1, $res->json('kpis.sessions'));
    }

    public function test_unknown_range_is_rejected(): void
    {
        $this->getJson('/api/fitness/stats?range=7d')->assertStatus(422);
    }

    // ── Volume and hard sets ─────────────────────────────────────────────────────

    public function test_warmup_sets_are_excluded_from_hard_sets_and_tonnage(): void
    {
        $w = $this->makeWorkout();
        $this->addSet($w, ['weight_kg' => 100, 'reps' => 5]);
        $this->addSet($w, ['set_index' => 1, 'set_type' => 'warmup', 'weight_kg' => 60, 'reps' => 10]);

        $res = $this->getJson('/api/fitness/stats?range=4w')->assertOk();

        $this->assertSame(1, $res->json('kpis.hard_sets'));
        $this->assertEquals(500, $res->json('kpis.tonnage_kg'));
    }

    public function test_tonnage_is_weight_times_reps_summed_over_hard_sets(): void
    {
        $w = $this->makeWorkout();
        $this->addSet($w, ['weight_kg' => 100, 'reps' => 5]);
        $this->addSet($w, ['set_index' => 1, 'weight_kg' => 60, 'reps' => 10]);

        $res = $this->getJson('/api/fitness/stats?range=4w')->assertOk();

        $this->assertEquals(1100, $res->json('kpis.tonnage_kg'));
        $this->assertSame(2, $res->json('kpis.hard_sets'));
    }

    public function test_a_bodyweight_set_counts_as_a_hard_set_but_adds_no_tonnage(): void
    {
        $w = $this->makeWorkout();
        $this->addSet($w, ['exercise_title' => 'Pull Up', 'weight_kg' => null, 'reps' => 8]);

        $res = $this->getJson('/api/fitness/stats?range=4w')->assertOk();

        $this->assertSame(1, $res->json('kpis.hard_sets'));
        $this->assertEquals(0, $res->json('kpis.tonnage_kg'));
    }

    public function test_a_set_with_no_recorded_metric_is_not_a_hard_set(): void
    {
        $w = $this->makeWorkout();
        $this->addSet($w, ['weight_kg' => null, 'reps' => null]);

        $this->getJson('/api/fitness/stats?range=4w')
            ->assertOk()
            ->assertJsonPath('kpis.hard_sets', 0);
    }

    public function test_tonnage_is_a_json_number_not_a_string(): void
    {
        $w = $this->makeWorkout();
        $this->addSet($w, ['weight_kg' => 100, 'reps' => 5]);

        $res = $this->getJson('/api/fitness/stats?range=4w')->assertOk();

        // SQLite returns decimal columns through PDO as strings; uncast they would
        // serialise as "500" and become NaN the moment JS did arithmetic on them.
        // JSON has a single number type, so int-vs-float is not the contract here —
        // "never a string" is.
        $this->assertIsNotString($res->json('kpis.tonnage_kg'));
        $this->assertIsNotString($res->json('heatmap.days.0.tonnage_kg'));
        $this->assertIsNotString($res->json('muscles.items.0.tonnage_kg'));
        $this->assertIsInt($res->json('kpis.hard_sets'));
    }

    // ── Duration ─────────────────────────────────────────────────────────────────

    public function test_average_duration_ignores_sessions_with_no_end_time(): void
    {
        $this->makeWorkout([
            'started_at' => now()->subDays(1)->setTime(16, 0)->toDateTimeString(),
            'ended_at' => now()->subDays(1)->setTime(17, 30)->toDateTimeString(),
        ]);
        $this->makeWorkout(['started_at' => now()->subDays(2)->toDateTimeString()]);

        $res = $this->getJson('/api/fitness/stats?range=4w')->assertOk();

        // 90 minutes over the one timed session, not 45 over both.
        $this->assertEquals(90, $res->json('kpis.avg_duration_min'));
        $this->assertSame(2, $res->json('kpis.sessions'));
    }

    // ── Weekly buckets ───────────────────────────────────────────────────────────

    public function test_volume_weeks_are_dense_and_start_on_consecutive_mondays(): void
    {
        $this->logSession(2);

        $weeks = $this->getJson('/api/fitness/stats?range=12w')->assertOk()->json('volume.weeks');

        $this->assertGreaterThan(4, count($weeks));
        foreach ($weeks as $w) {
            $this->assertSame('Monday', date('l', strtotime($w['week_start'])));
        }
        // Gaps have to render as empty bars, so every week between the endpoints
        // must be present — no compressing an untrained month out of the axis.
        for ($i = 1; $i < count($weeks); $i++) {
            $this->assertSame(
                7 * 86400,
                strtotime($weeks[$i]['week_start']) - strtotime($weeks[$i - 1]['week_start']),
            );
        }
    }

    public function test_weeks_start_on_sunday_when_chosen(): void
    {
        FitnessSettings::updateCalculations(['week_start' => 'sunday']);
        $this->logSession(2);

        $res = $this->getJson('/api/fitness/stats?range=12w')->assertOk();

        $this->assertSame('Sunday', date('l', strtotime($res->json('heatmap.from'))));
        $this->assertSame($res->json('heatmap.from'), $res->json('volume.weeks.0.week_start'));
        foreach ($res->json('volume.weeks') as $w) {
            $this->assertSame('Sunday', date('l', strtotime($w['week_start'])));
        }
        $this->assertSame('sunday', $res->json('settings.week_start'));
    }

    public function test_a_sunday_session_changes_week_with_the_origin(): void
    {
        $this->travelTo(now()->next('Wednesday'));
        $sunday = now()->previous('Sunday');
        $this->makeWorkout(['started_at' => $sunday->copy()->setTime(9, 0)->toDateTimeString()]);

        $bucket = fn () => collect($this->getJson('/api/fitness/stats?range=4w')->json('volume.weeks'))
            ->firstWhere('sessions', 1)['week_start'];

        // Monday weeks: Sunday closes the week before. Sunday weeks: it opens its own.
        $this->assertSame($sunday->copy()->subDays(6)->toDateString(), $bucket());

        FitnessSettings::updateCalculations(['week_start' => 'sunday']);
        $this->assertSame($sunday->toDateString(), $bucket());
    }

    // ── Muscle split ─────────────────────────────────────────────────────────────

    public function test_muscle_split_maps_sets_through_the_exercise_catalog(): void
    {
        Exercise::create(['name' => 'Bench Press', 'primary_muscle' => 'Chest']);
        Exercise::create(['name' => 'Back Squat', 'primary_muscle' => 'Legs']);

        $w = $this->makeWorkout();
        $this->addSet($w, ['exercise_title' => 'Bench Press']);
        $this->addSet($w, ['set_index' => 1, 'exercise_title' => 'Back Squat']);
        $this->addSet($w, ['set_index' => 2, 'exercise_title' => 'Back Squat']);

        $res = $this->getJson('/api/fitness/stats?range=4w')->assertOk();

        $this->assertSame(
            [['Legs', 2], ['Chest', 1]],
            array_map(fn ($i) => [$i['muscle'], $i['hard_sets']], $res->json('muscles.items')),
        );
        $this->assertSame(0, $res->json('muscles.unmatched_sets'));
        $this->assertSame(3, $res->json('muscles.total_hard_sets'));
    }

    public function test_sets_with_no_matching_exercise_land_in_a_visible_unknown_bucket(): void
    {
        Exercise::create(['name' => 'Bench Press', 'primary_muscle' => 'Chest']);

        $w = $this->makeWorkout();
        $this->addSet($w, ['exercise_title' => 'Bench Press']);
        $this->addSet($w, ['set_index' => 1, 'exercise_title' => 'Some Imported Lift']);

        $res = $this->getJson('/api/fitness/stats?range=4w')->assertOk();

        // Never silently dropped — an unmatched title has to stay in the totals.
        $this->assertSame(1, $res->json('muscles.unmatched_sets'));
        $this->assertSame(2, $res->json('muscles.total_hard_sets'));
        $this->assertContains('Unknown', array_column($res->json('muscles.items'), 'muscle'));
    }

    public function test_duplicate_exercise_names_do_not_double_count_the_split(): void
    {
        // Two owners, because that is now the only way a duplicate name can exist.
        // unique(user_id, name) used to constrain nothing at all — every user_id was
        // null and SQL counts each null as distinct — so this test used to insert the
        // pair under one owner. The index is real since the backfill, and it is
        // scoped per owner, so the collision the muscle-split query still has to
        // survive is a cross-owner one: it groups by name and does not filter on the
        // owner, so both rows reach the join.
        Exercise::create(['name' => 'Bench Press', 'primary_muscle' => 'Chest']);
        Exercise::create([
            'user_id' => User::create([
                'name' => 'Somebody Else',
                'email' => 'else@example.test',
                'password' => 'irrelevant',
            ])->id,
            'name' => 'Bench Press',
            'primary_muscle' => 'Chest',
        ]);

        $w = $this->makeWorkout();
        $this->addSet($w, ['exercise_title' => 'Bench Press']);

        $this->getJson('/api/fitness/stats?range=4w')
            ->assertOk()
            ->assertJsonPath('muscles.total_hard_sets', 1)
            ->assertJsonPath('muscles.items.0.hard_sets', 1);
    }

    // ── Strength ─────────────────────────────────────────────────────────────────

    public function test_estimated_one_rep_max_uses_the_epley_formula(): void
    {
        foreach ([3, 2, 1] as $daysAgo) {
            $this->logSession($daysAgo, ['weight_kg' => 100, 'reps' => 5]);
        }

        $res = $this->getJson('/api/fitness/stats?range=4w')->assertOk();

        // 100 × (1 + 5/30) = 116.666… → 116.7
        $this->assertSame(116.7, $res->json('strength.lifts.0.points.0.e1rm_kg'));
        $this->assertSame(116.7, $res->json('strength.lifts.0.latest_e1rm_kg'));
    }

    public function test_brzycki_is_used_when_chosen_and_the_payload_says_which(): void
    {
        foreach ([3, 2, 1] as $daysAgo) {
            $this->logSession($daysAgo, ['weight_kg' => 100, 'reps' => 5]);
        }

        $this->getJson('/api/fitness/stats?range=4w')->assertJsonPath('settings', [
            'e1rm_formula' => 'epley',
            'week_start' => 'monday',
        ]);

        FitnessSettings::updateCalculations(['e1rm_formula' => 'brzycki']);
        $res = $this->getJson('/api/fitness/stats?range=4w')->assertOk();

        // 100 × 36 / (37 − 5) = 112.5
        $this->assertEquals(112.5, $res->json('strength.lifts.0.latest_e1rm_kg'));
        $this->assertSame('brzycki', $res->json('settings.e1rm_formula'));
    }

    public function test_brzycki_holds_the_rep_cap_and_compares_records_with_itself(): void
    {
        // At the cap the denominator is 25, never zero or negative.
        $this->logSession(3, ['weight_kg' => 100, 'reps' => 5]);    // 112.5
        $this->logSession(2, ['weight_kg' => 80, 'reps' => 12]);    // 115.2
        $this->logSession(1, ['weight_kg' => 60, 'reps' => 20]);    // over the cap: no point
        FitnessSettings::updateCalculations(['e1rm_formula' => 'brzycki']);

        $prs = $this->getJson('/api/fitness/stats?range=4w')->assertOk()->json('strength.recent_prs');

        $this->assertCount(1, $prs);
        $this->assertEquals(115.2, $prs[0]['e1rm_kg']);
        $this->assertEquals(112.5, $prs[0]['previous_e1rm_kg']);
    }

    public function test_a_point_carries_the_weight_and_reps_of_the_best_set_of_the_day(): void
    {
        $w = $this->makeWorkout();
        $this->addSet($w, ['weight_kg' => 60, 'reps' => 12]);   // e1RM 84.0
        $this->addSet($w, ['set_index' => 1, 'weight_kg' => 100, 'reps' => 5]);  // e1RM 116.7
        $this->addSet($w, ['set_index' => 2, 'weight_kg' => 90, 'reps' => 3]);   // e1RM 99.0
        $this->logSession(1, ['weight_kg' => 100, 'reps' => 5]);
        $this->logSession(2, ['weight_kg' => 100, 'reps' => 5]);

        $points = $this->getJson('/api/fitness/stats?range=4w')->assertOk()->json('strength.lifts.0.points');
        $today = collect($points)->firstWhere('date', now()->toDateString());

        // Not the heaviest set and not an arbitrary one — the set that produced the
        // day's best estimate.
        $this->assertSame(116.7, $today['e1rm_kg']);
        $this->assertEquals(100, $today['weight_kg']);
        $this->assertSame(5, $today['reps']);
    }

    public function test_sets_above_the_rep_cap_produce_no_estimate(): void
    {
        foreach ([3, 2, 1] as $daysAgo) {
            $this->logSession($daysAgo, ['weight_kg' => 60, 'reps' => 15]);
        }

        $res = $this->getJson('/api/fitness/stats?range=4w')->assertOk();

        // Epley's error grows past ~12 reps, so these chart nothing …
        $this->assertSame([], $res->json('strength.lifts'));
        // … but they are still training volume.
        $this->assertSame(3, $res->json('kpis.hard_sets'));
    }

    public function test_a_lift_needs_three_days_before_it_is_charted(): void
    {
        $this->logSession(2, ['weight_kg' => 100, 'reps' => 5]);
        $this->logSession(1, ['weight_kg' => 105, 'reps' => 5]);

        $this->getJson('/api/fitness/stats?range=4w')
            ->assertOk()
            ->assertJsonPath('strength.lifts', []);
    }

    public function test_a_heavier_estimate_than_any_earlier_day_is_a_personal_record(): void
    {
        $this->logSession(3, ['weight_kg' => 100, 'reps' => 5]);
        $this->logSession(2, ['weight_kg' => 100, 'reps' => 5]);
        $this->logSession(1, ['weight_kg' => 110, 'reps' => 5]);

        $prs = $this->getJson('/api/fitness/stats?range=4w')->assertOk()->json('strength.recent_prs');

        // The first-ever day is not a record, and matching your own number is not
        // a record either.
        $this->assertCount(1, $prs);
        $this->assertSame(now()->subDays(1)->toDateString(), $prs[0]['date']);
        $this->assertSame(128.3, $prs[0]['e1rm_kg']);
        $this->assertSame(116.7, $prs[0]['previous_e1rm_kg']);
        $this->assertEquals(10, $prs[0]['gain_pct']);
    }

    public function test_a_personal_record_respects_history_from_before_the_window(): void
    {
        $this->logSession(200, ['weight_kg' => 150, 'reps' => 5]);   // e1RM 175
        $this->logSession(3, ['weight_kg' => 100, 'reps' => 5]);
        $this->logSession(1, ['weight_kg' => 110, 'reps' => 5]);

        $res = $this->getJson('/api/fitness/stats?range=4w')->assertOk();

        // Nothing here beat the 150kg set, so nothing in this window is a record —
        // even though it is the heaviest thing the window can see.
        $this->assertSame([], $res->json('strength.recent_prs'));
    }

    public function test_unloaded_and_warmup_sets_are_left_out_of_the_strength_panel(): void
    {
        foreach ([3, 2, 1] as $daysAgo) {
            $w = $this->makeWorkout(['started_at' => now()->subDays($daysAgo)->toDateTimeString()]);
            $this->addSet($w, ['exercise_title' => 'Pull Up', 'weight_kg' => null, 'reps' => 8]);
            $this->addSet($w, ['set_index' => 1, 'set_type' => 'warmup', 'weight_kg' => 200, 'reps' => 1]);
        }

        $res = $this->getJson('/api/fitness/stats?range=4w')->assertOk();

        // A bodyweight set has no barbell load, and a warmup single would otherwise
        // be the standing record for the lift.
        $this->assertSame([], $res->json('strength.lifts'));
        $this->assertSame([], $res->json('strength.recent_prs'));
    }

    // ── Shape and cost ───────────────────────────────────────────────────────────

    public function test_the_heatmap_grid_starts_on_a_monday(): void
    {
        $this->logSession(2);

        $from = $this->getJson('/api/fitness/stats?range=12w')->assertOk()->json('heatmap.from');

        $this->assertSame('Monday', date('l', strtotime($from)));
    }

    public function test_the_query_count_does_not_grow_with_the_number_of_workouts(): void
    {
        Exercise::create(['name' => 'Bench Press', 'primary_muscle' => 'Chest']);
        for ($i = 1; $i <= 20; $i++) {
            $this->logSession($i, ['weight_kg' => 100 + $i, 'reps' => 5]);
        }

        $queries = 0;
        DB::listen(function () use (&$queries) {
            $queries++;
        });

        $this->getJson('/api/fitness/stats?range=12w')->assertOk();

        // Six aggregates. This is the test that stops a refactor quietly
        // reintroducing a per-workout fetch.
        $this->assertLessThanOrEqual(8, $queries, "Expected ~6 aggregate queries, ran {$queries}.");
    }
}
