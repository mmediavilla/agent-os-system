<?php

use App\Models\Agent;
use Illuminate\Database\Migrations\Migration;

/**
 * The News desk is the owner's own agent, not a built-in one (19.4, the owner's call).
 *
 * The row 19.1 seeded is kept — its name, purpose, switch and any rewording are
 * the owner's — and only its `system_key` goes, which is all that made it
 * built in: its groups become editable and it can be deleted.
 *
 * Seeding it was meant to keep the news rule in the prompt, since a rule only
 * reaches the prompt on an enabled owner's line. `AgentScope` now withholds a
 * group that has a rule and no owner at all, so deleting the News desk takes
 * `get_news` and the reading list away with it rather than leaving them
 * offered with no rule.
 */
return new class extends Migration
{
    public function up(): void
    {
        Agent::query()->where('system_key', Agent::NEWS_DESK)->update(['system_key' => null]);
    }

    /** Built in again — only if the row is still there and still owns nothing but the news. */
    public function down(): void
    {
        $row = Agent::query()->whereNull('system_key')->where('name', 'News desk')->orderBy('id')->first();

        if ($row !== null && $row->capabilities === ['news']) {
            $row->forceFill(['system_key' => Agent::NEWS_DESK])->save();
        }
    }
};
