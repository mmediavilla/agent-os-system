<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * The Google calendars this app reads, one secret iCal address each.
 *
 * `url` is **encrypted at rest**. A secret address is a bearer credential —
 * anyone holding it reads the whole calendar, forever, with no login — so it is
 * stored the way a password would be if this app kept any, and it is never
 * served back out: not by the list, not by the calendar read.
 *
 * Encryption is also why `url_hash` exists. The ciphertext is different on
 * every write, so a unique index on it constrains nothing; the sha256 of the
 * plain address is stable and is what "that calendar is already added" checks.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('calendar_feeds', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->constrained()->cascadeOnDelete();
            $table->text('url');
            $table->char('url_hash', 64);

            // From the feed's X-WR-CALNAME when it is added, and editable after.
            // Nullable because a feed may not carry one.
            $table->string('name')->nullable();

            // One of Google's own eleven colour names — the feed carries the
            // calendar's name but not its colour, so the user picks it again.
            $table->string('color', 20);

            $table->boolean('enabled')->default(true);
            $table->timestamps();

            $table->unique(['user_id', 'url_hash']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('calendar_feeds');
    }
};
