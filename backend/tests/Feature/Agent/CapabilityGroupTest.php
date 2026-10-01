<?php

namespace Tests\Feature\Agent;

use App\Agent\CapabilityGroup;
use App\Agent\Contracts\MutatingTool;
use App\Agent\Contracts\Tool;
use App\Agent\ToolRegistry;
use App\Agent\Tools\BaseTool;
use ReflectionClass;
use Tests\TestCase;

/**
 * Every tool names the kind of work it does (Phase 17.0).
 *
 * These pin the assignment and the filter; what switches groups off, and where
 * the filter is applied, is `AgentScopeTest`'s (17.1).
 */
class CapabilityGroupTest extends TestCase
{
    private function registry(): ToolRegistry
    {
        return app(ToolRegistry::class);
    }

    /**
     * Every tool class there is, not just the registered ones.
     *
     * `open_on_this_machine` is registered only where local actions are on and
     * `show_google_calendar` only in the voice registry, so asking the default
     * registry would leave the two optional tools unchecked — and they are the
     * two whose group matters most the day they are switched on. Read off the
     * directory so a new tool class cannot be left out of this test either.
     *
     * @return array<string, Tool> keyed by tool name
     */
    private function everyTool(): array
    {
        $tools = [];

        foreach (glob(app_path('Agent/Tools/*.php')) as $file) {
            $class = 'App\\Agent\\Tools\\'.basename($file, '.php');
            $reflection = new ReflectionClass($class);

            if ($reflection->isAbstract() || ! $reflection->implementsInterface(Tool::class)) {
                continue;
            }

            $tool = app($class);
            $tools[$tool->name()] = $tool;
        }

        ksort($tools);

        return $tools;
    }

    public function test_every_tool_class_is_in_the_group_it_was_assigned(): void
    {
        // Written out, so moving a tool between groups is a decision someone
        // makes in a diff rather than a side effect: once agents are rows,
        // regrouping a tool changes what switching an agent off takes away.
        $this->assertSame([
            'create_exercise' => CapabilityGroup::Fitness,
            'get_fitness_stats' => CapabilityGroup::Fitness,
            'get_news' => CapabilityGroup::News,
            'get_weather' => CapabilityGroup::Core,
            'get_workout' => CapabilityGroup::Fitness,
            'list_deadlines' => CapabilityGroup::Deadlines,
            'list_equipment' => CapabilityGroup::Fitness,
            'list_events' => CapabilityGroup::Calendar,
            'list_pinned_articles' => CapabilityGroup::News,
            'list_workouts' => CapabilityGroup::Fitness,
            'log_workout' => CapabilityGroup::Fitness,
            'open_on_this_machine' => CapabilityGroup::Machine,
            'pin_articles' => CapabilityGroup::News,
            'save_facts' => CapabilityGroup::Core,
            'save_insight' => CapabilityGroup::Fitness,
            'search_documents' => CapabilityGroup::Documents,
            'search_exercises' => CapabilityGroup::Fitness,
            'show_google_calendar' => CapabilityGroup::Calendar,
            'update_workout' => CapabilityGroup::Fitness,
        ], array_map(fn (Tool $tool) => $tool->group(), $this->everyTool()));
    }

    public function test_every_ownable_group_has_a_tool(): void
    {
        // A group with no tools would be a switch that turns nothing off.
        $owned = array_map(fn (Tool $tool) => $tool->group(), $this->everyTool());

        foreach (CapabilityGroup::ownables() as $group) {
            $this->assertContains($group, $owned, "{$group->value} has no tool — an agent owning it would own nothing");
        }
    }

    public function test_core_is_the_one_group_no_agent_can_own(): void
    {
        $this->assertFalse(CapabilityGroup::Core->ownable());
        $this->assertSame(
            [
                CapabilityGroup::Fitness,
                CapabilityGroup::Calendar,
                CapabilityGroup::Documents,
                CapabilityGroup::Deadlines,
                CapabilityGroup::Machine,
                CapabilityGroup::News,
            ],
            CapabilityGroup::ownables(),
        );
    }

    public function test_the_group_values_are_what_rows_will_store(): void
    {
        // Agent rows (17.1) store these strings. Renaming a case's value would
        // strand every row that names it, so the wire form is pinned.
        $this->assertSame(
            ['fitness', 'calendar', 'documents', 'deadlines', 'machine', 'core', 'news'],
            array_map(fn (CapabilityGroup $group) => $group->value, CapabilityGroup::cases()),
        );
    }

    public function test_the_group_is_declared_abstract_on_the_base_tool(): void
    {
        // Abstract, not defaulted: a default would let a new tool compile
        // without choosing, and land in whatever group the default names.
        $this->assertTrue((new ReflectionClass(BaseTool::class))->getMethod('group')->isAbstract());
    }

    // ── forGroups() ───────────────────────────────────────────────────────────

    public function test_no_groups_leaves_only_core(): void
    {
        // What a machine with every agent switched off would be offered: the
        // weather and the assistant's memory, and nothing else.
        $this->assertSame(
            ['get_weather', 'save_facts'],
            array_keys($this->registry()->forGroups([])->all()),
        );
    }

    public function test_a_group_brings_its_tools_and_core_in_registration_order(): void
    {
        // Order matters for the reason it matters on the whole registry: this
        // is a cached prefix, and a filter that reordered would be a new one
        // for nothing.
        $this->assertSame(
            ['list_events', 'get_weather', 'save_facts', 'list_deadlines'],
            array_keys($this->registry()->forGroups([CapabilityGroup::Calendar, CapabilityGroup::Deadlines])->all()),
        );
    }

    public function test_every_ownable_group_is_the_whole_catalog(): void
    {
        // The filter drops only what it is told to — every agent on is today's
        // behaviour exactly.
        $this->assertSame(
            array_keys($this->registry()->all()),
            array_keys($this->registry()->forGroups(CapabilityGroup::ownables())->all()),
        );
    }

    public function test_naming_core_changes_nothing(): void
    {
        // Core is always in; saying so again must not be a way to double it or
        // to change the order.
        $this->assertSame(
            array_keys($this->registry()->forGroups([CapabilityGroup::Fitness])->all()),
            array_keys($this->registry()->forGroups([CapabilityGroup::Fitness, CapabilityGroup::Core])->all()),
        );
    }

    public function test_it_composes_with_the_read_only_registry(): void
    {
        // The voice path in 17.1 will be both at once. Read-only first, then a
        // group: a write that one filter removes the other cannot bring back.
        $names = array_keys($this->registry()->readOnly()->forGroups([CapabilityGroup::Fitness])->all());

        $this->assertSame(
            ['get_fitness_stats', 'list_workouts', 'get_workout', 'search_exercises', 'list_equipment', 'get_weather'],
            $names,
        );

        foreach ($names as $name) {
            $this->assertNotInstanceOf(MutatingTool::class, $this->registry()->get($name));
        }
    }

    public function test_filtering_does_not_disarm_the_singleton(): void
    {
        // 17.1 must never scope by rebinding the singleton — AutomationRunner
        // calls list_events directly and would fail with the Secretary off.
        // The first line of that defence is that the filter returns a copy.
        $registry = $this->registry();
        $registry->forGroups([]);

        $this->assertTrue($registry->has('list_events'));
        $this->assertTrue($registry->has('log_workout'));
        $this->assertSame($registry, $this->registry());
    }
}
