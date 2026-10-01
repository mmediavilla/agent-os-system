<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Every tool call the assistant has made: the confirmation gate and the audit
 * log, in one table.
 *
 * Two jobs, because they need the same row. The gate needs somewhere to park a
 * write the user has not approved yet — the loop suspends across an HTTP
 * request, so a generator or an in-memory queue cannot hold it. The audit log
 * needs "what has the assistant changed to my data" to be answerable without
 * parsing transcripts:
 *
 *     where requires_confirmation and status = 'approved'
 *
 * Reads are recorded too, and not only for completeness: their results have to
 * survive the same suspension. When one turn calls three tools and one of them
 * writes, the two reads have already run, and their output has nowhere else to
 * live until the write is decided and all three `tool_result` blocks go back in
 * a single user message.
 *
 * `requires_confirmation` is stored rather than re-derived from the tool name,
 * so the log keeps saying what was true when the call happened even if a tool
 * later changes side.
 *
 * `tool_use_id` is unique, which is what makes approving twice impossible to
 * turn into a double write: the second decision finds a row that is no longer
 * pending and does nothing.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('agent_actions', function (Blueprint $table) {
            $table->id();
            $table->foreignId('conversation_id')->constrained()->cascadeOnDelete();
            // The assistant turn that asked for it. Nullable only because the
            // column is a convenience for gathering one turn's calls; the rows
            // are created in block order, so `id` is the ordering.
            $table->foreignId('conversation_message_id')->nullable()->constrained()->cascadeOnDelete();
            $table->string('tool_use_id')->unique();
            $table->string('tool');
            $table->json('input');
            $table->boolean('requires_confirmation')->default(false);
            $table->string('status')->default('pending');   // pending | approved | rejected
            $table->longText('result')->nullable();         // the encoded tool_result content
            $table->boolean('is_error')->default(false);
            $table->timestamp('decided_at')->nullable();
            $table->timestamps();

            // "Is this conversation waiting on me?" — the query every request
            // to the agent surface runs before it does anything else.
            $table->index(['conversation_id', 'status']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('agent_actions');
    }
};
