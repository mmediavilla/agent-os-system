<?php

namespace Tests\Feature\Agent;

use App\Agent\Contracts\MutatingTool;
use App\Agent\ToolRegistry;
use App\Agent\Tools\OpenOnThisMachine;
use App\Agent\Tools\ShowGoogleCalendar;
use App\Models\Conversation;
use App\Services\ClaudeService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Process;
use Illuminate\Validation\ValidationException;
use RuntimeException;
use Tests\TestCase;

/**
 * `show_google_calendar` — the one effect in the app with no approval card.
 *
 * What makes that acceptable is where it is registered, so that is asserted
 * first and from every side: on the spoken assistant's registry and nowhere
 * else, and only where this machine has opted into local actions at all. A
 * typed turn runs on the S4U queue worker, which has no desktop — an ungated
 * opener there would launch a browser nobody can see.
 */
class ShowGoogleCalendarTest extends TestCase
{
    use RefreshDatabase;

    /** @var list<array<string, mixed>> the tool schemas the model was last offered */
    private array $offered = [];

    private function enable(bool $enabled = true): void
    {
        config([
            'agent.local.enabled' => $enabled,
            'agent.local.targets' => [],
        ]);

        // The registry is a singleton built from config on first resolve.
        $this->app->forgetInstance(ToolRegistry::class);
    }

    /** @param  list<array<string, mixed>>  $turns */
    private function script(array $turns): void
    {
        $remaining = $turns;

        $this->mock(ClaudeService::class)
            ->shouldReceive('turn')
            ->andReturnUsing(function (string $system, array $messages, array $tools = []) use (&$remaining) {
                $this->offered = $tools;

                return array_shift($remaining);
            });
    }

    private function says(string $text): array
    {
        return [
            'content' => [['type' => 'text', 'text' => $text]],
            'stop_reason' => 'end_turn',
            'usage' => ['input_tokens' => 1, 'output_tokens' => 1,
                'cache_read_input_tokens' => null, 'cache_creation_input_tokens' => null],
            'model' => 'claude-sonnet-5',
        ];
    }

    private function callsShow(array $input = ['view' => 'week']): array
    {
        return [
            'content' => [[
                'type' => 'tool_use',
                'id' => 'toolu_show_1',
                'name' => 'show_google_calendar',
                'input' => $input,
            ]],
            'stop_reason' => 'tool_use',
            'usage' => ['input_tokens' => 1, 'output_tokens' => 1,
                'cache_read_input_tokens' => null, 'cache_creation_input_tokens' => null],
            'model' => 'claude-sonnet-5',
        ];
    }

    private function tool(): ShowGoogleCalendar
    {
        return app(ShowGoogleCalendar::class);
    }

    /** The names the voice turn put in front of the model. */
    private function voiceOffers(): array
    {
        $this->script([$this->says('Certainly, Sir.')]);
        $this->postJson('/api/voice/turn', ['message' => 'Show me my week'])->assertOk();

        return array_column($this->offered, 'name');
    }

    // ── where it is registered ───────────────────────────────────────────────

