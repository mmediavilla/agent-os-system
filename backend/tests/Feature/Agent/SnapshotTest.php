<?php

namespace Tests\Feature\Agent;

use App\Agent\AgentRunner;
use App\Agent\Support\MessageCodec;
use App\Agent\Support\SnapshotStore;
use App\Models\Conversation;
use App\Models\Setting;
use App\Models\Snapshot;
use App\Services\AnthropicSwitch;
use App\Services\AssistantSettings;
use App\Services\ClaudeService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Facades\URL;
use Tests\TestCase;

/**
 * A camera frame, from the composer to the model and back to an `<img>`.
 *
 * The interesting assertions here are not that an upload works. They are the
 * three things that keep an upload from being expensive: the bytes stay off the
 * transcript, only the most recent few go back up to the API, and a frame that
 * is refused leaves nothing behind on disk.
 */
class SnapshotTest extends TestCase
{
    use RefreshDatabase;

    /** One transparent pixel. Small enough to inline, real enough to pass getimagesize. */
    private const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

    protected function setUp(): void
    {
        parent::setUp();

        Storage::fake();

        // The queue is `sync` here, so a 202 runs the loop before the response
        // comes back. Nothing in this file is about what the model says.
        $this->answers();
    }

    /** The model says one thing and stops. */
    private function answers(string $text = 'A dumbbell.'): void
    {
        $this->mock(ClaudeService::class)
            ->shouldReceive('turn')
            ->andReturn([
                'content' => [['type' => 'text', 'text' => $text]],
                'stop_reason' => 'end_turn',
                'usage' => ['input_tokens' => 1, 'output_tokens' => 1,
                    'cache_read_input_tokens' => null, 'cache_creation_input_tokens' => null],
                'model' => 'claude-sonnet-5',
            ]);
    }

    /** @param  array<string, mixed>  $overrides */
    private function send(Conversation $conversation, array $overrides = [])
    {
        return $this->postJson("/api/agent/conversations/{$conversation->id}/messages", array_merge([
            'message' => 'What is this?',
            'image' => ['data' => self::PNG, 'media_type' => 'image/png'],
        ], $overrides));
    }

    /** Attach a frame to a conversation without going through the endpoint. */
    private function attach(Conversation $conversation, string $text = 'What is this?'): Snapshot
    {
        $snapshot = SnapshotStore::store($conversation, self::PNG, 'image/png');

        app(AgentRunner::class)->accept($conversation, $text, $snapshot);

        return $snapshot;
    }

    public function test_a_frame_is_stored_off_the_transcript_and_referenced_from_it(): void
    {
        $conversation = Conversation::create([]);

        $this->send($conversation)->assertStatus(202);

        $snapshot = Snapshot::sole();

        Storage::assertExists($snapshot->path);
        $this->assertSame('image/png', $snapshot->media_type);
        $this->assertSame(1, $snapshot->width);

        // The stored turn holds a reference and not a hundred kilobytes of
        // base64 — which is the whole reason there is a table at all.
        $stored = $conversation->messages()->first()->content;

        $this->assertSame('image', $stored[0]['type']);
        $this->assertSame('snapshot', $stored[0]['source']['type']);
        $this->assertSame($snapshot->id, $stored[0]['source']['id']);
        $this->assertArrayNotHasKey('data', $stored[0]['source']);

        // The picture goes before the words, which is the API's own advice.
        $this->assertSame('text', $stored[1]['type']);
    }

    public function test_the_client_is_handed_a_url_rather_than_the_bytes(): void
    {
        $conversation = Conversation::create([]);
        $this->send($conversation);

        $snapshot = Snapshot::sole();

        $block = $this->getJson("/api/agent/conversations/{$conversation->id}")
            ->assertOk()
            ->json('messages.0.content.0');

        $this->assertSame('image', $block['type']);
        $this->assertSame($snapshot->id, $block['snapshot_id']);
        // Signed, because an <img> cannot send the bearer token.
        $this->assertStringContainsString("/api/agent/snapshots/{$snapshot->id}?expires=", $block['url']);
        $this->assertStringContainsString('&signature=', $block['url']);
        $this->assertArrayNotHasKey('source', $block);

        $picture = $this->get($block['url'])
            ->assertOk()
            ->assertHeader('Content-Type', 'image/png');

        // A snapshot has no replace path, so its URL needs no version in it and
        // this copy never needs revalidating. Symfony reorders the directives.
        $this->assertStringContainsString('immutable', $picture->headers->get('Cache-Control'));
        $this->assertStringContainsString('max-age=31536000', $picture->headers->get('Cache-Control'));
    }

    public function test_a_snapshot_whose_file_has_gone_is_a_404_rather_than_a_500(): void
    {
        $conversation = Conversation::create([]);
        $this->send($conversation);

        $snapshot = Snapshot::sole();
        Storage::delete($snapshot->path);

        $this->get(URL::signedRoute('agent.snapshots.show', ['snapshot' => $snapshot->id]))->assertNotFound();
    }

    public function test_the_transcript_carries_the_bytes_to_the_model(): void
    {
        $conversation = Conversation::create([]);
        $snapshot = $this->attach($conversation);

        $wire = MessageCodec::transcript($conversation->messages()->get());

        $this->assertSame('image', $wire[0]['content'][0]['type']);
        $this->assertSame('base64', $wire[0]['content'][0]['source']['type']);
        $this->assertSame('image/png', $wire[0]['content'][0]['source']['media_type']);
        $this->assertSame(self::PNG, $wire[0]['content'][0]['source']['data']);
        $this->assertSame($snapshot->id, Snapshot::sole()->id);
    }

