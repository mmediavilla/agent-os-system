<?php

namespace Tests\Feature\Agent;

use App\Agent\Contracts\MutatingTool;
use App\Agent\Contracts\Tool;
use App\Agent\ToolRegistry;
use App\Agent\Tools\BaseTool;
use App\Agent\Tools\GetFitnessStats;
use App\Services\ExerciseWriter;
use App\Services\WorkoutWriter;
use Illuminate\Foundation\Testing\RefreshDatabase;
use InvalidArgumentException;
use Tests\TestCase;

/**
 * Contract tests over the whole registry.
 *
 * These are what catch a broken tool before it costs an API call: a schema the
 * model cannot satisfy, or a write tool that skipped the marker and would
 * therefore skip the confirmation gate.
 */
class ToolRegistryTest extends TestCase
{
    use RefreshDatabase;

    private function registry(): ToolRegistry
    {
        return app(ToolRegistry::class);
    }

    /** @return list<Tool> */
    private function tools(): array
    {
        return array_values($this->registry()->all());
    }

    public function test_registry_is_a_singleton(): void
    {
        $this->assertSame($this->registry(), $this->registry());
    }

    public function test_every_v1_tool_is_registered_in_a_fixed_order(): void
    {
        // Order is asserted, not just membership: these definitions are the bulk
        // of the cached prompt prefix, so a reshuffle is a real cost regression.
        $this->assertSame([
            'get_fitness_stats',
            'list_workouts',
            'get_workout',
            'search_exercises',
            'list_equipment',
            'log_workout',
            'update_workout',
            'create_exercise',
            'save_insight',
            'list_events',
            'get_weather',
            'save_facts',
            'search_documents',
            'list_deadlines',
            'get_news',
            'pin_articles',
            'list_pinned_articles',
        ], array_keys($this->registry()->all()));
    }

    public function test_the_read_only_registry_is_the_reads_in_the_same_order(): void
    {
        // What the voice path is handed. Order is asserted here for the same
        // reason it is above — this is a second cached prefix, not a subset of
        // the first one — and membership is asserted as a list because the
        // point is that a write tool is *absent*, not filtered later.
        $this->assertSame([
            'get_fitness_stats',
            'list_workouts',
            'get_workout',
            'search_exercises',
            'list_equipment',
            'list_events',
            'get_weather',
            'search_documents',
            'list_deadlines',
            'get_news',
            'list_pinned_articles',
        ], array_keys($this->registry()->readOnly()->all()));
    }

    public function test_nothing_in_the_read_only_registry_can_write(): void
    {
        // The membership test above would still pass if a new write tool were
        // added and quietly named like a read; this one is the rule.
        foreach ($this->registry()->readOnly()->all() as $tool) {
            $this->assertNotInstanceOf(MutatingTool::class, $tool);
        }
    }

    public function test_asking_for_the_reads_does_not_disarm_the_singleton(): void
    {
        $registry = $this->registry();
        $registry->readOnly();

        // A filter that mutated the shared registry would take the writes away
        // from the typed path too, the first time anybody spoke.
        $this->assertTrue($registry->has('log_workout'));
        $this->assertSame($registry, $this->registry());
    }

    public function test_names_are_unique_and_snake_case(): void
    {
        $names = array_map(fn (Tool $t) => $t->name(), $this->tools());

        $this->assertSame($names, array_unique($names));

        foreach ($names as $name) {
            $this->assertMatchesRegularExpression('/^[a-z][a-z0-9_]*$/', $name);
        }
    }

    public function test_registering_a_duplicate_name_throws(): void
    {
        $registry = new ToolRegistry([app(GetFitnessStats::class)]);

        $this->expectException(InvalidArgumentException::class);
        $registry->register(app(GetFitnessStats::class));
    }

    public function test_unknown_tool_throws(): void
    {
        $this->expectException(InvalidArgumentException::class);
        $this->registry()->get('no_such_tool');
    }

    public function test_descriptions_are_substantial(): void
    {
        foreach ($this->tools() as $tool) {
            // The bar is low on purpose: this catches an empty or stub
            // description, not a merely mediocre one.
            $this->assertGreaterThan(
                80,
                strlen($tool->description()),
                "{$tool->name()} needs a description that says when to reach for it",
            );
        }
    }

    public function test_schemas_are_well_formed_objects(): void
    {
        foreach ($this->tools() as $tool) {
            $schema = $tool->schema();

            $this->assertSame($tool->name(), $schema['name']);
            $this->assertSame($tool->description(), $schema['description']);

            $input = $schema['input_schema'];
            $this->assertSame('object', $input['type']);
            $this->assertIsArray($input['properties']);
            $this->assertNotEmpty($input['properties'], "{$tool->name()} declares no parameters");
        }
    }

    public function test_every_required_property_is_declared(): void
    {
        foreach ($this->tools() as $tool) {
            $this->assertRequiredSubsetOfProperties($tool->inputSchema(), $tool->name());
        }
    }

