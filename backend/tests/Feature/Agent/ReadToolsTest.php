<?php

namespace Tests\Feature\Agent;

use App\Agent\ToolRegistry;
use App\Models\CalendarFeed;
use App\Models\Equipment;
use App\Models\Exercise;
use App\Models\Workout;
use App\Models\WorkoutSet;
use Illuminate\Database\Eloquent\ModelNotFoundException;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Http;
use Illuminate\Validation\ValidationException;
use Tests\Feature\Calendar\CalendarTest;
use Tests\TestCase;
use Tests\Unit\Calendar\IcsReaderTest;

/**
 * One test per read tool, against seeded data.
 *
 * These assert the *projection* as much as the filtering: a tool that leaks a
 * model's full attribute set costs tokens on every row of every result, and is
 * the kind of regression nothing else would notice.
 */
class ReadToolsTest extends TestCase
{
    use RefreshDatabase;

    private function tool(string $tool, array $input = []): array
    {
        return app(ToolRegistry::class)->get($tool)->handle($input);
    }

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

    // ── get_fitness_stats ─────────────────────────────────────────────────────

    public function test_fitness_stats_returns_the_dashboard_panels(): void
    {
        $w = $this->makeWorkout(['started_at' => now()->subDays(2)->toDateTimeString()]);
        $this->addSet($w);

        $result = $this->tool('get_fitness_stats', ['range' => '4w']);

        $this->assertSame('4w', $result['range']['resolved']);
        $this->assertSame(1, $result['kpis']['sessions']);
        $this->assertArrayHasKey('volume', $result);
        $this->assertArrayHasKey('muscles', $result);
        $this->assertArrayHasKey('strength', $result);
    }

    public function test_fitness_stats_drops_the_heatmap(): void
    {
        $this->addSet($this->makeWorkout());

        $this->assertArrayNotHasKey('heatmap', $this->tool('get_fitness_stats'));
    }

    public function test_fitness_stats_rejects_an_unknown_range(): void
    {
        $this->expectException(ValidationException::class);

        $this->tool('get_fitness_stats', ['range' => 'last_tuesday']);
    }

    // ── list_workouts ─────────────────────────────────────────────────────────

    public function test_list_workouts_projects_a_summary_row(): void
    {
        $w = $this->makeWorkout(['title' => 'Push Day', 'ended_at' => now()->addHour()->toDateTimeString()]);
        $this->addSet($w);
        $this->addSet($w, ['exercise_title' => 'Overhead Press', 'set_index' => 1]);

        $row = $this->tool('list_workouts')['workouts'][0];

        $this->assertSame('Push Day', $row['title']);
        $this->assertSame(2, $row['set_count']);
        $this->assertSame(2, $row['exercise_count']);
        $this->assertSame(60, $row['duration_minutes']);

        // The fields a toArray() would have leaked.
        $this->assertArrayNotHasKey('user_id', $row);
        $this->assertArrayNotHasKey('created_at', $row);
        $this->assertArrayNotHasKey('sets', $row);
    }

    public function test_list_workouts_filters_by_date_inclusively(): void
    {
        $this->addSet($this->makeWorkout(['title' => 'Old', 'started_at' => now()->subDays(10)->toDateTimeString()]));
        $this->addSet($this->makeWorkout(['title' => 'Today']));

        $result = $this->tool('list_workouts', ['from' => now()->toDateString(), 'to' => now()->toDateString()]);

        $this->assertCount(1, $result['workouts']);
        $this->assertSame('Today', $result['workouts'][0]['title']);
    }

    public function test_list_workouts_filters_by_exercise(): void
    {
        $this->addSet($this->makeWorkout(['title' => 'Push']));
        $this->addSet($this->makeWorkout(['title' => 'Legs']), ['exercise_title' => 'Squat']);

        $result = $this->tool('list_workouts', ['exercise' => 'Squat']);

        $this->assertCount(1, $result['workouts']);
        $this->assertSame('Legs', $result['workouts'][0]['title']);
    }

    public function test_list_workouts_reports_the_unlimited_total(): void
    {
        foreach (range(1, 4) as $i) {
            $this->addSet($this->makeWorkout(['started_at' => now()->subDays($i)->toDateTimeString()]));
        }

        $result = $this->tool('list_workouts', ['limit' => 2]);

        $this->assertCount(2, $result['workouts']);
        $this->assertSame(2, $result['returned']);
        $this->assertSame(4, $result['total_matching']);
    }

