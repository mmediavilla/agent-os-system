<?php

namespace App\Jobs;

use App\Services\System\Heartbeat;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;

/**
 * The queue worker proving it is alive, once a minute.
 *
 * Counting rows in the `jobs` table would have been cheaper and would have
 * answered a different question: a backlog of zero is what both a healthy
 * worker and a dead one produce on an idle machine. Only a job that actually
 * ran says the worker ran it, so the check is a round trip through the same
 * path a real job takes — dispatched by the scheduler, executed by the worker,
 * observed as a timestamp.
 *
 * One attempt, because a heartbeat that needs retrying has already told the
 * truth: this minute did not beat.
 */
class RecordQueueHeartbeat implements ShouldQueue
{
    use Queueable;

    public int $tries = 1;

    public function handle(): void
    {
        Heartbeat::beat(Heartbeat::QUEUE);
    }
}
