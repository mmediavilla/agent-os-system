<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('insights', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->nullable()->constrained()->cascadeOnDelete();
            $table->string('domain');           // 'fitness' | 'travel' | 'budget' | 'habits'
            $table->string('kind');             // 'weekly_assessment' | 'spending_review' | etc.
            $table->string('title');            // human-readable card title
            $table->longText('response');       // Claude's text output
            $table->json('input_summary')->nullable();   // what we sent (for debugging/replay)
            $table->json('usage')->nullable();           // tokens used
            $table->string('model')->nullable();
            $table->timestamps();

            $table->index(['domain', 'created_at']);
            $table->index(['user_id', 'domain', 'created_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('insights');
    }
};
