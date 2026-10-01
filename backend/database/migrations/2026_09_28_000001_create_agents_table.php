<?php

use App\Agent\CapabilityGroup;
use App\Models\Agent;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Agents (17.1): rows that each own some of the code's capability groups. An
 * agent switched off takes its groups' tools out of what the model is offered —
 * see `Services\Agents\AgentScope`.
 *
 * `capabilities` stores `CapabilityGroup` values as strings, never `core`.
 * `system_key` marks a seeded row; a created row has none. (Guardrails were
 * keyed on it until they moved onto the groups — `CapabilityGroup::guardrail()`.)
 *
 * **Both seeded rows are switched on**, unlike the Morning greeting. An
 * automation off adds nothing; an agent off takes tools away, so seeding these
 * off would have been the migration switching the assistant's training log and
 * calendars off on the day it ran (the owner's call, 17.1).
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('agents', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->constrained()->cascadeOnDelete();

            $table->string('name', 120);
            $table->text('purpose');           // the owner's words — goes into the prompt
            $table->json('capabilities');      // subset of CapabilityGroup::ownables()
            $table->string('system_key', 40)->nullable()->unique();
            $table->boolean('enabled')->default(false);

            $table->timestamps();
        });

        (new Agent)->forceFill([
            'name' => 'Fitness coach',
            'purpose' => 'Keep track of my training — what I did, how it is trending, and what I should do next.',
            'capabilities' => [CapabilityGroup::Fitness->value],
            'system_key' => Agent::FITNESS_COACH,
            'enabled' => true,
        ])->save();

        (new Agent)->forceFill([
            'name' => 'Secretary',
            'purpose' => 'Keep my calendar, my documents and the dates I must act on in order, and tell me what is coming up.',
            'capabilities' => [
                CapabilityGroup::Calendar->value,
                CapabilityGroup::Documents->value,
                CapabilityGroup::Deadlines->value,
            ],
            'system_key' => Agent::SECRETARY,
            'enabled' => true,
        ])->save();
    }

    public function down(): void
    {
        Schema::dropIfExists('agents');
    }
};
