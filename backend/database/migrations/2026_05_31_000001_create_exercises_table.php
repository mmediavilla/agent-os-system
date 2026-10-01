<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('exercises', function (Blueprint $table) {
            $table->id();
            // Multi-user-ready: user_id nullable for the single-user phase, populated
            // once routes move onto auth:sanctum.
            $table->foreignId('user_id')->nullable()->constrained()->cascadeOnDelete();
            $table->string('name');
            $table->string('primary_muscle');
            $table->string('equipment')->nullable();
            $table->string('exercise_type')->default('weight_reps');
            $table->text('notes')->nullable();
            $table->timestamps();

            // Names are unique per owner, not globally, so two users can each have
            // their own "Incline Bench Press". Note SQLite/MySQL treat NULLs as
            // distinct in unique indexes, so while user_id is null this constraint
            // does not bite — ExerciseController's validation is the active guard.
            $table->unique(['user_id', 'name']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('exercises');
    }
};
