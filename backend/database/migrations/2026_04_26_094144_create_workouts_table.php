<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('workouts', function (Blueprint $table) {
            $table->id();
            // Multi-user-ready: user_id nullable for the single-user phase, populated
            // automatically once Sanctum auth is enforced on the routes.
            $table->foreignId('user_id')->nullable()->constrained()->cascadeOnDelete();
            $table->date('performed_on');               // calendar day of the workout
            $table->string('type');                     // e.g. "Upper body", "Run", "Yoga"
            $table->unsignedSmallInteger('duration_minutes');
            $table->string('intensity')->nullable();    // "low" | "moderate" | "high"
            $table->text('notes')->nullable();
            $table->timestamps();

            $table->index(['user_id', 'performed_on']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('workouts');
    }
};
