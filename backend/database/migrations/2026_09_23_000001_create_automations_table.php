<?php

use App\Models\Automation;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Scheduled conversations (15.3): rows the HUD opens once their hour has come,
 * never a cron tick — see `AutomationController::due()`.
 *
 * `time` is a plain 'HH:MM' string on `agent.timezone`, compared lexically
 * against the caller's own wall clock rather than parsed — which is what lets
 * "past its time" and "not run today" each be one cheap `where`.
 *
 * `last_run_on` is the once-a-day guard, claimed with a conditional `update`
 * the way `AgentAction::decide()` claims a pending write, so two tabs open at
 * once cannot both fire the same greeting.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('automations', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->constrained()->cascadeOnDelete();

            $table->string('name', 120);
            $table->string('time', 5);   // 'HH:MM' on agent.timezone
            $table->text('intent');      // what it is for, in the owner's words — never sent raw
            $table->json('context');     // subset of: agenda, weather, training, facts
            $table->boolean('enabled')->default(true);

            $table->date('last_run_on')->nullable();
            $table->timestamp('last_run_at')->nullable();
            $table->string('last_outcome', 16)->nullable();   // ok | failed | skipped
            $table->text('last_error')->nullable();
            $table->foreignId('last_conversation_id')->nullable()
                ->constrained('conversations')->nullOnDelete();

            $table->timestamps();
        });

        // Row one, off until the owner turns it on from the Automations overlay.
        Automation::create([
            'name' => 'Morning greeting',
            'time' => '06:30',
            'intent' => 'Give the user a short, friendly good-morning greeting for the day ahead.',
            'context' => ['agenda', 'weather', 'training'],
            'enabled' => false,
        ]);
    }

    public function down(): void
    {
        Schema::dropIfExists('automations');
    }
};
