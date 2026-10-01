<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * One frame from the camera, on its way to the model.
 *
 * The bytes are *not* here. They go to the private disk beside the equipment
 * photos, for the reason that decided that one and one more that only applies
 * here: a base64 JPEG in `conversation_messages.content` would be re-read by
 * every client that opens the thread and re-sent to the API on every turn of
 * every subsequent loop. The transcript holds a reference; this row says which
 * file, and MessageCodec puts the bytes back only for the turns that still
 * warrant carrying them.
 *
 * `conversation_id` cascades, but the *files* do not — a foreign key knows
 * nothing about the disk — so Snapshot's `deleting` hook is what removes them
 * and Conversation deletes its snapshots through the model rather than letting
 * the database do it silently.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('snapshots', function (Blueprint $table) {
            $table->id();
            $table->foreignId('conversation_id')->constrained()->cascadeOnDelete();

            $table->string('path');
            $table->string('media_type', 40);
            $table->unsignedInteger('bytes');
            $table->unsignedSmallInteger('width')->nullable();
            $table->unsignedSmallInteger('height')->nullable();

            $table->timestamps();

            // The daily ceiling counts rows in a window, and nothing else ever
            // reads this table by date.
            $table->index('created_at');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('snapshots');
    }
};
