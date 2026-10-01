<?php

use App\Services\Owner;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Defuse Landmine 3: give the owner a name and write it on every row.
 *
 * Six tables have carried a nullable `user_id` since each was created, and every
 * row in all six held null. `Owner` has the full argument for why that was worse
 * than it looked; the short version is that null made the two unique indexes
 * inert, and that the day `ownerId()` started returning a real id the database
 * would have been silently cut in two.
 *
 * The order here is the whole of the correctness: resolve the owner, stamp the
 * rows, *then* tighten the columns. Tightening first would fail on the rows it
 * exists to protect.
 */
return new class extends Migration
{
    /**
     * Every table with an owner. Ordered as they were created, which is also
     * parent-before-child, so a rebuild never rewrites a table another one is
     * mid-flight against.
     */
    private const OWNED = ['workouts', 'insights', 'exercises', 'equipment', 'conversations', 'events'];

    public function up(): void
    {
        // The database underneath this process is new — in the suite, literally
        // rebuilt — so a memoised id from before it existed would be a stale
        // answer to the only question this migration asks.
        Owner::forget();

        $owner = Owner::id();

        foreach (self::OWNED as $table) {
            DB::table($table)->whereNull('user_id')->update(['user_id' => $owner]);
        }

        // Now that no row can be null, say so in the schema. This is what makes
        // the backfill permanent rather than a state the app has to keep
        // restoring: a writer that forgets an owner from here on fails loudly at
        // the insert instead of quietly adding another orphan.
        //
        // On SQLite a column change is a table rebuild, which is why this runs
        // last and on its own.
        foreach (self::OWNED as $table) {
            Schema::table($table, function (Blueprint $t) {
                $t->foreignId('user_id')->nullable(false)->change();
            });
        }
    }

    /**
     * Relax the columns again, and **leave the ids where they are.**
     *
     * Re-nulling them would be the tidier-looking inverse and it would recreate
     * the landmine on a database somebody is halfway through rolling back: the
     * ids are correct information about who owns what, they cost nothing to keep,
     * and `up()` would only have to write them again.
     */
    public function down(): void
    {
        foreach (self::OWNED as $table) {
            Schema::table($table, function (Blueprint $t) {
                $t->foreignId('user_id')->nullable()->change();
            });
        }
    }
};
