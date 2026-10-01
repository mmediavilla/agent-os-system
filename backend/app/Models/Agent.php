<?php

namespace App\Models;

use App\Agent\CapabilityGroup;
use App\Models\Concerns\BelongsToOwner;
use Illuminate\Database\Eloquent\Model;

/**
 * A kind of work the assistant does, as a row: a name, a purpose in the owner's
 * words, the capability groups it owns, and a switch. Switched off, its groups'
 * tools are not offered to the model at all — see `Services\Agents\AgentScope`,
 * the one place rows become a registry and a prompt.
 *
 * Named `Agent` rather than `AssistantAgent` (17.1): the model sits in
 * `App\Models`, so it collides with nothing in the `App\Agent` namespace, and
 * the screen, the route and the table all say "agents". The cost is a reader
 * taking `AgentRun` for a run *of* one of these — it is a run of the assistant
 * loop, which predates this table.
 */
class Agent extends Model
{
    use BelongsToOwner;

    public const FITNESS_COACH = 'fitness_coach';

    public const SECRETARY = 'secretary';

    /**
     * Retired (19.4): the News desk is the owner's own agent. Only the 19.1
     * migration that seeded it and the one that unmade it still name this key.
     */
    public const NEWS_DESK = 'news_desk';

    /**
     * `system_key` is not here: a row created through the API is never a seeded
     * one, so no request can make a row built in, or unmake one. Nor is
     * `custom_guardrail` — it is written only through `rewordGuardrail()`, which
     * is what makes a blank one mean the default.
     */
    protected $fillable = [
        'user_id',
        'name',
        'purpose',
        'capabilities',
        'enabled',
    ];

    protected $casts = [
        'capabilities' => 'array',
        'enabled' => 'boolean',
    ];

    /**
     * The groups this row owns, as the enum.
     *
     * Unknown values and `core` are dropped rather than thrown on: a hand-edited
     * row, or a group renamed after rows stored it, must cost that one claim and
     * not fail a turn. `core` is dropped because no agent may own it — a row
     * claiming it would otherwise make the weather look switchable.
     *
     * @return list<CapabilityGroup>
     */
    public function groups(): array
    {
        $groups = [];

        foreach ((array) $this->capabilities as $value) {
            $group = is_string($value) ? CapabilityGroup::tryFrom($value) : null;

            if ($group !== null && $group->ownable() && ! in_array($group, $groups, true)) {
                $groups[] = $group;
            }
        }

        return $groups;
    }

    /**
     * What this agent is held to: the owner's rewording if there is one, else
     * the default for what it owns. Composed *with* the purpose, never instead
     * of it — the purpose says what the work is for, this says what it must
     * never pretend to be.
     */
    public function guardrail(): ?string
    {
        return $this->custom_guardrail ?? $this->defaultGuardrail();
    }

    /**
     * Store the owner's rewording — or none, when there is nothing to store.
     *
     * Blank puts the default back (the owner's call): a guardrail can be reworded but
     * never deleted by leaving a field empty. Text identical to the default is
     * stored as none too, so an agent that was only ever shown its default keeps
     * following its groups rather than freezing today's wording. Call it after
     * the groups are set, since the default is read off them.
     */
    public function rewordGuardrail(?string $text): void
    {
        $text = trim((string) $text);

        $this->custom_guardrail = $text === '' || $text === $this->defaultGuardrail() ? null : $text;
    }

    /**
     * The code's default: the guardrail of each group this agent owns, in the
     * enum's order, or null when none of them has one — see
     * {@see CapabilityGroup::guardrail()}.
     */
    public function defaultGuardrail(): ?string
    {
        $owned = $this->groups();
        $rules = [];

        foreach (CapabilityGroup::cases() as $group) {
            if (in_array($group, $owned, true) && $group->guardrail() !== null) {
                $rules[] = $group->guardrail();
            }
        }

        return $rules === [] ? null : implode(' ', $rules);
    }
}