    /** A `required` naming a property that does not exist is unsatisfiable. */
    private function assertRequiredSubsetOfProperties(array $schema, string $path): void
    {
        $properties = $schema['properties'] ?? [];

        foreach ($schema['required'] ?? [] as $name) {
            $this->assertArrayHasKey($name, $properties, "{$path}.required names an undeclared property: {$name}");
        }

        // Recursion matters: log_workout's real contract is three levels down,
        // in exercises[].sets[], which is where a hand-written schema drifts.
        foreach ($properties as $name => $property) {
            if (($property['type'] ?? null) === 'object') {
                $this->assertRequiredSubsetOfProperties($property, "{$path}.{$name}");
            }
            if (($property['type'] ?? null) === 'array' && ($property['items']['type'] ?? null) === 'object') {
                $this->assertRequiredSubsetOfProperties($property['items'], "{$path}.{$name}[]");
            }
        }
    }

    public function test_every_property_is_described(): void
    {
        foreach ($this->tools() as $tool) {
            $this->assertPropertiesDescribed($tool->inputSchema(), $tool->name());
        }
    }

    private function assertPropertiesDescribed(array $schema, string $path): void
    {
        foreach ($schema['properties'] ?? [] as $name => $property) {
            $this->assertNotEmpty(
                $property['description'] ?? '',
                "{$path}.{$name} has no description — the model has only the name to go on",
            );

            if (($property['type'] ?? null) === 'object') {
                $this->assertPropertiesDescribed($property, "{$path}.{$name}");
            }
            if (($property['type'] ?? null) === 'array' && ($property['items']['type'] ?? null) === 'object') {
                $this->assertPropertiesDescribed($property['items'], "{$path}.{$name}[]");
            }
        }
    }

    public function test_write_tools_are_marked_as_mutating(): void
    {
        foreach ($this->tools() as $tool) {
            // `open` counts: this test is about a tool that has an effect the
            // user must approve, not about a tool that writes a row. The
            // prefix list is the proxy for that, and the day a verb is missing
            // from it is the day a tool quietly skips the confirmation gate.
            $writes = (bool) preg_match('/^(log|update|create|save|delete|open|pin)_/', $tool->name());

            $this->assertSame(
                $writes,
                $tool instanceof MutatingTool,
                "{$tool->name()} disagrees with its name about whether it writes",
            );
            $this->assertSame($writes, $this->registry()->isMutating($tool->name()));
        }
    }

    public function test_v1_has_no_delete_tool(): void
    {
        foreach ($this->tools() as $tool) {
            $this->assertStringNotContainsString('delete', $tool->name());
        }
    }

    // ── Schemas agree with the writers ────────────────────────────────────────

    public function test_workout_schemas_require_what_the_writer_requires(): void
    {
        $writerRequires = $this->requiredTopLevelRules(WorkoutWriter::RULES);

        foreach (['log_workout', 'update_workout'] as $name) {
            $schema = $this->registry()->get($name)->inputSchema();

            foreach ($writerRequires as $field) {
                $this->assertContains($field, $schema['required'], "{$name} omits required field {$field}");
                $this->assertArrayHasKey($field, $schema['properties']);
            }

            // And nothing advertised that the writer will silently drop.
            foreach (array_keys($schema['properties']) as $property) {
                if ($property === 'id') {
                    continue; // Addressing, not payload — it is not a workout column.
                }
                $this->assertArrayHasKey($property, WorkoutWriter::RULES, "{$name} advertises unknown field {$property}");
            }
        }
    }

    public function test_set_type_enum_matches_the_writer(): void
    {
        $sets = $this->registry()->get('log_workout')
            ->inputSchema()['properties']['exercises']['items']['properties']['sets'];

        $this->assertSame(
            WorkoutWriter::setTypes(),
            $sets['items']['properties']['set_type']['enum'],
        );
    }

    public function test_create_exercise_requires_what_the_writer_requires(): void
    {
        $schema = $this->registry()->get('create_exercise')->inputSchema();

        foreach ($this->requiredTopLevelRules(ExerciseWriter::rules()) as $field) {
            $this->assertContains($field, $schema['required'], "create_exercise omits required field {$field}");
        }

        foreach (array_keys($schema['properties']) as $property) {
            $this->assertArrayHasKey($property, ExerciseWriter::rules());
        }
    }

    public function test_the_calendar_cannot_be_written_to(): void
    {
        // The calendars live in Google or iCloud, read through iCal addresses that carry no
        // write access at all. A tool claiming to add an event would be a tool
        // that can only ever fail — or worse, one the model reports as done.
        $calendarTools = array_filter(
            array_keys($this->registry()->all()),
            fn (string $name) => str_contains($name, 'event'),
        );

        $this->assertSame(['list_events'], array_values($calendarTools));
    }

    /** @return list<string> the un-nested rule keys carrying `required` */
    private function requiredTopLevelRules(array $rules): array
    {
        $required = [];

        foreach ($rules as $field => $fieldRules) {
            if (str_contains($field, '.')) {
                continue;
            }
            if (in_array('required', $fieldRules, true)) {
                $required[] = $field;
            }
        }

        return $required;
    }

    public function test_every_tool_taking_a_limit_caps_it(): void
    {
        foreach ($this->tools() as $tool) {
            if (! isset($tool->inputSchema()['properties']['limit'])) {
                continue;
            }

            // Empty tables, so this asserts the clamp reached the query rather
            // than the row count — the point is that no exception and no
            // unbounded fetch results from an absurd limit.
            $result = $tool->handle(['limit' => 10000]);
            $rows = $result[array_key_first($result)];

            $this->assertLessThanOrEqual(BaseTool::MAX_LIMIT, count($rows), "{$tool->name()} honoured an absurd limit");
        }
    }
}
