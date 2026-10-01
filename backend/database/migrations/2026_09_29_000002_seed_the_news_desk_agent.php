<?php

use App\Agent\CapabilityGroup;
use App\Models\Agent;
use Illuminate\Database\Migrations\Migration;

/**
 * The News desk (19.1): a third seeded agent, owning the `news` group.
 *
 * **Switched on** (the owner's call), for the seeded agents' reason: an agent off takes
 * tools away, so seeding it off would ship `get_news` unreachable.
 *
 * Seeded rather than left for the owner to make, because the seeded row is what
 * keeps the News guardrail in the prompt: a group nobody owns is still offered,
 * but its rule only reaches the prompt on an enabled owner's line. Its groups
 * are fixed and it cannot be deleted, as `system_key` already arranges.
 * `custom_guardrail` stays null, so it follows `CapabilityGroup::News`' rule.
 *
 * Superseded in 19.4: `2026_09_30_000002` makes the row the owner's own agent,
 * and `AgentScope` withholds a guarded group nobody owns instead.
 */
return new class extends Migration
{
    public function up(): void
    {
        if (Agent::query()->where('system_key', Agent::NEWS_DESK)->exists()) {
            return;
        }

        (new Agent)->forceFill([
            'name' => 'News desk',
            'purpose' => 'Brief me on local news and my interests. Local first. Skip what I\'ve already been told. Five items max.',
            'capabilities' => [CapabilityGroup::News->value],
            'system_key' => Agent::NEWS_DESK,
            'enabled' => true,
        ])->save();
    }

    public function down(): void
    {
        Agent::query()->where('system_key', Agent::NEWS_DESK)->delete();
    }
};
