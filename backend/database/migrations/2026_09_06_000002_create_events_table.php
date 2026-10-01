<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * The calendar this app owns.
 *
 * 7.2 deleted the HUD's agenda panel because the four appointments in it were
 * hand-typed and there was nothing behind them. The two candidates for putting
 * something behind it were an external calendar over OAuth and a table here;
 * this is the table. The deciding argument was that the app has no auth at all
 * yet, so an OAuth client, a consent callback and a refresh-token store would
 * be the first credential system in the codebase, built for one panel.
 *
 * `starts_at` and `ends_at` are **wall-clock, not instants** — see the model
 * for why, and for why nothing here is a `timestamp`.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('events', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->nullable()->constrained()->cascadeOnDelete();
            $table->string('title');
            $table->dateTime('starts_at');
            // Null is a moment rather than a span — "call the dentist", not "the
            // dentist, 15:00 to 15:45". A panel with room for one line each is
            // the main consumer, so most rows will legitimately have no end.
            $table->dateTime('ends_at')->nullable();
            $table->boolean('all_day')->default(false);
            $table->string('location')->nullable();
            $table->text('notes')->nullable();
            $table->timestamps();

            // Every read of this table is a window on the calendar ordered by
            // when things happen, which is exactly this index.
            $table->index(['user_id', 'starts_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('events');
    }
};
