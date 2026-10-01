<?php

namespace Tests\Feature\Facts;

use App\Jobs\ExtractFacts;
use App\Models\Conversation;
use App\Models\ConversationMessage;
use App\Models\Fact;
use App\Services\AnthropicSwitch;
use App\Services\ClaudeService;
use App\Services\Facts\FactExtractor;
use App\Services\Facts\FactWriter;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Queue;
use Tests\TestCase;

/**
 * 15.2: a conversation gone quiet is read once, and what it says about the
 * owner is put up for review — never straight on file.
 */
class FactExtractionTest extends TestCase
{
    use RefreshDatabase;

    // ── When a thread is due ────────────────────────────────────────────────

    public function test_a_thread_is_due_only_once_it_has_been_quiet_for_twenty_minutes(): void
    {
        $this->travelTo('2026-09-22 10:00:00');
        $quiet = $this->thread(['I take my coffee black.'], at: '2026-09-22 09:40:00');
        $this->thread(['Still talking.'], at: '2026-09-22 09:45:00');

        $this->assertSame([$quiet->id], FactExtractor::due()->pluck('id')->all());
    }

    public function test_a_thread_read_to_its_end_is_not_due_until_it_gets_new_messages(): void
    {
        $this->travelTo('2026-09-22 10:00:00');
        $conversation = $this->thread(['I take my coffee black.'], at: '2026-09-22 09:00:00');
        $conversation->forceFill(['facts_extracted_through' => $conversation->messages()->max('id')])->save();

        $this->assertCount(0, FactExtractor::due());

        $this->message($conversation, ConversationMessage::USER, 'And I run on Sundays.');

        $this->assertSame([$conversation->id], FactExtractor::due()->pluck('id')->all());
    }

    public function test_the_tick_queues_each_due_thread_once_however_often_it_runs(): void
    {
        Queue::fake();
        $this->travelTo('2026-09-22 10:00:00');
        $conversation = $this->thread(['I take my coffee black.'], at: '2026-09-22 09:00:00');

        $this->assertSame(1, FactExtractor::dispatchDue());
        $this->assertSame(0, FactExtractor::dispatchDue());

        Queue::assertPushed(ExtractFacts::class, 1);
        Queue::assertPushed(ExtractFacts::class, fn (ExtractFacts $job) => $job->conversationId === $conversation->id);
    }

    public function test_the_tick_queues_at_most_a_handful(): void
    {
        Queue::fake();
        $this->travelTo('2026-09-22 10:00:00');

        foreach (range(1, FactExtractor::PER_TICK + 2) as $i) {
            $this->thread(["Message {$i}"], at: '2026-09-22 09:00:00');
        }

        $this->assertSame(FactExtractor::PER_TICK, FactExtractor::dispatchDue());
    }

    public function test_switched_off_the_tick_queues_nothing(): void
    {
        Queue::fake();
        AnthropicSwitch::set(false);
        $this->travelTo('2026-09-22 10:00:00');
        $this->thread(['I take my coffee black.'], at: '2026-09-22 09:00:00');

        $this->assertSame(0, FactExtractor::dispatchDue());
        Queue::assertNothingPushed();
    }

    public function test_threads_that_existed_before_the_migration_start_read(): void
    {
        $migration = require database_path('migrations/2026_09_22_000001_add_fact_extraction_watermark.php');
        $migration->down();

        $conversation = Conversation::create(['last_message_at' => now()->subDay()]);
        $message = $this->message($conversation, ConversationMessage::USER, 'Old news.');

        $migration->up();

        $this->assertSame($message->id, (int) $conversation->fresh()->facts_extracted_through);
    }

    // ── Reading one ─────────────────────────────────────────────────────────

    public function test_what_the_model_finds_is_proposed_not_saved_and_the_watermark_moves(): void
    {
        $conversation = $this->thread(['I take my coffee black, no sugar.', 'Sure, Sir.']);
        $this->answer(['facts' => [
            ['category' => 'Food', 'key' => 'Coffee', 'value' => 'Black, no sugar.', 'confidence' => 'stated'],
        ]]);

        $proposed = app(FactExtractor::class)->extract($conversation);

        $fact = Fact::sole();
        $this->assertCount(1, $proposed);
        $this->assertSame(
            [Fact::PROPOSED, 'extracted', Fact::STATED, 'food', 'coffee', $conversation->id],
            [$fact->status, $fact->source, $fact->confidence, $fact->category, $fact->key, $fact->conversation_id],
        );
        $this->assertSame((int) $conversation->messages()->max('id'), (int) $conversation->fresh()->facts_extracted_through);
    }

