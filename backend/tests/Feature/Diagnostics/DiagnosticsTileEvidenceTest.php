<?php

namespace Tests\Feature\Diagnostics;

use App\Models\Setting;
use App\Services\Diagnostics\Checks\AssistantChecks;
use App\Services\Diagnostics\Checks\CalendarChecks;
use App\Services\Diagnostics\Checks\DatabaseChecks;
use App\Services\Diagnostics\Checks\QueueChecks;
use App\Services\Diagnostics\Checks\SchedulerChecks;
use App\Services\Diagnostics\Finding;
use App\Services\System\Heartbeat;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Process;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

/**
 * The evidence lines Stats' vitals tiles read, pinned on every branch.
 *
 * Five of the eight tiles take their value from one finding's evidence
 * (`app/src/diagnostics.ts`, `reportTiles`), matched on its `label: ` prefix.
 * The client cannot see a label renamed here — it would quietly draw a dash
 * — so the contract is held on this side, where the rename would happen.
 */
class DiagnosticsTileEvidenceTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        Process::fake();
    }

    #[Test]
    public function the_database_tile_reads_its_size_when_the_database_is_a_file(): void
    {
        // The suite's `:memory:` database is not a file and has no size, which
        // the tile rightly draws as a dash; the live database is one, so the
        // check is pointed at a real file for this.
        $path = tempnam(sys_get_temp_dir(), 'pmc-tile');
        config(['database.connections.tile_file' => ['driver' => 'sqlite', 'database' => $path, 'prefix' => '']]);
        $default = DB::getDefaultConnection();
        DB::setDefaultConnection('tile_file');

        try {
            $this->assertHasLabel($this->finding(DatabaseChecks::class, 'database.files'), 'size');
        } finally {
            DB::setDefaultConnection($default);
            DB::purge('tile_file');
            @unlink($path);
        }
    }

    #[Test]
    public function the_worker_and_scheduler_tiles_read_a_beat_whether_it_is_fresh_late_or_never(): void
    {
        $tiles = [
            [QueueChecks::class, 'queue.heartbeat', Heartbeat::QUEUE, 'last beat'],
            [SchedulerChecks::class, 'scheduler.heartbeat', Heartbeat::SCHEDULER, 'last tick'],
        ];

        foreach ($tiles as [$class, $key, $cache, $label]) {
            Cache::forget($cache);
            $this->assertHasLabel($this->finding($class, $key), $label, 'never beaten');

            Cache::forever($cache, now()->subMinutes(10)->toIso8601String());
            $this->assertHasLabel($this->finding($class, $key), $label, 'late');

            Heartbeat::beat($cache);
            $this->assertHasLabel($this->finding($class, $key), $label, 'fresh');
        }
    }

    #[Test]
    public function the_assistant_tile_reads_the_switch_either_way(): void
    {
        foreach ([true, false] as $on) {
            Setting::put('anthropic.enabled', $on);
            $this->assertHasLabel($this->finding(AssistantChecks::class, 'assistant.switch'), 'switch');
        }
    }

    #[Test]
    public function the_calendars_tile_knows_none_connected_by_its_key(): void
    {
        // Not an evidence label: the tile draws "none" when this key is the
        // group's only finding, and counts feeds otherwise.
        $this->assertNotNull($this->finding(CalendarChecks::class, 'calendar.feeds'));
    }

    private function assertHasLabel(?Finding $finding, string $label, string $case = ''): void
    {
        $this->assertNotNull($finding);
        $this->assertNotEmpty(
            array_filter($finding->evidence, fn (string $line) => str_starts_with($line, "{$label}: ")),
            "{$finding->key} ({$case}) lost its '{$label}:' evidence line, which a Stats tile reads.",
        );
    }

    /**
     * @param  class-string  $class
     */
    private function finding(string $class, string $key): ?Finding
    {
        return collect(app($class)->run())->firstWhere('key', $key);
    }
}