    public function test_list_workouts_can_attach_a_set_transcript(): void
    {
        $w = $this->makeWorkout();
        $this->addSet($w, ['weight_kg' => 100, 'reps' => 8, 'rpe' => 8]);

        $this->assertStringContainsString('Bench Press: 100kg×8@8', $this->tool('list_workouts', ['include_sets' => true])['workouts'][0]['sets']);
    }

    // ── get_workout ───────────────────────────────────────────────────────────

    public function test_get_workout_returns_a_payload_update_workout_accepts(): void
    {
        $w = $this->makeWorkout(['title' => 'Push Day']);
        $this->addSet($w, ['set_type' => 'warmup', 'weight_kg' => 60, 'reps' => 5]);
        $this->addSet($w, ['set_index' => 1, 'weight_kg' => 100, 'reps' => 8, 'rpe' => 8]);

        $result = $this->tool('get_workout', ['id' => $w->id]);

        $this->assertSame('Push Day', $result['title']);
        $this->assertCount(1, $result['exercises']);
        $this->assertSame('Bench Press', $result['exercises'][0]['exercise_title']);
        $this->assertCount(2, $result['exercises'][0]['sets']);
        $this->assertSame(
            ['set_type' => 'warmup', 'weight_kg' => 60.0, 'reps' => 5],
            $result['exercises'][0]['sets'][0],
        );

        // The round trip the description promises: hand this straight back.
        $replaced = $this->tool('update_workout', $result + ['id' => $w->id]);
        $this->assertSame(2, $replaced['set_count']);
    }

    public function test_get_workout_404s_on_a_missing_id(): void
    {
        $this->expectException(ModelNotFoundException::class);

        $this->tool('get_workout', ['id' => 999]);
    }

    // ── search_exercises ──────────────────────────────────────────────────────

    private function makeExercise(array $attrs = []): Exercise
    {
        return Exercise::create(array_merge([
            'name' => 'Bench Press',
            'primary_muscle' => 'Chest',
            'equipment' => 'Barbell',
            'exercise_type' => 'weight_reps',
        ], $attrs));
    }

    public function test_search_exercises_searches_and_filters(): void
    {
        $this->makeExercise();
        $this->makeExercise(['name' => 'Squat', 'primary_muscle' => 'Quads']);

        $this->assertCount(1, $this->tool('search_exercises', ['search' => 'bench'])['exercises']);
        $this->assertCount(1, $this->tool('search_exercises', ['primary_muscle' => 'Quads'])['exercises']);
        $this->assertCount(2, $this->tool('search_exercises')['exercises']);
    }

    public function test_search_exercises_escapes_like_wildcards(): void
    {
        $this->makeExercise(['name' => '50% Deload Bench']);
        $this->makeExercise(['name' => 'Squat']);

        // "%" as a literal, not "match anything".
        $this->assertCount(1, $this->tool('search_exercises', ['search' => '50%'])['exercises']);
    }

    public function test_search_exercises_projects_catalog_fields_only(): void
    {
        $this->makeExercise();

        $row = $this->tool('search_exercises')['exercises'][0];

        $this->assertSame(['id', 'name', 'primary_muscle', 'equipment', 'exercise_type'], array_keys($row));
    }

    // ── list_equipment ────────────────────────────────────────────────────────

    private function makeEquipment(array $attrs = []): Equipment
    {
        return Equipment::create(array_merge([
            'name' => 'Barbell',
            'equipment_type' => 'Free Weights',
            'status' => 'active',
        ], $attrs));
    }

    public function test_list_equipment_filters_by_status(): void
    {
        $this->makeEquipment();
        $this->makeEquipment(['name' => 'Cable Machine', 'status' => 'broken']);
        $this->makeEquipment(['name' => 'Sled', 'status' => 'wishlist']);

        $this->assertCount(3, $this->tool('list_equipment')['equipment']);
        $this->assertCount(1, $this->tool('list_equipment', ['status' => 'active'])['equipment']);
        $this->assertSame('Cable Machine', $this->tool('list_equipment', ['status' => 'broken'])['equipment'][0]['name']);
    }

    public function test_list_equipment_omits_the_image_url(): void
    {
        $this->makeEquipment(['image_path' => 'equipment/photo.jpg']);

        // Appended by the model and useless to a language model, so it must not
        // ride along on every row.
        $this->assertArrayNotHasKey('image_url', $this->tool('list_equipment')['equipment'][0]);
        $this->assertArrayNotHasKey('thumbnail', $this->tool('list_equipment')['equipment'][0]);
    }

    public function test_list_equipment_rejects_an_unknown_status(): void
    {
        $this->expectException(ValidationException::class);

        $this->tool('list_equipment', ['status' => 'lost']);
    }

    // ── list_events ───────────────────────────────────────────────────────────