    public function test_the_call_is_the_chat_model_with_a_schema_and_only_the_words(): void
    {
        $conversation = $this->thread([]);
        $this->message($conversation, ConversationMessage::USER, 'Earlier: what should I eat?');
        $conversation->forceFill(['facts_extracted_through' => $conversation->messages()->max('id')])->save();
        ConversationMessage::create([
            'conversation_id' => $conversation->id,
            'role' => ConversationMessage::USER,
            'content' => [
                ['type' => 'image', 'source' => ['type' => 'snapshot', 'id' => 1]],
                ['type' => 'text', 'text' => 'This is my usual breakfast.'],
            ],
        ]);
        ConversationMessage::create([
            'conversation_id' => $conversation->id,
            'role' => ConversationMessage::ASSISTANT,
            'content' => [
                ['type' => 'thinking', 'thinking' => 'SECRET REASONING', 'signature' => 'x'],
                ['type' => 'tool_use', 'id' => 't1', 'name' => 'get_weather', 'input' => []],
            ],
        ]);
        ConversationMessage::create([
            'conversation_id' => $conversation->id,
            'role' => ConversationMessage::USER,
            'content' => [['type' => 'tool_result', 'tool_use_id' => 't1', 'content' => 'TOOL OUTPUT']],
        ]);
        Fact::create(['category' => 'food', 'key' => 'pork', 'value' => 'Eats it.', 'confidence' => 'stated', 'source' => 'extracted', 'status' => Fact::REJECTED, 'learned_at' => now(), 'decided_at' => now()]);
        app(FactWriter::class)->remember('food', 'coffee', 'Black.');

        $this->mock(ClaudeService::class)->shouldReceive('complete')->once()
            ->withArgs(function (string $system, string $user, ?string $model, ?int $max, ?string $effort, ?array $schema) {
                $this->assertSame('claude-sonnet-5', $model);
                $this->assertSame(['facts'], $schema['required']);
                $this->assertStringContainsString('User: [photo] This is my usual breakfast.', $user);
                $this->assertStringContainsString("<earlier>\n", $user);
                $this->assertStringContainsString('Earlier: what should I eat?', $user);
                $this->assertStringContainsString('- food / coffee: Black.', $user);
                $this->assertStringContainsString('- food / pork: Eats it.', $user);
                $this->assertStringNotContainsString('SECRET REASONING', $user);
                $this->assertStringNotContainsString('TOOL OUTPUT', $user);

                return true;
            })
            ->andReturn($this->reply(['facts' => []]));

        $this->assertSame([], app(FactExtractor::class)->extract($conversation));
    }

    public function test_refused_repeated_and_malformed_proposals_are_dropped(): void
    {
        $writer = app(FactWriter::class);
        $writer->reject($writer->propose('food', 'pork', 'Eats it.'));
        $writer->remember('food', 'coffee', 'Black.');

        $conversation = $this->thread(['Pork is fine. Coffee black. I changed jobs, I work at a clinic now.']);
        $this->answer(['facts' => [
            ['category' => 'food', 'key' => 'pork', 'value' => 'eats  it.', 'confidence' => 'stated'],
            ['category' => 'food', 'key' => 'coffee', 'value' => 'Black.', 'confidence' => 'stated'],
            ['category' => 'food', 'key' => 'tea', 'value' => str_repeat('x', 400), 'confidence' => 'stated'],
            ['category' => 'food', 'key' => 'tea', 'value' => 'Green.', 'confidence' => 'maybe'],
            ['category' => 'work', 'key' => 'employer', 'value' => 'A clinic.', 'confidence' => 'stated'],
        ]]);

        $proposed = app(FactExtractor::class)->extract($conversation);

        $this->assertSame(['A clinic.'], array_map(fn (Fact $f) => $f->value, $proposed));
    }

    public function test_a_new_value_for_a_key_on_file_is_proposed_beside_the_old_one(): void
    {
        app(FactWriter::class)->remember('food', 'coffee', 'Black.');
        $conversation = $this->thread(['I have started taking milk in my coffee.']);
        $this->answer(['facts' => [
            ['category' => 'food', 'key' => 'coffee', 'value' => 'With milk.', 'confidence' => 'stated'],
        ]]);

        app(FactExtractor::class)->extract($conversation);

        $this->assertSame('Black.', Fact::active()->sole()->value);
        $this->getJson('/api/facts')
            ->assertOk()
            ->assertJsonPath('proposed.0.value', 'With milk.')
            ->assertJsonPath('proposed.0.replaces', 'Black.');
    }

