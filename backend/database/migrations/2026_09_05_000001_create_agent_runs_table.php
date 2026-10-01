<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * One queued trip through the tool loop.
 *
 * Until now a message *was* the loop: `POST /messages` ran every tool the model
 * asked for and answered when it was done, which for a question needing two or
 * three of them is fifteen to twenty seconds behind a spinner. This table is
 * what lets that request return immediately instead — it hands back a run id,
 * the work happens in a queued job, and the client watches.
 *
 * The row is deliberately thin: **it holds the position of the work, never the
 * work itself.** Everything the loop produces still lands where it already did —
 * turns in `conversation_messages`, tool calls in `agent_actions` — so a client
 * that misses every event still gets the whole truth by re-reading the
 * conversation, and nothing here has to be kept in step with it.
 *
 * `id` is a uuid rather than an auto-increment because the run routes carry no
 * token (see routes/api.php): a sequential id would let anyone on this machine
 * read the next conversation's stream by adding one.
 *
 * The terminal statuses are the ones `RunOutcome` already defines, plus
 * `failed`, which is the case a synchronous call used to report as a 502 and
 * now has nowhere else to live.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('agent_runs', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->foreignId('conversation_id')->constrained()->cascadeOnDelete();

            // What asked for this run. `message` starts from a user turn;
            // `resume` picks the loop up after the last parked write was
            // decided. Stored because the two fail in different ways and a log
            // that cannot tell them apart is hard to read.
            $table->string('trigger');

            // queued | running | awaiting_confirmation | completed |
            // max_iterations | failed
            $table->string('status')->default('queued');

            // Only ever set alongside `failed`. The message the user is shown,
            // which is why it is stored rather than derived from an exception
            // that no longer exists by the time anyone looks.
            $table->text('error')->nullable();

            $table->timestamp('started_at')->nullable();
            $table->timestamp('finished_at')->nullable();
            $table->timestamps();

            // "Is this conversation already busy?" — asked before every send,
            // because two loops appending to one transcript interleave their
            // turns and produce a request the API refuses.
            $table->index(['conversation_id', 'status']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('agent_runs');
    }
};
