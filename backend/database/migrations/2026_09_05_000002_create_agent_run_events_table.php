<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * What a run did, in order, so a client can watch it happen.
 *
 * The queued job and the request serving the stream are **different
 * processes**, which is the whole reason this table exists. There is no shared
 * memory between them and no Redis in this app, so the job appends rows here
 * and the streaming request tails them. SSE and polling are then the same thing
 * twice — one relays this log as it grows, the other asks for the tail of it —
 * which is what makes the native client (no `EventSource`, no readable fetch
 * body) cost nothing extra on the server.
 *
 * `seq` is per-run and monotonic, and it is the resume token: a browser
 * reconnecting an `EventSource` sends `Last-Event-ID`, and a poller sends
 * `?after=`. Both mean "everything after this", and both are answered by the
 * same index. An auto-increment `id` would nearly work and is wrong the moment
 * two runs interleave, which is normal — the ids of one run's events are not
 * contiguous.
 *
 * These rows are a **presentation** of the run, never its record. Text deltas
 * are duplicated into `conversation_messages` when the turn is persisted and
 * tool calls into `agent_actions`, so this table can be pruned, missed or
 * replayed out of order without losing anything. That is deliberate: a client
 * that drops the connection re-reads the conversation and is whole again.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('agent_run_events', function (Blueprint $table) {
            $table->id();
            $table->foreignUuid('agent_run_id')->constrained('agent_runs')->cascadeOnDelete();
            $table->unsignedInteger('seq');

            // run.started | thinking | text | tool.started | tool.finished |
            // awaiting | run.finished — see RunJournal, which is the only
            // writer.
            $table->string('type');
            $table->json('data')->nullable();
            $table->timestamp('created_at')->nullable();

            // Both the ordering and the resume lookup. Unique because a
            // duplicated seq would make "everything after N" ambiguous, and a
            // client would either skip a delta or replay one.
            $table->unique(['agent_run_id', 'seq']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('agent_run_events');
    }
};
