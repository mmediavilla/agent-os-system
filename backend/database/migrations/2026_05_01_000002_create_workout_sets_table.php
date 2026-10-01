<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('workout_sets', function (Blueprint $table) {
            $table->id();
            $table->foreignId('workout_id')->constrained()->cascadeOnDelete();
            $table->string('exercise_title');
            $table->string('superset_id')->nullable();
            $table->text('exercise_notes')->nullable();
            $table->unsignedSmallInteger('set_index');
            $table->string('set_type')->default('normal');
            $table->decimal('weight_kg', 8, 2)->nullable();
            $table->unsignedSmallInteger('reps')->nullable();
            $table->decimal('distance_km', 8, 3)->nullable();
            $table->unsignedInteger('duration_seconds')->nullable();
            $table->decimal('rpe', 3, 1)->nullable();
            $table->timestamps();

            $table->index('workout_id');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('workout_sets');
    }
};
