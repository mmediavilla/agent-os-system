<?php

namespace Tests\Feature\Agent;

use App\Agent\Support\Instructions;
use App\Agent\ToolRegistry;
use App\Agent\Tools\OpenOnThisMachine;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Process;
use Illuminate\Validation\ValidationException;
use RuntimeException;
use Tests\TestCase;

/**
 * The one tool that reaches outside the database.
 *
 * Two properties carry the whole design and are asserted first: the tool does
 * not exist at all when nothing has been allowed, and it is a mutating tool so
 * it cannot run until the user has decided. The second is load-bearing twice
 * over on Windows — an approved call runs inside the decision request, which
 * Herd serves from the interactive desktop session, while the queue worker that
 * runs everything else is registered S4U and has no desktop to open a window on.
 */
class LocalActionsTest extends TestCase
{
    // The system prompt reads the facts table, so building one needs a schema.
    use RefreshDatabase;

    private const FOLDER = ['project_folder' => ['label' => 'The source folder', 'open' => '/srv/projectmc']];

    /** @param  array<string, mixed>  $targets */
    private function configure(array $targets, bool $enabled = true): ToolRegistry
    {
        config(['agent.local.enabled' => $enabled, 'agent.local.targets' => $targets]);

        // The registry is a singleton, built from config the first time it is
        // resolved, so a test that changes config has to drop the old one.
        $this->app->forgetInstance(ToolRegistry::class);

        return app(ToolRegistry::class);
    }

    /** @param  array<string, mixed>  $targets */
    private function tool(array $targets = self::FOLDER): OpenOnThisMachine
    {
        /** @var OpenOnThisMachine */
        return $this->configure($targets)->get('open_on_this_machine');
    }

    // ── whether the tool exists at all ───────────────────────────────────────

    public function test_the_tool_is_not_registered_when_nothing_is_allowed(): void
    {
        $registry = $this->configure([]);

        $this->assertFalse($registry->has('open_on_this_machine'));

        // Not merely hidden from the model: the definitions sent to the Messages
        // API and the ones MCP returns from `tools/list` are the same list, so
        // an unconfigured checkout never advertises a reach it does not have.
        $this->assertNotContains('open_on_this_machine', array_column($registry->schemas(), 'name'));
    }

    public function test_the_switch_drops_the_tool_without_emptying_the_list(): void
    {
        $registry = $this->configure(self::FOLDER, enabled: false);

        $this->assertFalse($registry->has('open_on_this_machine'));
    }

    public function test_an_entry_whose_target_is_unset_drops_out(): void
    {
        // What an unset LOCAL_ACTIONS_EDITOR looks like by the time config is
        // built. The entry has to disappear rather than become an enum value
        // that opens the empty string.
        $registry = $this->configure(self::FOLDER + [
            'editor' => ['label' => 'The code editor', 'open' => null],
        ]);

        $this->assertSame(['project_folder'], array_keys(OpenOnThisMachine::targets()));
        $this->assertTrue($registry->has('open_on_this_machine'));
    }

    public function test_it_is_registered_last_so_the_cached_prefix_is_unchanged(): void
    {
        $withTargets = array_keys($this->configure(self::FOLDER)->all());
        $without = array_keys($this->configure([])->all());

        $this->assertSame('open_on_this_machine', end($withTargets));
        // Everything ahead of it is byte-identical to what an installation with
        // no targets sends, which is the property that makes the opt-in free.
        // Compared against that registry rather than against a named tool, so
        // appending to the fixed list does not fail this for the wrong reason.
        $this->assertSame($without, array_slice($withTargets, 0, -1));
    }

    // ── the gate ─────────────────────────────────────────────────────────────

    public function test_it_is_gated(): void
    {
        $this->assertTrue($this->configure(self::FOLDER)->isMutating('open_on_this_machine'));
    }

    public function test_the_system_prompt_names_it_among_the_gated_tools(): void
    {
        $this->assertStringContainsString(
            'open_on_this_machine',
            Instructions::systemPrompt($this->configure(self::FOLDER)),
        );

        // And says nothing about it when it is not there. The prompt is derived
        // from the registry precisely so the two cannot drift apart.
        $this->assertStringNotContainsString(
            'open_on_this_machine',
            Instructions::systemPrompt($this->configure([])),
        );
    }

    // ── the schema the model reads ───────────────────────────────────────────

    public function test_the_enum_and_the_description_are_the_configured_targets(): void
    {
        $tool = $this->tool(self::FOLDER + [
            'life_os' => ['label' => 'The web app', 'open' => 'https://projectmc-app.test'],
        ]);

        $this->assertSame(
            ['project_folder', 'life_os'],
            $tool->inputSchema()['properties']['target']['enum'],
        );

        $this->assertStringContainsString('life_os: The web app', $tool->description());
    }

    // ── opening ──────────────────────────────────────────────────────────────

    public function test_it_hands_the_configured_target_to_the_shell(): void
    {
        Process::fake();

        $result = $this->tool()->handle(['target' => 'project_folder']);

        $this->assertSame(
            ['target' => 'project_folder', 'label' => 'The source folder', 'opened' => true],
            $result,
        );

        Process::assertRan(fn ($process) => is_array($process->command)
            && end($process->command) === '/srv/projectmc');
    }

    public function test_each_platform_gets_its_own_open_command(): void
    {
        // Asserted for all three families wherever the suite runs, because the
        // Windows one has a trap in it: `start "C:\x"` reads a lone quoted
        // argument as the *window title*, and opens a console named after the
        // path instead of opening the path. The empty string is that title.
        $this->assertSame(['cmd', '/c', 'start', '', 'C:\x'], OpenOnThisMachine::commandFor('C:\x', 'Windows'));
        $this->assertSame(['open', '/x'], OpenOnThisMachine::commandFor('/x', 'Darwin'));
        $this->assertSame(['xdg-open', '/x'], OpenOnThisMachine::commandFor('/x', 'Linux'));
    }

    public function test_a_target_the_model_invented_is_refused(): void
    {
        Process::fake();
        $tool = $this->tool();

        try {
            $tool->handle(['target' => 'system32']);
            $this->fail('Expected an unknown target to be rejected.');
        } catch (ValidationException) {
            Process::assertNothingRan();
        }
    }

    public function test_a_target_removed_since_the_call_was_proposed_is_refused(): void
    {
        // Not a theoretical gap: a gated call sits in `agent_actions` until the
        // user decides it, and config can be edited in between. Validating
        // against the schema that was advertised would open something the user
        // had revoked in the meantime.
        $tool = $this->tool();

        config(['agent.local.targets' => []]);
        Process::fake();

        try {
            $tool->handle(['target' => 'project_folder']);
            $this->fail('Expected a revoked target to be rejected.');
        } catch (ValidationException) {
            Process::assertNothingRan();
        }
    }

    public function test_a_shell_that_fails_is_reported_rather_than_claimed_as_opened(): void
    {
        Process::fake(['*' => Process::result(output: '', errorOutput: 'not found', exitCode: 1)]);

        $this->expectException(RuntimeException::class);
        $this->expectExceptionMessage('not found');

        $this->tool()->handle(['target' => 'project_folder']);
    }
}
