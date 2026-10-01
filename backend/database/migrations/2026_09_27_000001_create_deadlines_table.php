<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Deadlines (16.2): a date somebody must act on — renew the visa, file the
 * return, pay the premium.
 *
 * **Not a calendar event.** The calendar is read-only and lives in iCloud; a
 * deadline is a thing this app tracks and can be told is done. Neither row
 * belongs in the other's table.
 *
 * **`document_id` is nullable and survives its document.** "File taxes by 15
 * April" has no document at all, and deleting a policy leaves its renewal date
 * standing — the way deleting equipment leaves the label on an exercise.
 * Losing the date because the file went is the worse failure, so the key is
 * `nullOnDelete`, never a cascade.
 *
 * **Completion is a timestamp, not a delete.** "When did I last renew this" is
 * the question a tracker exists to answer, and a deleted row cannot answer it.
 * A recurring obligation is a new row; there is no recurrence language here,
 * for the reason automations have no condition language.
 *
 * `due_on` is a bare date, like a document's: a visa expires on a day, not at
 * an instant, and the calendar epic's rule about a stray `Z` applies.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('deadlines', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->constrained()->cascadeOnDelete();

            $table->string('title', 160);
            $table->date('due_on');
            $table->string('kind', 40);

            $table->foreignId('document_id')->nullable()->constrained()->nullOnDelete();
            $table->text('notes')->nullable();

            $table->timestamp('completed_at')->nullable();

            $table->timestamps();

            // The two ways every reader asks: what is still open, soonest
            // first — the overlay, the tool and an automation's fetch alike.
            $table->index(['completed_at', 'due_on']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('deadlines');
    }
};
