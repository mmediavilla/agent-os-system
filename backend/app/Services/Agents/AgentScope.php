<?php

namespace App\Services\Agents;

use App\Agent\CapabilityGroup;
use App\Agent\ToolRegistry;
use App\Models\Agent;
use Illuminate\Support\Collection;

/**
 * The one place agent rows become (a) the registry the model is offered and
 * (b) what the prompt says about agents — `FactWriter`'s rule, because the two
 * halves are one invariant: a prompt that says the Fitness coach is off beside a
 * registry still holding `log_workout` is the switch lying in one direction or
 * the other. So both are read off the same rows, loaded once per runner.
 *
 * **Applied only where the model chooses among tools**: the typed loop
 * (`RunAgentTurn`), the spoken loop and MCP (`AgentServiceProvider`). Never by
 * rebinding the `ToolRegistry` singleton, because `AutomationRunner` calls
 * `list_events`, `get_fitness_stats` and `list_deadlines` itself to assemble a
 * greeting — that is the app calling its own tools, and switching the Secretary
 * off must not turn a morning greeting into `Unknown tool: list_events`.
 *
 * **Deciding a parked write stays unscoped** too (`AgentActionController`
 * resolves the full-registry runner): a write proposed while its agent was on
 * must still be approvable or declinable after it goes off, the Anthropic
 * switch's rule — a conversation must never be stranded on a card.
 *
 * **A group is withheld when no enabled agent owns it, unless it has no rule
 * and nobody claims it.** A group some agent owns and every owner is off is
 * that agent's switch. A group with a rule and no owner at all — `news` once the
 * News desk became an agent the owner made (19.4, the owner's call) — is withheld too,
 * because a rule only reaches the prompt on an enabled owner's line: offered
 * unowned, its tools would arrive with no rule, and nothing on Agents would
 * switch them off. Making an agent that owns it is how it is turned on, and the
 * prompt says so. A group with no rule and no owner rides along — `machine`
 * today, which already has `LOCAL_ACTIONS_ENABLED` — because a switch nobody
 * made cannot be off. One enabled owner is enough to keep a group shared by two
 * agents.
 */
final class AgentScope
{
    /** @param  Collection<int, Agent>  $agents */
    private function __construct(private readonly Collection $agents) {}

    /** One read of the table, oldest row first, so the prompt's order is stable. */
    public static function load(): self
    {
        return new self(Agent::query()->orderBy('id')->get());
    }

    /** @param  iterable<Agent>  $agents  for tests and the probe, which build states that are not on disk */
    public static function of(iterable $agents): self
    {
        return new self(collect($agents)->values());
    }

    /**
     * The given registry cut down to what the enabled agents allow.
     *
     * Takes the registry rather than resolving one, so each caller keeps its
     * own starting point — read-only for voice, without local tools for an
     * automation's run — and this only ever removes.
     */
    public function registry(ToolRegistry $tools): ToolRegistry
    {
        return $tools->forGroups($this->offered());
    }

    /** @return list<CapabilityGroup> every ownable group the model may be offered */
    public function offered(): array
    {
        $withheld = $this->withheld();

        return array_values(array_filter(
            CapabilityGroup::ownables(),
            fn (CapabilityGroup $group) => ! in_array($group, $withheld, true),
        ));
    }

    /** @return list<CapabilityGroup> groups no enabled agent owns that some agent claims or that carry a rule */
    public function withheld(): array
    {
        $on = $this->agents->filter(fn (Agent $a) => $a->enabled)->flatMap(fn (Agent $a) => $a->groups())->all();

        return array_values(array_filter(
            CapabilityGroup::ownables(),
            fn (CapabilityGroup $group) => ! in_array($group, $on, true)
                && ($this->claimed($group) || $group->guardrail() !== null),
        ));
    }

    /** @return list<CapabilityGroup> withheld groups that no agent, on or off, owns */
    public function unowned(): array
    {
        return array_values(array_filter($this->withheld(), fn (CapabilityGroup $g) => ! $this->claimed($g)));
    }

    private function claimed(CapabilityGroup $group): bool
    {
        return $this->agents->contains(fn (Agent $a) => in_array($group, $a->groups(), true));
    }

    /**
     * What the prompt says about agents: who is on and what they are for, then
     * who is off and what that took away. Empty when there is nothing to say.
     *
     * The off-sentence is **derived from the disabled rows**, the way the gated
     * list is derived from the registry — never a hardcoded list — and names an
     * agent only for the groups it actually took away. Without it, "why doesn't
     * it know about my training?" is indistinguishable from a bug.
     *
     * It also says why `Instructions::TOOLS` may name a tool the model was not
     * given: that paragraph is shared verbatim with MCP hosts and is not edited
     * per caller, so it keeps describing the whole catalog.
     */
    public function instructions(): string
    {
        $paragraphs = [];

        $on = $this->agents
            ->filter(fn (Agent $a) => $a->enabled && $a->groups() !== [])
            ->map(function (Agent $a): string {
                $line = "- {$a->name} (".self::list($a->groups()).'): '.trim((string) $a->purpose);

                return $a->guardrail() === null ? $line : $line.' '.$a->guardrail();
            });

        if ($on->isNotEmpty()) {
            $paragraphs[] = "The user has set up agents, each a kind of work you do for them, with what they want\n"
                ."from it in their own words. Hold to each one's terms when doing its kind of work:\n"
                .$on->join("\n");
        }

        $withheld = $this->withheld();

        $off = $this->agents
            ->filter(fn (Agent $a) => ! $a->enabled)
            ->map(fn (Agent $a) => [$a->name, array_values(array_filter($a->groups(), fn ($g) => in_array($g, $withheld, true)))])
            ->filter(fn (array $pair) => $pair[1] !== [])
            ->map(fn (array $pair) => "{$pair[0]} (".self::list($pair[1]).')');

        if ($off->isNotEmpty()) {
            $names = $off->join(', ', ' and ');

            $paragraphs[] = <<<TEXT
            Some of the user's agents are switched off, and while they are, their tools are not
            offered to you: {$names}.
            Where the notes below name a tool you have not been given, this is why. If a question
            needs one of them, say that the agent is switched off and can be switched on in
            Assistant → Agents — do not answer it from memory and do not guess.
            TEXT;
        }

        $unowned = $this->unowned();

        if ($unowned !== []) {
            $groups = self::list($unowned);

            $paragraphs[] = <<<TEXT
            No agent of the user's does {$groups}, so its tools are not offered to you either. If a
            question needs it, say that an agent owning it can be made in Assistant → Agents — do
            not answer it from memory and do not guess.
            TEXT;
        }

        return implode("\n\n", $paragraphs);
    }

    /** @param  list<CapabilityGroup>  $groups */
    private static function list(array $groups): string
    {
        return collect($groups)->map(fn (CapabilityGroup $g) => $g->label())->join(', ', ' and ');
    }
}
