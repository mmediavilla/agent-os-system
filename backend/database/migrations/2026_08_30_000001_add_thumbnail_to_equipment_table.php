<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('equipment', function (Blueprint $table) {
            // Which of the drawn illustrations this item shows when it has no
            // photo. Null means "whichever one the name and category imply" —
            // the behaviour every row had before this column existed, and the
            // reason it is nullable rather than defaulting to a drawing: a
            // stored default would freeze the pick at insert time and stop a
            // rename from moving the item onto a better one.
            //
            // The value is an art key from app/src/equipmentArt.ts, not a path:
            // nothing is stored on disk, so this can never be mistaken for an
            // uploaded photo (image_path stays null) and needs no cleanup on
            // delete.
            $table->string('thumbnail')->nullable()->after('image_path');
        });
    }

    public function down(): void
    {
        Schema::table('equipment', function (Blueprint $table) {
            $table->dropColumn('thumbnail');
        });
    }
};
