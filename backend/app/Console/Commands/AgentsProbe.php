<?php

namespace App\Console\Commands;

use App\Agent\CapabilityGroup;
use App\Agent\ToolRegistry;
use App\Models\Agent;
use App\Providers\AgentServiceProvider;
use App\Services\Agents\AgentScope;
use Illuminate\Console\Command;

/**
 * What the agents' switches do to what the model is offered — free, no model
 * call, `facts:probe`'s spirit without its bill.
 *
 * The switch is proven by what the model is *offered*, not by what it says, so
 * this prints the tools each caller would hand over and the prompt's agents
 * paragraph. `--off` and `--on` try a state without writing it, so "what would
 * switching the Secretary off take away?" is answered before anyone does it.
 */
class AgentsProbe extends Command
{
    protected $signature = 'agents:probe
        {--off=* : Treat this agent as switched off (name or system key; repeatable) — nothing is written}
        {--on=* : Treat this agent as switched on, likewise}';

    protected $description = 'Print the tools and prompt the agents produce, as configured or as tried (free — no model call)';

    public function handle(ToolRegistry $tools): int
    {
        $agents = Agent::query()->orderBy('id')->get();
        $tried = $this->apply($agents->all());

        if ($tried === null) {
            return self::FAILURE;
        }

        $scope = AgentScope::of($agents);

        $this->line('<options=bold>── Agents ──</>'.($tried ? ' (as tried — nothing written)' : ''));
        $this->table(
            ['Agent', 'State', 'Owns', 'Guardrails from'],
            $agents->map(fn (Agent $a) => [
                $a->name,
                $a->enabled ? 'on' : 'off',
                collect($a->groups())->map(fn (CapabilityGroup $g) => $g->value)->join(', ') ?: '—',
                $a->custom_guardrail !== null
                    ? 'reworded by the owner'
                    : (collect($a->groups())->filter(fn (CapabilityGroup $g) => $g->guardrail() !== null)->map(fn (CapabilityGroup $g) => $g->value)->join(', ') ?: '—'),
            ])->all(),
        );

        $withheld = $scope->withheld();
        $this->line('Withheld: '.($withheld === [] ? 'nothing' : collect($withheld)->map(fn ($g) => $g->value)->join(', ')));
        $this->newLine();

        // Typed and MCP start from the same registry; voice from its own.
        $this->section('Typed chat and MCP', $scope->registry($tools), $tools);
        $this->section('Voice', $scope->registry(AgentServiceProvider::voiceTools(app())), AgentServiceProvider::voiceTools(app()));

        $this->line('<options=bold>── Agents paragraph of the prompt ──</>');
        $this->newLine();
        $this->line($scope->instructions() ?: '(none — nothing is on or off to speak of)');

        return self::SUCCESS;
    }

    /**
     * Flip the named rows in memory.
     *
     * @param  list<Agent>  $agents
     * @return bool|null whether anything was tried, or null on an unknown name
     */
    private function apply(array $agents): ?bool
    {
        $tried = false;

        foreach (['off' => false, 'on' => true] as $option => $state) {
            foreach ((array) $this->option($option) as $name) {
                $agent = collect($agents)->first(fn (Agent $a) => strcasecmp($a->name, $name) === 0 || $a->system_key === $name);

                if (! $agent) {
                    $this->error("No agent is called \"{$name}\".");

                    return null;
                }

                $agent->enabled = $state;   // in memory only; never saved
                $tried = true;
            }
        }

        return $tried;
    }

    private function section(string $label, ToolRegistry $offered, ToolRegistry $whole): void
    {
        $gone = array_diff(array_keys($whole->all()), array_keys($offered->all()));

        $this->line("<options=bold>── {$label} ──</> ".count($offered->all()).' of '.count($whole->all()).' tools');
        $this->line('  offered:  '.(implode(', ', array_keys($offered->all())) ?: '—'));
        $this->line('  withheld: '.(implode(', ', $gone) ?: '—'));
        $this->newLine();
    }
}