    public function test_a_thread_with_nothing_the_owner_said_is_marked_read_without_a_call(): void
    {
        $conversation = $this->thread([]);
        ConversationMessage::create([
            'conversation_id' => $conversation->id,
            'role' => ConversationMessage::USER,
            'content' => [['type' => 'image', 'source' => ['type' => 'snapshot', 'id' => 1]]],
        ]);
        $this->mock(ClaudeService::class)->shouldNotReceive('complete');

        app(FactExtractor::class)->extract($conversation);

        $this->assertNotNull($conversation->fresh()->facts_extracted_through);
    }

    public function test_a_failed_call_leaves_the_watermark_and_the_claim(): void
    {
        $conversation = $this->thread(['I take my coffee black.']);
        Cache::add(FactExtractor::claimKey($conversation->id), true, 60);
        $this->mock(ClaudeService::class)->shouldReceive('complete')->once()->andThrow(new \RuntimeException('overloaded'));

        try {
            (new ExtractFacts($conversation->id))->handle(app(FactExtractor::class));
            $this->fail('The failure should reach the queue.');
        } catch (\RuntimeException $e) {
            $this->assertSame('overloaded', $e->getMessage());
        }

        $this->assertNull($conversation->fresh()->facts_extracted_through);
        $this->assertTrue(Cache::has(FactExtractor::claimKey($conversation->id)));
        $this->assertSame(1, (new ExtractFacts(0))->tries);
    }

    public function test_an_answer_that_is_not_the_shape_asked_for_is_a_failure(): void
    {
        $conversation = $this->thread(['I take my coffee black.']);
        $this->mock(ClaudeService::class)->shouldReceive('complete')->once()
            ->andReturn(['text' => 'Sure! Here are the facts.', 'usage' => [], 'model' => 'claude-sonnet-5']);

        // Caught here rather than with `expectException`: PHPUnit keeps an
        // expected exception on the test for the rest of the run, and its trace
        // holds the whole container — enough to push the suite past 128MB.
        $thrown = null;

        try {
            app(FactExtractor::class)->extract($conversation);
        } catch (\RuntimeException $e) {
            $thrown = $e->getMessage();
        }

        $this->assertSame('Fact extraction did not answer in the expected shape.', $thrown);
        $this->assertNull($conversation->fresh()->facts_extracted_through);
    }

    public function test_switched_off_the_job_reads_nothing(): void
    {
        AnthropicSwitch::set(false);
        $conversation = $this->thread(['I take my coffee black.']);
        $this->mock(ClaudeService::class)->shouldNotReceive('complete');

        (new ExtractFacts($conversation->id))->handle(app(FactExtractor::class));

        $this->assertNull($conversation->fresh()->facts_extracted_through);
    }

    public function test_the_command_reads_the_latest_thread_and_prints_what_it_proposed(): void
    {
        $this->thread(['Older thread.'], at: now()->subDay());
        $latest = $this->thread(['I run on Sundays.']);
        $this->answer(['facts' => [
            ['category' => 'training', 'key' => 'running', 'value' => 'Runs on Sundays.', 'confidence' => 'stated'],
        ]]);

        $this->artisan('facts:extract')
            ->expectsOutputToContain("Conversation {$latest->id}")
            ->expectsOutputToContain('Proposed: training / running: Runs on Sundays. (stated)')
            ->assertSuccessful();
    }

    public function test_the_command_says_so_when_there_is_nothing_to_read(): void
    {
        $this->artisan('facts:extract', ['conversation' => 999])
            ->expectsOutputToContain('No conversation 999.')
            ->assertFailed();
    }

    // ── Helpers ─────────────────────────────────────────────────────────────

    /** @param  list<string>  $turns  alternating user / assistant text, user first */
    private function thread(array $turns, mixed $at = null): Conversation
    {
        $conversation = Conversation::create(['title' => 'Thread', 'last_message_at' => $at ?? now()]);

        foreach ($turns as $i => $text) {
            $this->message($conversation, $i % 2 === 0 ? ConversationMessage::USER : ConversationMessage::ASSISTANT, $text);
        }

        return $conversation;
    }

    private function message(Conversation $conversation, string $role, string $text): ConversationMessage
    {
        return ConversationMessage::create([
            'conversation_id' => $conversation->id,
            'role' => $role,
            'content' => [['type' => 'text', 'text' => $text]],
        ]);
    }

    /** @param  array<string, mixed>  $json */
    private function answer(array $json): void
    {
        $this->mock(ClaudeService::class)->shouldReceive('complete')->once()->andReturn($this->reply($json));
    }

    /** @param  array<string, mixed>  $json */
    private function reply(array $json): array
    {
        return ['text' => json_encode($json), 'usage' => ['input_tokens' => 10, 'output_tokens' => 5], 'model' => 'claude-sonnet-5'];
    }
}
