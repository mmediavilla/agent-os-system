<?php

namespace App\Jobs;

use App\Services\System\SystemStats;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;

/**
 * Take one reading of CPU and memory, off the request thread.
 *
 * Queued for latency, not for size: the work is a subprocess that takes about
 * half a second on Windows, and the endpoint that wants the answer is polled
 * for as long as someone leaves the HUD open. `SystemStats` explains the split.
 *
 * One attempt. A reading that failed is worth nothing a few seconds later —
 * the next poll queues another — and retrying a subprocess that timed out is
 * the fastest way to hold a worker hostage to a machine that is already busy.
 */
class SampleMachine implements ShouldQueue
{
    use Queueable;

    public int $tries = 1;

    public function handle(SystemStats $stats): void
    {
        $stats->refresh();
    }
}
