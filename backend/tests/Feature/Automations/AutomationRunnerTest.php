<?php

namespace Tests\Feature\Automations;

use App\Agent\Streaming\RunDispatcher;
use App\Agent\Support\TranscriptPresenter;
use App\Agent\ToolRegistry;
use App\Jobs\RunAutomation;
use App\Models\AgentRun;
use App\Models\Automation;
use App\Models\Conversation;
use App\Models\ConversationMessage;
use App\Models\Deadline;
use App\Services\AnthropicSwitch;
use App\Services\Automations\AutomationRunner;
use App\Services\ClaudeService;
use App\Services\NewsSettings;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Http;
use Mockery;
use RuntimeException;
use Tests\TestCase;
use Tests\Unit\News\FeedParserTest as Feed;

/**
 * 15.3: turning one due automation into a conversation, and reporting what
 * happened. The once-a-day claim and the routes are `AutomationApiTest`'s.
 */
class AutomationRunnerTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        // The migration's own seeded row plays no part in these tests.
        Automation::query()->delete();
    }

    private function automation(array $overrides = []): Automation
    {
        return Automation::create(array_merge([
            'name' => 'Morning greeting',
            'time' => '06:30',
            'intent' => 'Give a short, friendly good-morning greeting.',
            'context' => ['agenda', 'weather', 'training'],
            'enabled' => true,
        ], $overrides));
    }

    /** A turn that just talks. */
    private function reply(string $text): array
    {
        return [
            'content' => [['type' => 'text', 'text' => $text]],
            'stop_reason' => 'end_turn',
            'usage' => ['input_tokens' => 10, 'output_tokens' => 5],
            'model' => 'claude-sonnet-5',
        ];
    }

    // ── The switch ──────────────────────────────────────────────────────────

    public function test_switched_off_records_skipped_and_creates_no_conversation(): void
    {
        AnthropicSwitch::set(false);
        $automation = $this->automation();

        app(AutomationRunner::class)->run($automation);

        $automation->refresh();
        $this->assertSame(Automation::SKIPPED, $automation->last_outcome);
        $this->assertNotNull($automation->last_run_at);
        $this->assertNull($automation->last_conversation_id);
        $this->assertSame(0, Conversation::count());
    }

    // ── A normal run ────────────────────────────────────────────────────────

    public function test_it_assembles_context_into_a_hidden_first_turn_and_records_ok(): void
    {
        $automation = $this->automation(['intent' => 'Say good morning and mention the plan for today.']);
        $this->mock(ClaudeService::class)->shouldReceive('turn')->once()
            ->andReturn($this->reply('Good morning, Sir. A quiet day ahead.'));

        app(AutomationRunner::class)->run($automation);

        $automation->refresh();
        $this->assertSame(Automation::OK, $automation->last_outcome);
        $this->assertNull($automation->last_error);
        $this->assertNotNull($automation->last_conversation_id);

        $conversation = Conversation::find($automation->last_conversation_id);
        $this->assertSame('Morning greeting', $conversation->title);

        $stored = $conversation->messages()->get();
        $this->assertCount(2, $stored);

        $prompt = $stored->first();
        $this->assertSame(['automation_id' => $automation->id], $prompt->meta);
        $promptText = $prompt->content[0]['text'];
        $this->assertStringContainsString('Say good morning and mention the plan for today.', $promptText);
        $this->assertStringContainsString('The current time is', $promptText);
        $this->assertStringContainsString("Today's agenda:", $promptText);
        $this->assertStringContainsString('The weather:', $promptText);
        $this->assertStringContainsString("This week's training:", $promptText);

        // The assembled prompt is scaffolding, not something the owner typed —
        // left out of what the transcript shows, the way a thinking block is.
        $visible = TranscriptPresenter::messages($stored);
        $this->assertCount(1, $visible);
        $this->assertSame('Good morning, Sir. A quiet day ahead.', $visible[0]['text']);
    }

    public function test_context_pieces_not_named_are_left_out_of_the_prompt(): void
    {
        $automation = $this->automation(['context' => ['agenda']]);
        $this->mock(ClaudeService::class)->shouldReceive('turn')->once()->andReturn($this->reply('Morning.'));

        app(AutomationRunner::class)->run($automation);

        $conversation = Conversation::find($automation->fresh()->last_conversation_id);
        $promptText = $conversation->messages()->first()->content[0]['text'];

        $this->assertStringContainsString("Today's agenda:", $promptText);
        $this->assertStringNotContainsString('The weather:', $promptText);
        $this->assertStringNotContainsString("This week's training:", $promptText);
    }

    public function test_deadlines_bring_what_is_due_soon_and_overdue_into_the_prompt(): void
    {
        config(['agent.timezone' => 'Asia/Manila']);
        $this->travelTo('2026-09-27 01:00:00');

        Deadline::create(['title' => 'Pay premium', 'due_on' => '2026-09-20', 'kind' => 'payment']);
        Deadline::create(['title' => 'Renew visa', 'due_on' => '2026-10-05', 'kind' => 'renewal']);
        // A year off: read out every morning, it would be a greeting nobody
        // listens to.
        Deadline::create(['title' => 'Renew passport', 'due_on' => '2027-09-01', 'kind' => 'renewal']);

        $automation = $this->automation(['context' => ['deadlines']]);
        $this->mock(ClaudeService::class)->shouldReceive('turn')->once()->andReturn($this->reply('Morning.'));

        app(AutomationRunner::class)->run($automation);

        $conversation = Conversation::find($automation->fresh()->last_conversation_id);
        $promptText = $conversation->messages()->first()->content[0]['text'];

        $this->assertStringContainsString('What is due in the next '.AutomationRunner::DEADLINE_HORIZON_DAYS.' days', $promptText);
        $this->assertStringContainsString('Pay premium', $promptText);
        $this->assertStringContainsString('Renew visa', $promptText);
        $this->assertStringNotContainsString('Renew passport', $promptText);
        $this->assertStringNotContainsString("Today's agenda:", $promptText);
    }

    public function test_deadlines_is_a_context_piece_the_api_accepts(): void
    {
        $this->assertContains('deadlines', Automation::CONTEXT);

        $this->postJson('/api/automations', [
            'name' => 'Evening wrap-up',
            'time' => '20:00',
            'intent' => 'Say what is due.',
            'context' => ['deadlines'],
        ])->assertCreated()->assertJsonPath('context', ['deadlines']);
    }

    // ── News (19.4) ─────────────────────────────────────────────────────────

    /** One outlet on the local beat, and Google News for the interests. */
    private function newsFeeds(): void
    {
        config([
            'news.search' => [
                'name' => 'Google News',
                'url' => 'https://news.google.com/rss/search',
                'params' => ['hl' => 'en-PH'],
                'summaries' => false,
            ],
            'news.beats' => [
                'local' => [
                    'label' => 'Metro Manila',
                    'feeds' => [['name' => 'Alpha', 'url' => 'https://alpha.example/feed']],
                ],
            ],
        ]);

        Http::fake([
            'alpha.example/*' => Http::response(Feed::rss([
                Feed::item('EDSA closes for the weekend', 'https://alpha.example/edsa', now()->subHour()->toRfc2822String(), 'Roadworks.'),
            ])),
            'news.google.com/*' => Http::response(Feed::rss([
                Feed::item('Verstappen wins in Singapore', 'https://g.example/f1', now()->subHours(2)->toRfc2822String()),
            ])),
        ]);
    }

    public function test_news_brings_the_local_beat_and_the_interests_into_the_prompt(): void
    {
        $this->newsFeeds();
        NewsSettings::setInterests(['Formula 1']);

        $automation = $this->automation(['context' => ['news']]);
        $this->mock(ClaudeService::class)->shouldReceive('turn')->once()->andReturn($this->reply('Morning.'));

        app(AutomationRunner::class)->run($automation);

        $promptText = Conversation::find($automation->fresh()->last_conversation_id)->messages()->first()->content[0]['text'];

        $this->assertStringContainsString("The local news:\n", $promptText);
        $this->assertStringContainsString('EDSA closes for the weekend', $promptText);
        $this->assertStringContainsString("News on the user's interests:\n", $promptText);
        $this->assertStringContainsString('Verstappen wins in Singapore', $promptText);
        $this->assertStringNotContainsString("Today's agenda:", $promptText);

        // Handed over through the tool, so the greeting counts as having told
        // the owner: a briefing asked for afterwards flags it as a repeat.
        $again = app(ToolRegistry::class)->run('get_news', ['beat' => 'local']);
        $this->assertStringContainsString('"seen_before":true', $again);
    }

    public function test_news_without_interests_brings_the_local_beat_alone(): void
    {
        $this->newsFeeds();

        $automation = $this->automation(['context' => ['news']]);
        $this->mock(ClaudeService::class)->shouldReceive('turn')->once()->andReturn($this->reply('Morning.'));

        app(AutomationRunner::class)->run($automation);

        $promptText = Conversation::find($automation->fresh()->last_conversation_id)->messages()->first()->content[0]['text'];

        $this->assertStringContainsString('EDSA closes for the weekend', $promptText);
        // Not the tool's "no interests yet — point them at the setting"
        // sentence: that is a note for a conversation, not a greeting.
        $this->assertStringNotContainsString('interests', $promptText);
        Http::assertNotSent(fn ($request) => str_contains($request->url(), 'news.google.com'));
    }

    public function test_news_is_a_context_piece_the_api_accepts(): void
    {
        $this->assertContains('news', Automation::CONTEXT);

        $this->postJson('/api/automations', [
            'name' => 'Morning briefing',
            'time' => '07:00',
            'intent' => 'Brief me.',
            'context' => ['news', 'weather'],
        ])->assertCreated()->assertJsonPath('context', ['news', 'weather']);
    }

    // ── Failure ─────────────────────────────────────────────────────────────

    public function test_a_failure_assembling_the_prompt_is_recorded_and_creates_nothing(): void
    {
        $automation = $this->automation();
        $tools = Mockery::mock(ToolRegistry::class);
        $tools->shouldReceive('attempt')->andThrow(new RuntimeException('tool exploded'));

        $thrown = null;

        try {
            (new AutomationRunner($tools))->run($automation);
        } catch (RuntimeException $e) {
            $thrown = $e->getMessage();
        }

        $this->assertSame('tool exploded', $thrown);

        $automation->refresh();
        $this->assertSame(Automation::FAILED, $automation->last_outcome);
        $this->assertSame('tool exploded', $automation->last_error);
        $this->assertNull($automation->last_conversation_id);
        $this->assertSame(0, Conversation::count());
    }

    public function test_the_job_rethrows_a_failure_after_the_runner_records_it(): void
    {
        $automation = $this->automation();
        $tools = Mockery::mock(ToolRegistry::class);
        $tools->shouldReceive('attempt')->andThrow(new RuntimeException('tool exploded'));

        $thrown = null;

        try {
            (new RunAutomation($automation->id))->handle(new AutomationRunner($tools));
        } catch (RuntimeException $e) {
            $thrown = $e->getMessage();
        }

        $this->assertSame('tool exploded', $thrown);
        $this->assertSame(Automation::FAILED, $automation->fresh()->last_outcome);
    }

    public function test_the_job_does_nothing_when_the_row_is_gone(): void
    {
        $automation = $this->automation();
        $missingId = $automation->id;
        $automation->delete();

        // A row deleted between being queued and the worker picking it up is
        // simply skipped — not a failure to record anywhere.
        (new RunAutomation($missingId))->handle(app(AutomationRunner::class));

        $this->assertTrue(true);
    }

    // ── The tool loop gets the right registry ──────────────────────────────

    public function test_an_automation_run_is_not_offered_local_tools_even_when_configured(): void
    {
        config(['agent.local.enabled' => true, 'agent.local.targets' => [
            'project_folder' => ['label' => 'The source folder', 'open' => '/srv/projectmc'],
        ]]);
        $this->app->forgetInstance(ToolRegistry::class);

        $conversation = Conversation::create(['title' => 'Automation']);
        $conversation->messages()->create([
            'role' => ConversationMessage::USER,
            'content' => [['type' => 'text', 'text' => 'Good morning.']],
            'meta' => ['automation_id' => 1],
        ]);
        $conversation->forceFill(['last_message_at' => now()])->save();

        $systemSeen = null;
        $this->mock(ClaudeService::class)->shouldReceive('turn')->once()
            ->withArgs(function (string $system) use (&$systemSeen) {
                $systemSeen = $system;

                return true;
            })
            ->andReturn($this->reply('Good morning, Sir.'));

        RunDispatcher::queue($conversation, AgentRun::TRIGGER_AUTOMATION);

        $this->assertStringNotContainsString('open_on_this_machine', $systemSeen);
    }

    public function test_an_ordinary_message_run_still_offers_local_tools_when_configured(): void
    {
        config(['agent.local.enabled' => true, 'agent.local.targets' => [
            'project_folder' => ['label' => 'The source folder', 'open' => '/srv/projectmc'],
        ]]);
        $this->app->forgetInstance(ToolRegistry::class);

        $conversation = Conversation::create(['title' => 'Chat']);
        $conversation->messages()->create([
            'role' => ConversationMessage::USER,
            'content' => [['type' => 'text', 'text' => 'Open my project folder.']],
        ]);
        $conversation->forceFill(['last_message_at' => now()])->save();

        $systemSeen = null;
        $this->mock(ClaudeService::class)->shouldReceive('turn')->once()
            ->withArgs(function (string $system) use (&$systemSeen) {
                $systemSeen = $system;

                return true;
            })
            ->andReturn($this->reply('Sure.'));

        RunDispatcher::queue($conversation, AgentRun::TRIGGER_MESSAGE);

        $this->assertStringContainsString('open_on_this_machine', $systemSeen);
    }
}
