<?php

namespace App\Services;

use App\Models\User;
use Illuminate\Support\Str;

/**
 * Who owns the data in this single-user app.
 *
 * The app has always had exactly one owner. What it did not have was a *name*
 * for him: every `user_id` in every owned table was null, and null is a poor way
 * to write down "the owner" for two independent reasons.
 *
 * **A database does not treat null as a value.** `exercises.unique(user_id,
 * name)` and `equipment.unique(user_id, name)` have existed since those tables
 * did and enforced nothing whatsoever, because SQL counts each null as distinct
 * from every other null — so the indexes were inert and the only thing standing
 * between the catalog and two rows called "Bench Press" was the `Rule::unique`
 * validator, which the CSV import does not go through. Naming the owner is what
 * switches those two constraints on for the first time.
 *
 * **And null is a value that changes meaning the day auth lands.** `ownerId()`
 * read `$request->user()?->id`, so moving the routes onto `auth:sanctum` would
 * have stamped every *new* row with a real id while all 173 existing ones stayed
 * null: one database, silently cut in two, with nothing anywhere reporting it.
 * That was Landmine 3, and the reason it was written down as "the backfill must
 * ship in the same PR as the auth flip" is that the flip is what made the
 * backfill urgent — not what made it possible.
 *
 * Naming the owner now unpicks that coupling, which is the whole point of doing
 * it here rather than there. The rows are stamped, the columns are `not null`,
 * and a later Sanctum flip authenticates *this* user and moves no data at all.
 * The migration cannot be forgotten, because it has already run.
 *
 * **The owner is resolved without a request, and that is the load-bearing
 * part.** Three of the nine places that write an owned row have no HTTP request
 * in scope at all — the 07:00 proactive job, the agent's `save_insight`, and
 * `WorkoutWriter` under the queue — so on those paths `$request->user()?->id`
 * was not merely null, it was unreachable. An owner readable only off a request
 * could never have stamped them, which is why six of the nine wrote no owner
 * whatsoever and why the fix could not have been "turn Sanctum on".
 *
 * **The account cannot be logged into.** It is created with a random 64-character
 * password that is hashed and then dropped on the floor, so nothing knows it and
 * no reset flow exists to recover it. That is deliberate: this row is a name for
 * the owner of some rows, not a credential, and a well-known default password on
 * an account that owns the entire database would be a worse landmine than the one
 * being defused. Whoever flips Sanctum on sets a password then, as part of that
 * work.
 */
final class Owner
{
    /** What the owner row is called on a checkout that has no `users` row yet. */
    public const NAME = 'Owner';

    /**
     * A `.local` address, so it is unroutable by construction — nothing should
     * ever try to mail the owner of a single-user app running behind Herd-only
     * DNS, and an address that cannot receive mail says so out loud.
     */
    public const EMAIL = 'owner@projectmc.local';

    /**
     * Memoised because it is read on every write of every owned row and can
     * never change within a process. `forget()` is what keeps that honest in the
     * suite, where the database is rebuilt underneath a long-lived PHP process.
     */
    private static ?int $id = null;

    /** The owner's id, creating the row if this database has no users at all. */
    public static function id(): int
    {
        return self::$id ??= self::user()->id;
    }

    /**
     * The owner row itself.
     *
     * **The lowest id wins**, rather than a lookup on `self::EMAIL`. The owner is
     * whoever was here first, which is true of a database this migration created
     * *and* of one that already had a real account in it before any of this ran —
     * where matching on a made-up address would have quietly created a second
     * user and handed him every row.
     *
     * It creates rather than throwing on an empty table, because the migration
     * has already put the row there and the only way to reach this branch is a
     * `users` table that was emptied by hand. A single-user app that answers 500
     * on every write until someone re-inserts a row is worse than one that puts
     * the row back.
     */
    public static function user(): User
    {
        return User::orderBy('id')->first() ?? User::create([
            'name' => self::NAME,
            'email' => self::EMAIL,
            // Hashed by the model's `password` cast, and never recorded anywhere.
            'password' => Str::random(64),
        ]);
    }

    /** Drop the memoised id. For the suite, which rebuilds the database. */
    public static function forget(): void
    {
        self::$id = null;
    }
}
