<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * The app's own calendar goes.
 *
 * 7.3b built `events` because the app had no calendar and no auth to reach one
 * with. Phase 10 reads the user's Google calendars through their secret iCal
 * addresses instead, and the owner makes events in Google Calendar itself — so this
 * table would be a second calendar nobody writes to, and an agenda that merged
 * the two would be showing one of them empty forever. It held no rows when it
 * was dropped.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::dropIfExists('events');
    }

    /**
     * The table as it stood just before this ran — `user_id` not null, since
     * the owner backfill had already tightened it. Recreating the 7.3b shape
     * instead would hand the owner migration's own `down()` a column it
     * expects to be relaxing.
     */
    public function down(): void
    {
        Schema::create('events', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->constrained()->cascadeOnDelete();
            $table->string('title');
            $table->dateTime('starts_at');
            $table->dateTime('ends_at')->nullable();
            $table->boolean('all_day')->default(false);
            $table->string('location')->nullable();
            $table->text('notes')->nullable();
            $table->timestamps();

            $table->index(['user_id', 'starts_at']);
        });
    }
};
