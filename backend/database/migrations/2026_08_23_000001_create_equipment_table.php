<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        // "equipment" is uncountable, so the table keeps the singular spelling and
        // the Equipment model pins $table explicitly rather than trusting the
        // inflector.
        Schema::create('equipment', function (Blueprint $table) {
            $table->id();
            // Multi-user-ready: user_id nullable for the single-user phase, populated
            // once routes move onto auth:sanctum. Same shape as exercises.
            $table->foreignId('user_id')->nullable()->constrained()->cascadeOnDelete();
            $table->string('name');
            $table->string('equipment_type');
            // Relative path on the 'local' disk. Images are streamed back through
            // the API rather than the web root — see EquipmentController::image().
            $table->string('image_path')->nullable();
            $table->string('status')->default('active');
            $table->text('notes')->nullable();
            $table->timestamps();

            // Unique per owner, like exercises. Exercises reference equipment by
            // name, so duplicate names would make that link ambiguous.
            $table->unique(['user_id', 'name']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('equipment');
    }
};
