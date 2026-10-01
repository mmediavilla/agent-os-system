<?php

namespace Tests\Feature\Settings;

use App\Jobs\GenerateProactiveInsights;
use App\Models\Insight;
use App\Models\Setting;
use App\Models\WorkoutSet;
use App\Services\ClaudeService;
use App\Services\Fitness\ProactiveTriggers;
use App\Services\FitnessSettings;
use Illuminate\Console\Scheduling\Schedule;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Schema;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

/**
 * Fitness → Settings' server half: whether, when and about what the morning
 * nudge speaks. Asserted where it takes effect — the schedule, the job and the
 * console check — as well as at the routes, because a setting the worker never
 * reads is decoration.
 */
class FitnessSettingsTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        config([
            'agent.proactive.enabled' => true,
            'agent.proactive.time' => '07:00',
            'agent.timezone' => 'Asia/Manila',
            'services.anthropic.key' => 'test-key',
        ]);
    }

    private function logSession(int $daysAgo): void
    {
        $workout = $this->makeWorkout(['started_at' => now()->subDays($daysAgo)->toDateTimeString()]);

        WorkoutSet::create([
            'workout_id' => $workout->id,
            'exercise_title' => 'Bench Press',
            'set_index' => 0,
            'set_type' => 'normal',
            'weight_kg' => 100,
            'reps' => 5,
        ]);
    }

    /** The nudge's event, as `schedule:run` would build it now. */
    private function nudgeEvent()
    {
        // `withSchedule` hooks in when Artisan starts, and the schedule is a
        // singleton: start Artisan, then throw the old schedule away so the
        // callback builds it again from the settings as they are now.
        Artisan::all();
        $this->app->forgetInstance(Schedule::class);

        return collect(app(Schedule::class)->events())
            ->first(fn ($e) => $e->description === 'proactive-insights');
    }

    // ── The routes ────────────────────────────────────────────────────────────

    #[Test]
    public function env_answers_until_someone_chooses(): void
    {
        $this->getJson('/api/settings/fitness')
            ->assertOk()
            ->assertExactJson([
                'nudges' => [
                    'enabled' => true,
                    'time' => '07:00',
                    'triggers' => ProactiveTriggers::KEYS,
                    'timezone' => 'Asia/Manila',
                ],
                'calculations' => ['e1rm_formula' => 'epley', 'week_start' => 'monday'],
            ]);

        config(['agent.proactive.enabled' => false, 'agent.proactive.time' => '06:30']);

        $this->getJson('/api/settings/fitness')
            ->assertJsonPath('nudges.enabled', false)
            ->assertJsonPath('nudges.time', '06:30');
    }

    #[Test]
    public function a_patch_writes_only_what_it_names_and_answers_the_whole_state(): void
    {
        $this->patchJson('/api/settings/fitness', ['nudges' => ['time' => '05:45']])
            ->assertOk()
            ->assertJsonPath('nudges.time', '05:45')
            ->assertJsonPath('nudges.enabled', true)
            ->assertJsonPath('nudges.triggers', ProactiveTriggers::KEYS);

        $this->assertNull(Setting::find(FitnessSettings::NUDGES_ENABLED));

        // A row, once written, beats `.env`.
        config(['agent.proactive.time' => '09:00']);
        $this->getJson('/api/settings/fitness')->assertJsonPath('nudges.time', '05:45');
    }

    #[Test]
    public function triggers_are_stored_in_priority_order_and_an_empty_list_is_a_choice(): void
    {
        $this->patchJson('/api/settings/fitness', ['nudges' => ['triggers' => ['muscle_gap', 'layoff']]])
            ->assertOk()
            ->assertJsonPath('nudges.triggers', ['layoff', 'muscle_gap']);

        $this->patchJson('/api/settings/fitness', ['nudges' => ['triggers' => []]])
            ->assertOk()
            ->assertJsonPath('nudges.triggers', []);
    }

    #[Test]
    public function values_outside_their_closed_sets_are_refused(): void
    {
        foreach ([
            ['nudges' => ['time' => '7:00']],
            ['nudges' => ['time' => '24:00']],
            ['nudges' => ['enabled' => 'sometimes']],
            ['nudges' => ['triggers' => ['birthday']]],
            ['nudges' => ['triggers' => ['layoff', 'layoff']]],
            ['nudges' => ['colour' => 'red']],
            ['calculations' => ['e1rm_formula' => 'lombardi']],
            ['calculations' => ['week_start' => 'saturday']],
            ['calculations' => ['colour' => 'red']],
            [],
        ] as $body) {
            $this->patchJson('/api/settings/fitness', $body)->assertUnprocessable();
        }

        $this->assertSame(0, Setting::count());
    }

    #[Test]
    public function calculations_are_patched_on_their_own_and_reach_the_stats(): void
    {
        $this->patchJson('/api/settings/fitness', ['calculations' => ['week_start' => 'sunday']])
            ->assertOk()
            ->assertJsonPath('calculations', ['e1rm_formula' => 'epley', 'week_start' => 'sunday'])
            ->assertJsonPath('nudges.time', '07:00');

        $this->assertNull(Setting::find(FitnessSettings::E1RM_FORMULA));

        $this->patchJson('/api/settings/fitness', ['calculations' => ['e1rm_formula' => 'brzycki']])
            ->assertJsonPath('calculations.e1rm_formula', 'brzycki')
            ->assertJsonPath('calculations.week_start', 'sunday');

        $this->getJson('/api/fitness/stats')->assertJsonPath('settings', [
            'e1rm_formula' => 'brzycki',
            'week_start' => 'sunday',
        ]);

        // A hand-edited row that is not in the set reads as the default.
        Setting::put(FitnessSettings::E1RM_FORMULA, 'lombardi');
        $this->assertSame('epley', FitnessSettings::e1rmFormula());
    }

    #[Test]
    public function a_stored_value_that_no_longer_fits_falls_back(): void
    {
        Setting::put(FitnessSettings::NUDGES_TIME, 'breakfast');
        Setting::put(FitnessSettings::NUDGES_TRIGGERS, ['new_pr', 'renamed_since']);

        $this->assertSame('07:00', FitnessSettings::nudgeTime());
        $this->assertSame(['new_pr'], FitnessSettings::nudgeTriggers());
    }

    // ── Where they take effect ────────────────────────────────────────────────

    #[Test]
    public function the_schedule_runs_at_the_chosen_time_on_the_users_clock(): void
    {
        $this->assertSame('0 7 * * *', $this->nudgeEvent()->expression);

        FitnessSettings::updateNudges(['time' => '05:45']);

        $event = $this->nudgeEvent();
        $this->assertSame('45 5 * * *', $event->expression);
        $this->assertSame('Asia/Manila', $event->timezone);
    }

    #[Test]
    public function the_schedule_skips_the_job_when_nudges_are_switched_off(): void
    {
        $this->assertTrue($this->nudgeEvent()->filtersPass($this->app));

        FitnessSettings::updateNudges(['enabled' => false]);

        $this->assertFalse($this->nudgeEvent()->filtersPass($this->app));
    }

    #[Test]
    public function an_unmigrated_settings_table_leaves_the_schedule_on_env(): void
    {
        Schema::drop('settings');
        config(['agent.proactive.time' => '06:15']);

        $event = $this->nudgeEvent();

        $this->assertSame('15 6 * * *', $event->expression);
        $this->assertTrue($event->filtersPass($this->app));
    }

    #[Test]
    public function a_switched_off_trigger_is_never_paid_for(): void
    {
        $this->logSession(10); // fires `layoff`, and only that
        FitnessSettings::updateNudges(['triggers' => ['volume_drop', 'new_pr', 'muscle_gap']]);
        $this->mock(ClaudeService::class)->shouldNotReceive('complete');

        GenerateProactiveInsights::dispatchSync();

        $this->assertSame(0, Insight::count());
    }

    #[Test]
    public function the_console_check_says_what_is_switched_off(): void
    {
        $this->logSession(10);
        FitnessSettings::updateNudges(['enabled' => false, 'triggers' => []]);

        $this->artisan('proactive:check')
            ->expectsOutputToContain('switched off in Fitness')
            ->expectsOutputToContain('Firing but switched off: layoff.')
            ->expectsOutputToContain('Nothing fires')
            ->assertSuccessful();
    }

    #[Test]
    public function the_trigger_keys_are_the_ones_check_can_return(): void
    {
        $source = file_get_contents(app_path('Services/Fitness/ProactiveTriggers.php'));
        preg_match_all("/'key' => '([a-z_]+)'/", $source, $m);

        $this->assertSame(ProactiveTriggers::KEYS, $m[1]);
    }
}