    public function test_only_the_most_recent_snapshots_are_sent_and_the_rest_say_so(): void
    {
        // An image is re-sent on every later turn of every later loop, so a
        // thread with six pictures in it would cost six of them every time.
        config(['agent.snapshots.replay' => 2]);

        $conversation = Conversation::create([]);

        $this->attach($conversation, 'one');
        $this->attach($conversation, 'two');
        $this->attach($conversation, 'three');

        $wire = MessageCodec::transcript($conversation->messages()->get());

        // Dropped, but never silently: the question attached to a picture makes
        // no sense without knowing there was one.
        $this->assertSame('text', $wire[0]['content'][0]['type']);
        $this->assertStringContainsString('no longer being sent', $wire[0]['content'][0]['text']);

        $this->assertSame('base64', $wire[1]['content'][0]['source']['type']);
        $this->assertSame('base64', $wire[2]['content'][0]['source']['type']);
    }

    public function test_the_replay_depth_saved_in_assistant_settings_beats_env(): void
    {
        config(['agent.snapshots.replay' => 5]);
        Setting::put(AssistantSettings::SNAPSHOT_REPLAY, 1);

        $conversation = Conversation::create([]);

        $this->attach($conversation, 'one');
        $this->attach($conversation, 'two');

        $wire = MessageCodec::transcript($conversation->messages()->get());

        $this->assertSame('text', $wire[0]['content'][0]['type']);
        $this->assertSame('base64', $wire[1]['content'][0]['source']['type']);
    }

    public function test_a_transcript_with_no_snapshots_is_replayed_verbatim(): void
    {
        $conversation = Conversation::create([]);
        app(AgentRunner::class)->accept($conversation, 'no picture here');

        $wire = MessageCodec::transcript($conversation->messages()->get());

        $this->assertSame([['type' => 'text', 'text' => 'no picture here']], $wire[0]['content']);
    }

    public function test_a_snapshot_alone_is_a_whole_question(): void
    {
        $conversation = Conversation::create([]);

        $this->send($conversation, ['message' => null])->assertStatus(202);

        $this->assertCount(1, $conversation->messages()->first()->content);
        // The one turn with no words to take a title from.
        $this->assertSame('Camera snapshot', $conversation->refresh()->title);
    }

    public function test_a_message_with_neither_words_nor_a_picture_is_refused(): void
    {
        $conversation = Conversation::create([]);

        $this->postJson("/api/agent/conversations/{$conversation->id}/messages", [])
            ->assertStatus(422)
            ->assertJsonValidationErrors('message');
    }

    public function test_bytes_that_are_not_an_image_are_refused(): void
    {
        $conversation = Conversation::create([]);

        $this->send($conversation, ['image' => [
            'data' => base64_encode('this is not a picture'),
            'media_type' => 'image/png',
        ]])->assertStatus(422);

        $this->assertSame(0, Snapshot::count());
        $this->assertSame(0, $conversation->messages()->count());
    }

    public function test_a_declared_type_that_disagrees_with_the_bytes_is_refused(): void
    {
        $conversation = Conversation::create([]);

        // The header is the client's to choose, and it is what the file would
        // later be streamed back under.
        $this->send($conversation, ['image' => ['data' => self::PNG, 'media_type' => 'image/jpeg']])
            ->assertStatus(422);

        $this->assertSame(0, Snapshot::count());
    }

    public function test_a_media_type_the_api_does_not_take_is_refused(): void
    {
        $conversation = Conversation::create([]);

        $this->send($conversation, ['image' => ['data' => self::PNG, 'media_type' => 'image/gif']])
            ->assertStatus(422)
            ->assertJsonValidationErrors('image.media_type');
    }

    public function test_a_frame_over_the_size_ceiling_is_refused(): void
    {
        config(['agent.snapshots.max_kb' => 1]);

        $conversation = Conversation::create([]);

        $this->send($conversation, ['image' => [
            'data' => base64_encode(str_repeat('x', 2048)),
            'media_type' => 'image/png',
        ]])->assertStatus(413);

        $this->assertSame(0, Snapshot::count());
    }

    public function test_the_daily_ceiling_refuses_and_stores_nothing(): void
    {
        config(['agent.snapshots.per_day' => 1]);

        $conversation = Conversation::create([]);

        $this->send($conversation)->assertStatus(202);
        $this->send($conversation, ['message' => 'and this?'])->assertStatus(429);

        $this->assertSame(1, Snapshot::count());
        $this->assertSame(1, $conversation->messages()->where('role', 'user')->count());
    }

    public function test_yesterdays_snapshots_do_not_count_against_today(): void
    {
        config(['agent.snapshots.per_day' => 1]);

        $conversation = Conversation::create([]);
        Snapshot::create([
            'conversation_id' => $conversation->id,
            'path' => 'snapshots/old.png',
            'media_type' => 'image/png',
            'bytes' => 10,
        ])->forceFill(['created_at' => now()->subDays(2)])->save();

        $this->send($conversation)->assertStatus(202);
    }

    public function test_the_switch_being_off_refuses_before_anything_reaches_the_disk(): void
    {
        AnthropicSwitch::set(false);

        $conversation = Conversation::create([]);

        $this->send($conversation)->assertStatus(503);

        $this->assertSame(0, Snapshot::count());
        $this->assertCount(0, Storage::allFiles());
    }

    public function test_deleting_a_thread_takes_its_pictures_off_the_disk(): void
    {
        $conversation = Conversation::create([]);
        $this->send($conversation);

        $path = Snapshot::sole()->path;
        Storage::assertExists($path);

        $this->deleteJson("/api/agent/conversations/{$conversation->id}")->assertNoContent();

        // The foreign key would have taken the row either way; a database
        // cascade fires no model events, so this is the assertion that the file
        // went with it.
        Storage::assertMissing($path);
        $this->assertSame(0, Snapshot::count());
    }
}
