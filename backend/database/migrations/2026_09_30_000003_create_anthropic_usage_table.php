<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * A ledger of what each paid Anthropic call used — one row a call.
 *
 * Assistant → Activity priced its spend off `conversation_messages.usage` and
 * `insights.usage`, and a deleted thread takes its messages with it. Measured
 * on 2026-09-30: the tab said $0.84 for the month, the console $2.83, and the
 * difference was threads deleted in the first week. Spend is a fact about the
 * account, not about a thread, so it is kept where nothing cascades to it.
 *
 * **No foreign key and no `user_id`, on purpose.** A row says a call was paid
 * for; which thread or insight it belonged to is what the `usage` columns on
 * those tables are still for. Pointing a row at a thread would be the cascade
 * again.
 *
 * **Four integer columns, not the `usage` json**: the only reader sums them
 * behind a ranged `created_at`, and a column needs no `json_extract`.
 *
 * **Backfilled from what survives**, so the month does not restart at zero on
 * the day this runs. What was already deleted is gone; the console has it.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('anthropic_usage', function (Blueprint $table) {
            $table->id();
            $table->string('model')->nullable();
            $table->unsignedBigInteger('input_tokens')->default(0);
            $table->unsignedBigInteger('output_tokens')->default(0);
            $table->unsignedBigInteger('cache_read_tokens')->default(0);
            $table->unsignedBigInteger('cache_write_tokens')->default(0);
            // Written once and never edited, so there is no `updated_at`.
            $table->timestamp('created_at')->index();
        });

        foreach (['conversation_messages', 'insights'] as $source) {
            DB::statement(<<<SQL
                insert into anthropic_usage (model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, created_at)
                select model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, created_at
                from (
                    select
                        model,
                        coalesce(json_extract(usage, '$.input_tokens'), 0) as input_tokens,
                        coalesce(json_extract(usage, '$.output_tokens'), 0) as output_tokens,
                        coalesce(json_extract(usage, '$.cache_read_input_tokens'), 0) as cache_read_tokens,
                        coalesce(json_extract(usage, '$.cache_creation_input_tokens'), 0) as cache_write_tokens,
                        created_at
                    from {$source}
                    where usage is not null and created_at is not null
                ) as recorded
                where input_tokens + output_tokens + cache_read_tokens + cache_write_tokens > 0
                SQL);
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('anthropic_usage');
    }
};
