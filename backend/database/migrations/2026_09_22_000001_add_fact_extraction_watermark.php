<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * How far the fact extractor has read each conversation (15.2).
 *
 * The id of the last message it has seen, so a thread that resumes a week later
 * is read again from there and nothing is read — or paid for — twice. A plain
 * column rather than a foreign key: messages only ever go with their thread.
 *
 * **Threads that already exist start read.** Null means "nothing read yet", and
 * the scheduler treats every such thread with an idle hour behind it as due, so
 * without this the first tick after deploying would queue a paid call for every
 * conversation ever held. Old threads can still be read on purpose with
 * `php artisan facts:extract {id}`.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('conversations', function (Blueprint $table) {
            $table->unsignedBigInteger('facts_extracted_through')->nullable();
        });

        DB::statement(<<<'SQL'
            update conversations
            set facts_extracted_through = (
                select max(id) from conversation_messages m where m.conversation_id = conversations.id
            )
            SQL);
    }

    public function down(): void
    {
        Schema::table('conversations', function (Blueprint $table) {
            $table->dropColumn('facts_extracted_through');
        });
    }
};
