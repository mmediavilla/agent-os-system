<?php

namespace Tests\Feature\Hud;

use App\Jobs\SampleMachine;
use App\Services\System\MachineProbe;
use App\Services\System\SystemStats;
use Illuminate\Support\Facades\Bus;
use Illuminate\Support\Facades\Cache;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

class SystemStatsTest extends TestCase
{
    #[Test]
    public function it_reports_the_disk_before_any_sample_exists(): void
    {
        Bus::fake();

        $response = $this->getJson('/api/system/stats')->assertOk();

        // Disk is a stat() call, so it never waits for the probe — which is what
        // puts something on the panel on the very first load.
        $this->assertNotNull($response->json('disk.total_bytes'));
        $this->assertNull($response->json('cpu'));
        $this->assertNull($response->json('memory'));
        $this->assertNull($response->json('sampled_at'));
        $this->assertNull($response->json('age_seconds'));
    }

    #[Test]
    public function it_queues_a_sample_when_there_is_nothing_current(): void
    {
        Bus::fake();

        $this->getJson('/api/system/stats')->assertOk();

        Bus::assertDispatched(SampleMachine::class);
    }

    #[Test]
    public function it_queues_one_sample_however_often_it_is_polled(): void
    {
        Bus::fake();

        // The failure this prevents is invisible from the response: a HUD
        // polling every few seconds against a dead worker would enqueue a job
        // per poll and fill the `jobs` table with work nothing will run.
        $this->getJson('/api/system/stats')->assertOk();
        $this->getJson('/api/system/stats')->assertOk();
        $this->getJson('/api/system/stats')->assertOk();

        Bus::assertDispatchedTimes(SampleMachine::class, 1);
    }

    #[Test]
    public function it_serves_the_last_sample_and_says_how_old_it_is(): void
    {
        Bus::fake();

        Cache::forever(SystemStats::SAMPLE_KEY, [
            'cpu_percent' => 34.0,
            'memory_used_bytes' => 21_260_000_000,
            'memory_total_bytes' => 34_000_000_000,
            'sampled_at' => now()->subSeconds(4)->toIso8601String(),
        ]);

        $response = $this->getJson('/api/system/stats')->assertOk();

        $this->assertEquals(34.0, $response->json('cpu.percent'));
        $this->assertEquals(62.5, $response->json('memory.percent'));
        $this->assertSame(4, $response->json('age_seconds'));

        // Fresh enough — nothing to replace.
        Bus::assertNotDispatched(SampleMachine::class);
    }

    #[Test]
    public function it_keeps_serving_a_stale_sample_rather_than_blanking_the_panel(): void
    {
        Bus::fake();

        Cache::forever(SystemStats::SAMPLE_KEY, [
            'cpu_percent' => 34.0,
            'memory_used_bytes' => 8,
            'memory_total_bytes' => 16,
            'sampled_at' => now()->subMinutes(5)->toIso8601String(),
        ]);

        $response = $this->getJson('/api/system/stats')->assertOk();

        // A stale number labelled stale beats an empty gauge: the age is what
        // the client shows, and a climbing age is the dead-worker signal.
        $this->assertEquals(34.0, $response->json('cpu.percent'));
        $this->assertSame(300, $response->json('age_seconds'));
        Bus::assertDispatched(SampleMachine::class);
    }

    #[Test]
    public function the_job_writes_the_sample_and_releases_the_claim(): void
    {
        $stats = $this->mock(SystemStats::class);
        $stats->shouldReceive('refresh')->once();

        (new SampleMachine)->handle($stats);
    }

    #[Test]
    public function refreshing_stamps_the_sample_and_frees_the_next_one(): void
    {
        $this->mock(MachineProbe::class)
            ->shouldReceive('read')
            ->andReturn(['cpu_percent' => 7.0, 'memory_used_bytes' => 4, 'memory_total_bytes' => 8]);

        $stats = app(SystemStats::class);

        $this->assertTrue($stats->claim());
        $this->assertFalse($stats->claim(), 'The claim is meant to be exclusive.');

        $stats->refresh();

        $this->assertEquals(7.0, $stats->current()['cpu']['percent']);
        $this->assertSame(0, $stats->current()['age_seconds']);
        $this->assertTrue($stats->claim());
    }

    #[Test]
    public function a_probe_that_fails_leaves_the_last_sample_alone_and_still_frees_the_claim(): void
    {
        $this->mock(MachineProbe::class)->shouldReceive('read')->andReturnNull();

        Cache::forever(SystemStats::SAMPLE_KEY, [
            'cpu_percent' => 34.0,
            'memory_used_bytes' => 8,
            'memory_total_bytes' => 16,
            'sampled_at' => now()->subMinute()->toIso8601String(),
        ]);

        $stats = app(SystemStats::class);
        $stats->claim();
        $stats->refresh();

        // Overwriting with nothing would blank the gauges every time the probe
        // hiccuped; and holding the claim would suppress the retry that is most
        // wanted right after a failure.
        $this->assertEquals(34.0, $stats->current()['cpu']['percent']);
        $this->assertTrue($stats->claim());
    }
}
