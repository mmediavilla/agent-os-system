<?php

namespace App\Http\Controllers;

use App\Agent\CapabilityGroup;
use App\Agent\Contracts\Tool;
use App\Agent\ToolRegistry;
use App\Models\Agent;
use App\Services\Agents\AgentScope;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Arr;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;

/**
 * Assistant → Agents (17.2): the rows `AgentScope` reads, and the closed set of
 * groups they may own.
 *
 * Cheap CRUD outside `throttle:agent` — nothing here calls a model, the
 * `/api/facts` rule. A write takes effect on the next turn, because every
 * model-facing caller loads the table afresh.
 *
 * **The groups travel with the rows** (`GET` answers `groups` beside `data`),
 * labelled by `CapabilityGroup::label()` and listing the tools each one holds
 * right now, so the screen never keeps a second copy of the registry — the
 * reason `Instructions` derives its gated list rather than writing one.
 *
 * **What a seeded agent is, the code decides**: `system_key` is not fillable and
 * is never validated, so no request can make a row seeded or unmake one. A
 * seeded row's **groups are fixed** and it **cannot be deleted**, so the
 * training log and the secretary's groups are only ever switched off, never
 * lost. Its name, purpose, guardrail and switch are the owner's. Any other
 * agent — the News desk included, since 19.4 — may be deleted even when it is
 * the only owner of a group with a rule: {@see AgentScope} then withholds that
 * group, because a rule reaches the prompt only on an enabled owner's line.
 *
 * **Every agent's guardrail is editable, and blank means the default** (the owner's
 * call): the rules of the groups it owns ({@see CapabilityGroup::guardrail()}).
 * `guardrail` in a write goes through `Agent::rewordGuardrail()`, so an empty
 * one — or one identical to the default — stores nothing and keeps following
 * the groups. A row answers both `guardrail` (what it is held to) and
 * `default_guardrail`, so the card can offer Reset only when there is
 * something to reset.
 *
 * **Each group carries its default rule**, so the add card can show what an
 * agent will be held to while its groups are still being chosen.
 *
 * **A created agent is switched on unless told otherwise** — the reverse of an
 * automation, for the seeding's reason (17.1): an automation off adds nothing,
 * but an agent off *withholds* every group it alone claims, so a new row that
 * arrived off could take a tool away the moment it was saved.
 */
class AgentController extends Controller
{
    /** Present and blank is allowed, and means the default — never "no rule". */
    private const GUARDRAIL_RULES = ['guardrail' => ['sometimes', 'nullable', 'string', 'max:2000']];

    public function __construct(private readonly ToolRegistry $tools) {}

    /** GET /api/agents → { data: [...], groups: [{ value, label, guardrail, tools }] } */
    public function index(): JsonResponse
    {
        $scope = AgentScope::load();

        return response()->json([
            'data' => Agent::query()->orderBy('id')->get()->map(fn (Agent $a) => $this->present($a, $scope))->all(),
            'groups' => array_map(fn (CapabilityGroup $group) => [
                'value' => $group->value,
                'label' => $group->label(),
                'guardrail' => $group->guardrail(),
                'tools' => array_values(array_map(
                    fn (Tool $tool) => $tool->name(),
                    array_filter($this->tools->all(), fn (Tool $tool) => $tool->group() === $group),
                )),
            ], CapabilityGroup::ownables()),
        ]);
    }

    /** POST /api/agents { name, purpose, capabilities, guardrail?, enabled? } */
    public function store(Request $request): JsonResponse
    {
        $data = $request->validate([
            'name' => ['required', 'string', 'max:120'],
            'purpose' => ['required', 'string', 'max:2000'],
            ...$this->capabilityRules('required'),
            ...self::GUARDRAIL_RULES,
            'enabled' => ['sometimes', 'boolean'],
        ]);

        $agent = new Agent(Arr::except($data, 'guardrail') + ['enabled' => $data['enabled'] ?? true]);
        $agent->rewordGuardrail($data['guardrail'] ?? null);
        $agent->save();

        return response()->json($this->present($agent, AgentScope::load()), 201);
    }

    /** PATCH /api/agents/{agent} — any of the writable fields, each fully validated. */
    public function update(Request $request, Agent $agent): JsonResponse
    {
        $data = $request->validate([
            'name' => ['sometimes', 'required', 'string', 'max:120'],
            'purpose' => ['sometimes', 'required', 'string', 'max:2000'],
            ...$this->capabilityRules('sometimes', 'required'),
            ...self::GUARDRAIL_RULES,
            'enabled' => ['sometimes', 'required', 'boolean'],
        ]);

        if (array_key_exists('capabilities', $data) && $agent->system_key !== null) {
            throw ValidationException::withMessages([
                'capabilities' => "{$agent->name} is built in: what it owns is fixed, so each kind of work always has an agent holding it to its guardrail.",
            ]);
        }

        // The groups first: a blank guardrail means the default, which is read off them.
        $agent->fill(Arr::except($data, 'guardrail'));

        if (array_key_exists('guardrail', $data)) {
            $agent->rewordGuardrail($data['guardrail']);
        }

        $agent->save();

        return response()->json($this->present($agent, AgentScope::load()));
    }

    /** DELETE /api/agents/{agent} — a created row only. */
    public function destroy(Agent $agent): JsonResponse
    {
        if ($agent->system_key !== null) {
            return response()->json([
                'message' => "{$agent->name} is built in, so it can be switched off but not deleted.",
            ], 409);
        }

        $agent->delete();

        return response()->json(null, 204);
    }

    /**
     * At least one group, each an ownable one, none twice. `core` is refused
     * here rather than dropped later, so the owner is told the weather cannot be
     * switched off instead of watching the tick vanish.
     *
     * @return array<string, list<mixed>>
     */
    private function capabilityRules(string ...$presence): array
    {
        return [
            'capabilities' => [...$presence, 'array', 'min:1'],
            'capabilities.*' => ['string', 'distinct', Rule::in(array_map(fn (CapabilityGroup $g) => $g->value, CapabilityGroup::ownables()))],
        ];
    }

    /**
     * `withholds` is what this row being off takes away **right now** — its
     * groups that no enabled agent owns — read off the same `AgentScope` the
     * loop uses. Empty for a row that is on, and for one whose groups another
     * enabled agent still holds, which is how the card can say "switching this
     * off changes nothing" rather than implying it does.
     *
     * @return array<string, mixed>
     */
    private function present(Agent $agent, AgentScope $scope): array
    {
        $groups = $agent->groups();
        $withheld = $scope->withheld();

        return [
            'id' => $agent->id,
            'name' => $agent->name,
            'purpose' => $agent->purpose,
            'capabilities' => array_map(fn (CapabilityGroup $g) => $g->value, $groups),
            'enabled' => $agent->enabled,
            'seeded' => $agent->system_key !== null,
            'guardrail' => $agent->guardrail(),
            'default_guardrail' => $agent->defaultGuardrail(),
            'withholds' => $agent->enabled ? [] : array_values(array_map(
                fn (CapabilityGroup $g) => $g->value,
                array_filter($groups, fn (CapabilityGroup $g) => in_array($g, $withheld, true)),
            )),
            'created_at' => optional($agent->created_at)->toIso8601String(),
        ];
    }
}