    /** One Google calendar answering with `$body`, or with `$status` and nothing. */
    private function connect(string $name, string $body = '', int $status = 200): CalendarFeed
    {
        config(['agent.timezone' => 'Asia/Manila']);

        $feed = CalendarFeed::create([
            'url' => 'https://calendar.google.com/calendar/ical/'.strtolower($name).'/private-x/basic.ics',
            'name' => $name,
            'color' => 'peacock',
        ]);

        Http::fake(['calendar.google.com/calendar/ical/'.strtolower($name).'/*' => Http::response($body, $status)]);

        return $feed;
    }

    public function test_list_events_reads_the_google_calendars_on_the_users_clock(): void
    {
        $this->travelTo('2026-09-10 02:00:00');
        $this->connect('Personal', CalendarTest::dentist());

        $result = $this->tool('list_events');

        // Today and the six days after, where the user is.
        $this->assertSame(['from' => '2026-09-10', 'to' => '2026-09-16'], $result['window']);

        // The calendar it came from, and a wall-clock time with no Z and no
        // offset — a model shown a UTC timestamp quotes a time nobody set.
        $this->assertSame([
            'calendar' => 'Personal',
            'title' => 'Dentist',
            'starts_at' => '2026-09-10T15:00:00',
            'ends_at' => '2026-09-10T15:45:00',
        ], $result['events'][0]);

        $this->assertArrayNotHasKey('unreachable', $result);
        $this->assertArrayNotHasKey('notes', $result);
    }

    public function test_list_events_defaults_to_today_where_the_user_is_not_where_the_server_is(): void
    {
        // 17:00 UTC on the 9th is one in the morning on the 10th in Manila.
        $this->travelTo('2026-09-09 17:00:00');
        $this->connect('Personal', CalendarTest::dentist());

        $this->assertSame('2026-09-10', $this->tool('list_events')['window']['from']);
    }

    public function test_list_events_gives_all_day_events_as_dates_with_an_inclusive_last_day(): void
    {
        $this->travelTo('2026-09-10 02:00:00');
        $this->connect('Personal', IcsReaderTest::ics([
            <<<'ICS'
            UID:birthday@google.com
            DTSTART;VALUE=DATE:20260912
            DTEND;VALUE=DATE:20260913
            SUMMARY:Birthday
            ICS,
            <<<'ICS'
            UID:trip@google.com
            DTSTART;VALUE=DATE:20260914
            DTEND;VALUE=DATE:20260917
            SUMMARY:Siargao
            ICS,
        ]));

        $events = $this->tool('list_events')['events'];

        // iCalendar's end is exclusive; said as-is, a trip ending on the 16th
        // "ends on the 17th". So the last day is given, inclusively, and only
        // when there is more than one.
        $this->assertSame(['calendar' => 'Personal', 'title' => 'Birthday', 'all_day' => true, 'date' => '2026-09-12'], $events[0]);
        $this->assertSame(['calendar' => 'Personal', 'title' => 'Siargao', 'all_day' => true, 'date' => '2026-09-14', 'until' => '2026-09-16'], $events[1]);
    }

    public function test_list_events_names_an_unreachable_calendar_rather_than_reporting_a_free_week(): void
    {
        $this->travelTo('2026-09-10 02:00:00');
        $this->connect('Work', status: 503);

        $result = $this->tool('list_events');

        // An empty list and a calendar Google did not answer for, together, is
        // not a free week — the one thing the model must not say.
        $this->assertSame([], $result['events']);
        $this->assertSame([['calendar' => 'Work', 'reason' => 'The calendar answered 503.']], $result['unreachable']);
    }

    public function test_list_events_says_when_no_calendar_is_connected(): void
    {
        Http::fake();

        $result = $this->tool('list_events');

        $this->assertSame([], $result['events']);
        $this->assertStringContainsString('No calendars are connected', $result['notes'][0]);
        Http::assertNothingSent();
    }

    public function test_list_events_clamps_a_long_window_and_says_where_it_stopped(): void
    {
        $this->travelTo('2026-09-10 02:00:00');
        $this->connect('Personal', CalendarTest::dentist());

        $result = $this->tool('list_events', ['from' => '2026-09-10', 'to' => '2027-01-31']);

        $this->assertSame('2026-12-10', $result['window']['to']);
        $this->assertStringContainsString('stops at 2026-12-10', $result['notes'][0]);
    }

    public function test_list_events_rejects_an_end_before_the_start(): void
    {
        $this->expectException(ValidationException::class);

        $this->tool('list_events', ['from' => '2026-09-10', 'to' => '2026-09-01']);
    }
}
