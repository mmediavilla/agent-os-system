<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * A place for a turn to say something about how it was created, without
 * touching what it says.
 *
 * The one user so far (15.3): an automation's assembled first turn is stamped
 * `{"automation_id": n}` so `TranscriptPresenter` can leave it out of what the
 * owner reads — the assembled prompt is scaffolding built from the agenda, the
 * weather and the week's training, never something anyone typed — while
 * `MessageCodec` still sends it to the model untouched, exactly like any other
 * turn.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('conversation_messages', function (Blueprint $table) {
            $table->json('meta')->nullable();
        });
    }

    public function down(): void
    {
        Schema::table('conversation_messages', function (Blueprint $table) {
            $table->dropColumn('meta');
        });
    }
};