    public function test_voice_is_offered_it_last_when_local_actions_are_on(): void
    {
        $this->enable();

        // After the reads rather than among them, so the voice prefix is the
        // read-only one right up to where the two genuinely differ.
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
            'show_google_calendar',
        ], $this->voiceOffers());
    }

    public function test_voice_is_not_offered_it_when_local_actions_are_off(): void
    {
        $this->enable(false);

        $this->assertNotContains('show_google_calendar', $this->voiceOffers());
    }

    public function test_the_typed_loop_never_has_it(): void
    {
        $this->enable();

        $this->assertFalse(app(ToolRegistry::class)->has('show_google_calendar'));
        $this->assertFalse(app(ToolRegistry::class)->readOnly()->has('show_google_calendar'));
    }

    public function test_mcp_never_lists_it(): void
    {
        $this->enable();
        config(['agent.token' => 'test-agent-token']);

        $names = array_column(
            $this->withToken('test-agent-token')
                ->postJson('/api/mcp', ['jsonrpc' => '2.0', 'id' => 1, 'method' => 'tools/list'])
                ->assertOk()
                ->json('result.tools'),
            'name',
        );

        $this->assertNotContains('show_google_calendar', $names);
    }

    public function test_a_typed_turn_that_calls_it_anyway_opens_nothing(): void
    {
        // The model on the typed path has never been told about it. If it calls
        // it regardless, the name is unknown to that registry, so the call is an
        // error the model is shown — and nothing is opened on a worker that has
        // no desktop to put it on.
        $this->enable();
        Process::fake();
        $this->script([$this->callsShow(), $this->says('That is only available by voice, Sir.')]);

        $conversation = Conversation::create([]);
        $this->postJson("/api/agent/conversations/{$conversation->id}/messages", ['message' => 'show my week'])
            ->assertAccepted();

        Process::assertNothingRan();
        $this->assertDatabaseHas('agent_actions', ['tool' => 'show_google_calendar', 'is_error' => true]);
    }

    // ── what it is ───────────────────────────────────────────────────────────

    public function test_it_is_not_gated_and_its_name_says_so(): void
    {
        $tool = $this->tool();

        $this->assertNotInstanceOf(MutatingTool::class, $tool);

        // The writing-verb rule in ToolRegistryTest only walks the shared
        // registry, which this tool is deliberately not in. Held here as well,
        // so an ungated tool can never carry a name that reads as a write.
        $this->assertDoesNotMatchRegularExpression('/^(log|update|create|save|delete|open)_/', $tool->name());
    }

    public function test_its_schema_meets_the_registry_contract(): void
    {
        $tool = $this->tool();
        $input = $tool->schema()['input_schema'];

        $this->assertGreaterThan(80, strlen($tool->description()));
        $this->assertSame('object', $input['type']);
        // Non-empty on purpose: a tool with no parameters serialises
        // `properties` as `[]`, which is not a JSON Schema object.
        $this->assertNotEmpty($input['properties']);
        $this->assertSame([], $input['required']);
        $this->assertSame(ShowGoogleCalendar::VIEWS, $input['properties']['view']['enum']);

        foreach ($input['properties'] as $name => $property) {
            $this->assertNotEmpty($property['description'] ?? '', "show_google_calendar.{$name} has no description");
        }
    }

    // ── the address ──────────────────────────────────────────────────────────

    public function test_the_page_is_assembled_from_a_view_and_a_date(): void
    {
        // Google's own path shape, unpadded, so the page lands on the period
        // asked about rather than on today.
        $this->assertSame('https://calendar.google.com/calendar/r/week', ShowGoogleCalendar::url('week'));
        $this->assertSame('https://calendar.google.com/calendar/r/week/2026/9/14', ShowGoogleCalendar::url('week', '2026-09-14'));
        $this->assertSame('https://calendar.google.com/calendar/r/day/2026/1/5', ShowGoogleCalendar::url('day', '2026-01-05'));
        $this->assertSame('https://calendar.google.com/calendar/r/month/2026/10/1', ShowGoogleCalendar::url('month', '2026-10-01'));
    }

    public function test_the_model_cannot_name_an_address(): void
    {
        Process::fake();

        foreach ([['view' => 'https://evil.example'], ['date' => '../../x'], ['date' => '2026-9-14']] as $input) {
            try {
                $this->tool()->handle($input);
                $this->fail('Expected '.json_encode($input).' to be rejected.');
            } catch (ValidationException) {
                // Rejected, as it should be.
            }
        }

        Process::assertNothingRan();
    }

    // ── opening ──────────────────────────────────────────────────────────────

    public function test_it_opens_the_view_asked_for_in_a_new_tab_of_the_default_browser(): void
    {
        $this->enable();
        Process::fake();

        $result = $this->tool()->handle(['view' => 'month', 'date' => '2026-10-01']);

        $this->assertSame(['opened' => true, 'view' => 'month', 'date' => '2026-10-01'], $result);

        // The default browser's own "open this address" — `start "" <url>` on
        // Windows — which lands as a tab in the window it already has. No
        // program is named and no `--new-window` is passed: a tab is the owner's call,
        // and the shapes per OS are LocalActionsTest's to assert.
        $expected = OpenOnThisMachine::commandFor('https://calendar.google.com/calendar/r/month/2026/10/1');
        Process::assertRan(fn ($process) => $process->command === $expected);
        Process::assertRan(fn ($process) => ! in_array('--new-window', $process->command, true));
    }

    public function test_the_week_is_the_default_view(): void
    {
        $this->enable();
        Process::fake();

        $this->assertSame(['opened' => true, 'view' => 'week'], $this->tool()->handle([]));

        Process::assertRan(fn ($process) => end($process->command) === 'https://calendar.google.com/calendar/r/week');
    }

    public function test_a_second_call_moments_later_opens_nothing(): void
    {
        // Ungated means nothing stands between a model repeating itself and a
        // row of identical tabs.
        $this->enable();
        Process::fake();

        $this->assertTrue($this->tool()->handle(['view' => 'week'])['opened']);
        $this->assertFalse($this->tool()->handle(['view' => 'week'])['opened']);

        Process::assertRanTimes(fn () => true, 1);

        // And a person asking for another week a sentence later is not refused.
        $this->travel(6)->seconds();
        $this->assertTrue($this->tool()->handle(['view' => 'week', 'date' => '2026-09-21'])['opened']);

        Process::assertRanTimes(fn () => true, 2);
    }

    public function test_a_shell_that_fails_is_reported_and_can_be_retried_at_once(): void
    {
        $this->enable();
        Process::fake(['*' => Process::result(output: '', errorOutput: 'not found', exitCode: 1)]);

        try {
            $this->tool()->handle([]);
            $this->fail('Expected a failed launch to throw.');
        } catch (RuntimeException $e) {
            $this->assertStringContainsString('not found', $e->getMessage());
        }

        // The tab never appeared, so the debounce must not be holding it shut.
        Process::fake();
        $this->assertTrue($this->tool()->handle([])['opened']);
    }

    // ── from a spoken turn ───────────────────────────────────────────────────

    public function test_a_spoken_turn_opens_it_with_no_approval_card(): void
    {
        $this->enable();
        Process::fake();
        $this->script([$this->callsShow(), $this->says('It is on your screen, Sir.')]);

        $this->postJson('/api/voice/turn', ['message' => 'Show me what my week looks like'])
            ->assertOk()
            ->assertJsonPath('text', 'It is on your screen, Sir.');

        Process::assertRan(fn ($process) => end($process->command) === 'https://calendar.google.com/calendar/r/week');

        // In the audit log like every other call, and born approved — which is
        // what "ungated" means in this schema.
        $this->assertDatabaseHas('agent_actions', [
            'tool' => 'show_google_calendar',
            'requires_confirmation' => false,
            'is_error' => false,
        ]);
        $this->assertSame(0, Conversation::sole()->pendingActions()->count());
    }
}
