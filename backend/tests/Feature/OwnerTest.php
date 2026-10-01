<?php

namespace Tests\Feature;

use App\Models\CalendarFeed;
use App\Models\Conversation;
use App\Models\Equipment;
use App\Models\Exercise;
use App\Models\Insight;
use App\Models\User;
use App\Models\Workout;
use App\Services\Owner;
use Illuminate\Database\QueryException;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Tests\TestCase;

/**
 * Landmine 3, defused.
 *
 * `Owner` carries the argument; these are the properties it has to keep. The
 * ones that matter are the two that used to be false: every owned row has an
 * owner, and the database is the thing enforcing it.
 */
class OwnerTest extends TestCase
{
    use RefreshDatabase;

    /** Every table the backfill covers, and a minimal row for each. */
    private function owned(): array
    {
        return [
            'workouts' => fn () => Workout::create(['title' => 'Push', 'started_at' => '2026-09-09 10:00:00']),
            'insights' => fn () => Insight::create([
                'domain' => 'fitness', 'kind' => 'weekly_assessment',
                'title' => 'Weekly', 'response' => 'Good.',
            ]),
            'exercises' => fn () => Exercise::create(['name' => 'Bench Press', 'primary_muscle' => 'Chest']),
            'equipment' => fn () => Equipment::create(['name' => 'Barbell', 'equipment_type' => 'Free weights']),
            'conversations' => fn () => Conversation::create(['title' => 'Thread']),
            'calendar_feeds' => fn () => CalendarFeed::create([
                'url' => 'https://calendar.google.com/calendar/ical/me/private-x/basic.ics',
                'color' => 'peacock',
            ]),
        ];
    }

    public function test_the_migration_leaves_exactly_one_owner_on_a_fresh_database(): void
    {
        $this->assertSame(1, User::count());
        $this->assertSame(Owner::EMAIL, Owner::user()->email);
        $this->assertSame(Owner::id(), User::orderBy('id')->value('id'));
    }

    public function test_the_owner_account_cannot_be_logged_into(): void
    {
        // A well-known password on the account that owns every row would be a
        // worse landmine than the one being defused, so the password is random
        // and nothing anywhere records it.
        foreach (['', 'password', 'owner', Owner::NAME, Owner::EMAIL, 'secret'] as $guess) {
            $this->assertFalse(Hash::check($guess, Owner::user()->password), "guessable: '{$guess}'");
        }
    }

    public function test_every_owned_model_stamps_the_owner_without_being_asked(): void
    {
        foreach ($this->owned() as $table => $make) {
            $this->assertSame(Owner::id(), $make()->user_id, "{$table} did not stamp an owner");
        }
    }

    public function test_no_owned_table_will_accept_a_row_with_no_owner(): void
    {
        // Every other not-null column filled in, so the only thing left to refuse
        // the row is `user_id`. The schema is what makes the backfill permanent: a
        // writer that forgets an owner from here on fails at the insert instead of
        // quietly adding another orphan for a future auth flip to lose.
        $rows = [
            'workouts' => ['title' => 'Orphan', 'started_at' => '2026-09-09 10:00:00'],
            'insights' => ['domain' => 'fitness', 'kind' => 'weekly_assessment', 'title' => 'Orphan', 'response' => '.'],
            'exercises' => ['name' => 'Orphan', 'primary_muscle' => 'Chest'],
            'equipment' => ['name' => 'Orphan', 'equipment_type' => 'Free weights'],
            'conversations' => ['title' => 'Orphan'],
            'calendar_feeds' => ['url' => 'x', 'url_hash' => str_repeat('0', 64), 'color' => 'peacock'],
        ];

        $this->assertSame(array_keys($this->owned()), array_keys($rows), 'a table is missing from this check');

        foreach ($rows as $table => $row) {
            try {
                DB::table($table)->insert($row + ['user_id' => null]);
                $this->fail("{$table} accepted a null user_id");
            } catch (QueryException $e) {
                $this->assertStringContainsString('NOT NULL', $e->getMessage(), $table);
            }
        }
    }

    public function test_an_explicitly_set_owner_is_respected(): void
    {
        // `??=`, not an overwrite: the default is a default, and a multi-user path
        // later needs somewhere to put its own answer.
        $other = User::create(['name' => 'Other', 'email' => 'other@example.test', 'password' => 'x']);

        $this->assertSame($other->id, Exercise::create([
            'user_id' => $other->id,
            'name' => 'Front Squat',
            'primary_muscle' => 'Quads',
        ])->user_id);
    }

    public function test_the_owner_scoped_unique_indexes_are_now_enforced_by_the_database(): void
    {
        // These two indexes existed from the day their tables did and constrained
        // nothing, because SQL counts each null as distinct inside a unique index.
        // Naming the owner is what switched them on.
        Exercise::create(['name' => 'Bench Press', 'primary_muscle' => 'Chest']);
        Equipment::create(['name' => 'Barbell', 'equipment_type' => 'Free weights']);

        foreach ([
            'exercises' => ['name' => 'Bench Press', 'primary_muscle' => 'Chest'],
            'equipment' => ['name' => 'Barbell', 'equipment_type' => 'Free weights'],
        ] as $table => $row) {
            try {
                // Straight through the query builder: no model, no validator, so
                // what refuses this is the index and nothing else.
                DB::table($table)->insert($row + ['user_id' => Owner::id()]);
                $this->fail("{$table} accepted a duplicate name for one owner");
            } catch (QueryException $e) {
                $this->assertStringContainsString('UNIQUE', $e->getMessage());
            }
        }
    }

    public function test_the_same_name_is_still_allowed_for_a_different_owner(): void
    {
        Exercise::create(['name' => 'Bench Press', 'primary_muscle' => 'Chest']);

        $other = User::create(['name' => 'Other', 'email' => 'other@example.test', 'password' => 'x']);

        // Per owner, not global — which is why FitnessStatsService still dedupes
        // the catalog by name before joining on it.
        $this->assertNotNull(Exercise::create([
            'user_id' => $other->id,
            'name' => 'Bench Press',
            'primary_muscle' => 'Chest',
        ])->id);
    }

    public function test_the_owner_is_resolvable_with_no_request_in_scope(): void
    {
        // The load-bearing property. Three writers run with no HTTP request at all
        // — the 07:00 nudge, `save_insight`, and WorkoutWriter under the queue — so
        // an owner readable only off `$request->user()` could never stamp them.
        Owner::forget();

        $this->assertSame(User::orderBy('id')->value('id'), Owner::id());
    }

    public function test_the_owner_row_is_recreated_if_the_users_table_is_emptied(): void
    {
        // Reachable only by hand, and answering 500 on every write until somebody
        // re-inserts a row is worse than putting the row back.
        DB::table('users')->delete();
        Owner::forget();

        $this->assertSame(Owner::id(), User::orderBy('id')->value('id'));
        $this->assertSame(1, User::count());
    }
}
