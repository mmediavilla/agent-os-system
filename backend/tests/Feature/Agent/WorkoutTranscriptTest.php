<?php

namespace Tests\Feature\Agent;

use App\Agent\Support\WorkoutTranscript;
use App\Models\Workout;
use App\Models\WorkoutSet;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * The rendering both the weekly insight and the agent read sessions through.
 *
 * Its exact output is what the insight prompt has always sent, so these lock the
 * format rather than merely checking it is non-empty.
 */
class WorkoutTranscriptTest extends TestCase
{
    use RefreshDatabase;

    private function addSet(Workout $w, array $attrs = []): WorkoutSet
    {
        return WorkoutSet::create(array_merge([
            'workout_id' => $w->id,
            'exercise_title' => 'Bench Press',
            'set_index' => 0,
            'set_type' => 'normal',
        ], $attrs));
    }

    public function test_a_session_renders_as_a_header_and_one_line_per_exercise(): void
    {
        $w = $this->makeWorkout([
            'title' => 'Push Day',
            'started_at' => '2026-09-01 18:00:00',
            'ended_at' => '2026-09-01 19:00:00',
        ]);
        $this->addSet($w, ['weight_kg' => 100, 'reps' => 8, 'rpe' => 8]);
        $this->addSet($w, ['exercise_title' => 'Dips', 'set_index' => 1, 'reps' => 12]);

        $this->assertSame(
            "2026-09-01: Push Day (60 min)\n  Bench Press: 100kg×8@8\n  Dips: ×12",
            WorkoutTranscript::session($w->fresh('sets')),
        );
    }

    public function test_a_session_with_no_end_time_shows_no_duration(): void
    {
        $w = $this->makeWorkout(['title' => 'Quick', 'started_at' => '2026-09-01 18:00:00']);
        $this->addSet($w, ['reps' => 5]);

        $this->assertStringStartsWith('2026-09-01: Quick', WorkoutTranscript::session($w->fresh('sets')));
        $this->assertStringNotContainsString('min', WorkoutTranscript::session($w->fresh('sets')));
    }

    public function test_sets_of_one_exercise_are_joined_on_one_line(): void
    {
        $w = $this->makeWorkout(['started_at' => '2026-09-01 18:00:00']);
        $this->addSet($w, ['set_type' => 'warmup', 'weight_kg' => 60, 'reps' => 5]);
        $this->addSet($w, ['set_index' => 1, 'weight_kg' => 100, 'reps' => 8]);

        $this->assertStringContainsString(
            'Bench Press: warmup60kg×5 | 100kg×8',
            WorkoutTranscript::session($w->fresh('sets')),
        );
    }

    public function test_cardio_sets_render_distance_and_duration(): void
    {
        $w = $this->makeWorkout(['started_at' => '2026-09-01 18:00:00']);
        $this->addSet($w, ['exercise_title' => 'Treadmill', 'distance_km' => 5, 'duration_seconds' => 1800]);

        $this->assertStringContainsString('Treadmill: 5km1800s', WorkoutTranscript::session($w->fresh('sets')));
    }

    public function test_sessions_are_separated_by_a_blank_line(): void
    {
        $a = $this->makeWorkout(['title' => 'A', 'started_at' => '2026-09-01 18:00:00']);
        $this->addSet($a, ['reps' => 5]);
        $b = $this->makeWorkout(['title' => 'B', 'started_at' => '2026-09-02 18:00:00']);
        $this->addSet($b, ['reps' => 5]);

        $rendered = WorkoutTranscript::render(Workout::with('sets')->orderBy('started_at')->get());

        $this->assertStringContainsString("×5\n\n2026-09-02: B", $rendered);
    }

    public function test_no_workouts_render_as_an_empty_string(): void
    {
        $this->assertSame('', WorkoutTranscript::render([]));
    }
}
