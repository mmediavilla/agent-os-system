<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * The transcript, stored in the shape the Messages API accepts.
 *
 * The one rule that makes rehydration work: **`content` is always a list of
 * wire-shaped content blocks, never a string.** An assistant turn is stored as
 * `json_encode($response->content)` verbatim — thinking blocks included, in
 * order — so replaying it is a straight `json_decode` and the thinking signature
 * round-trips byte-identically, which the API requires when a tool call follows
 * one. A user turn is stored the same way (`[{"type":"text",...}]`), so the
 * reader never has to branch on the shape it finds.
 *
 * `stop_reason`, `usage` and `model` are assistant-only and are kept for the
 * same reason `insights.usage` is: without them, "why did that turn stop" and
 * "what did this conversation cost" are unanswerable after the fact.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('conversation_messages', function (Blueprint $table) {
            $table->id();
            $table->foreignId('conversation_id')->constrained()->cascadeOnDelete();
            $table->string('role');                 // 'user' | 'assistant'
            $table->json('content');                // list of wire content blocks
            $table->string('stop_reason')->nullable();
            $table->string('model')->nullable();
            $table->json('usage')->nullable();
            $table->timestamps();

            // The loop reads a whole conversation in insertion order on every
            // turn, which is the only access pattern this table has.
            $table->index(['conversation_id', 'id']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('conversation_messages');
    }
};
