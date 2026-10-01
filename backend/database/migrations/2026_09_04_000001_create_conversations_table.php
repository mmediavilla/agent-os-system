<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * One thread of conversation with the assistant.
 *
 * Deliberately thin: the transcript lives in `conversation_messages` and the
 * audit trail in `agent_actions`, so this row exists to give both something
 * stable to hang off and to give a client a list to render without reading a
 * single message.
 *
 * `last_message_at` is denormalised rather than derived. Ordering a
 * conversation list by "most recently active" is the only query a sidebar makes,
 * and doing it with a subquery against a table that grows without bound is the
 * one place this schema would get slow first.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('conversations', function (Blueprint $table) {
            $table->id();
            // Nullable and null on every row today, exactly like every other
            // table here: `ownerId()` reads `$request->user()?->id` and the
            // agent surface authenticates a machine, not a user. The Sanctum
            // flip owes this column a backfill along with all the others.
            $table->foreignId('user_id')->nullable()->constrained()->cascadeOnDelete();
            $table->string('title')->nullable();
            $table->timestamp('last_message_at')->nullable();
            $table->timestamps();

            $table->index(['user_id', 'last_message_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('conversations');
    }
};
