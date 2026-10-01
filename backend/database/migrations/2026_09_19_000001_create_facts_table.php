<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * What the assistant knows about the owner: short claims, one per key.
 *
 * **One live claim per key, and the history is kept.** A new value for a key
 * already active supersedes the old row rather than overwriting it, so "when did
 * I start taking it black?" still has an answer. A plain `unique(user_id,
 * category, key)` would forbid keeping the old row at all; the rule only holds
 * among `active` rows, so it is a partial index, which the schema builder cannot
 * express and SQLite can.
 *
 * **`rejected` is a tombstone, not a delete.** The extractor (15.2) reads it so
 * that a fact the owner already refused is not proposed again every evening.
 *
 * `conversation_id` is where a fact was learned. Deleting the thread keeps the
 * fact: what was learned outlives the conversation it came up in, as a workout
 * logged through the assistant outlives its thread.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('facts', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->constrained()->cascadeOnDelete();

            // Free text, like `equipment_type`: the categories are whatever the
            // owner's life turns out to have in it.
            $table->string('category', 60);
            $table->string('key', 120);
            $table->text('value');

            $table->string('confidence', 16);   // stated | inferred
            $table->string('source', 16);       // chat | voice | manual | extracted
            $table->string('status', 16);       // proposed | active | superseded | rejected

            $table->foreignId('conversation_id')->nullable()->constrained()->nullOnDelete();

            $table->timestamp('learned_at');
            $table->timestamp('decided_at')->nullable();
            $table->timestamps();

            // The prompt block reads active facts newest first; the review queue
            // reads proposed ones the same way.
            $table->index(['status', 'learned_at']);
        });

        DB::statement(
            "CREATE UNIQUE INDEX facts_one_active_per_key ON facts (user_id, category, key) WHERE status = 'active'"
        );
    }

    public function down(): void
    {
        Schema::dropIfExists('facts');
    }
};
