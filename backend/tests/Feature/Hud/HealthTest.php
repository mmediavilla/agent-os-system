<?php

namespace Tests\Feature\Hud;

use App\Jobs\RecordQueueHeartbeat;
use App\Services\System\Heartbeat;
use Illuminate\Foundation\Testing\RefreshDatabase;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

class HealthTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        // Pinned, because `ok` would otherwise mean different things in the two
        // places this runs: a developer machine has ANTHROPIC_API_KEY in .env
        // and CI does not, so every `ok` assertion below would pass locally and
        // fail on `ubuntu-latest` for a reason that has nothing to do with the
        // heartbeats they are about. The one test that *is* about a missing key
        // sets it back to null.
        config(['services.anthropic.key' => 'test-key']);
    }

    #[Test]
    public function it_reports_the_database_it_is_actually_using(): void
    {
        $this->getJson('/api/health')
            ->assertOk()
            ->assertJsonPath('database.state', 'up')
            ->assertJsonPath('database.driver', 'sqlite')
            ->assertJsonStructure(['database' => ['latency_ms', 'journal_mode', 'size_bytes']]);
    }

    #[Test]
    public function a_runtime_that_has_never_beaten_is_unknown_rather_than_down(): void
    {
        $response = $this->getJson('/api/health')->assertOk();

        // "Never registered" and "stopped an hour ago" need different fixes, so
        // they read differently.
        $this->assertSame('unknown', $response->json('queue.state'));
        $this->assertSame('unknown', $response->json('scheduler.state'));
        $this->assertNull($response->json('queue.last_beat_at'));
        $this->assertTrue($response->json('ok'));
    }

    #[Test]
    public function a_fresh_heartbeat_is_up(): void
    {
        // A beat is stored to the second, so a request landing just past a
        // second boundary reads an age of 1. Frozen on a whole second, it is 0.
        $this->freezeSecond();

        Heartbeat::beat(Heartbeat::QUEUE);
        Heartbeat::beat(Heartbeat::SCHEDULER);

        $response = $this->getJson('/api/health')->assertOk();

        $this->assertSame('up', $response->json('queue.state'));
        $this->assertSame('up', $response->json('scheduler.state'));
        $this->assertSame(0, $response->json('queue.age_seconds'));
    }

    #[Test]
    public function a_heartbeat_past_the_grace_period_is_down(): void
    {
        config(['hud.health.heartbeat_grace' => 150]);

        Heartbeat::beat(Heartbeat::QUEUE);
        Heartbeat::beat(Heartbeat::SCHEDULER);

        // The grace is generous because `schedule:run` is a once-a-minute tick
        // and the worker sleeps between polls; anything tighter reports a
        // healthy machine as broken at least once an hour.
        $this->travel(120)->seconds();
        $this->assertSame('up', $this->getJson('/api/health')->json('queue.state'));

        $this->travel(60)->seconds();
        $response = $this->getJson('/api/health')->assertOk();

        $this->assertSame('down', $response->json('queue.state'));
        $this->assertSame('down', $response->json('scheduler.state'));
        $this->assertFalse($response->json('ok'));
    }

    #[Test]
    public function it_counts_the_backlog_alongside_the_heartbeat(): void
    {
        config(['queue.default' => 'database']);

        // A fresh beat and a growing backlog is a worker that is alive and
        // stuck, which looks like health from either number on its own.
        $this->assertSame(0, $this->getJson('/api/health')->json('queue.pending'));

        RecordQueueHeartbeat::dispatch();

        $this->assertSame(1, $this->getJson('/api/health')->json('queue.pending'));
    }

    #[Test]
    public function a_queue_it_cannot_count_reports_no_backlog_rather_than_zero(): void
    {
        config(['queue.default' => 'sync']);

        // Zero would be a claim about a queue this has no way to look inside.
        $this->assertNull($this->getJson('/api/health')->json('queue.pending'));
    }

    #[Test]
    public function a_missing_api_key_is_the_assistant_being_down(): void
    {
        config(['services.anthropic.key' => null]);

        $response = $this->getJson('/api/health')->assertOk();

        // Configured, not reachable: checking reachability would mean a paid
        // round trip on every poll of a panel.
        $this->assertSame('down', $response->json('assistant.state'));
        $this->assertFalse($response->json('assistant.configured'));
        $this->assertFalse($response->json('ok'));
    }

    #[Test]
    public function the_queue_heartbeat_can_only_be_stamped_by_a_worker(): void
    {
        $this->assertNull(Heartbeat::lastAt(Heartbeat::QUEUE));

        (new RecordQueueHeartbeat)->handle();

        // Counting rows in `jobs` would have answered a different question: an
        // empty table is what a healthy worker and a dead one both produce.
        $this->assertNotNull(Heartbeat::lastAt(Heartbeat::QUEUE));
    }
}
