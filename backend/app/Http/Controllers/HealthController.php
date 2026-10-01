<?php

namespace App\Http\Controllers;

use App\Services\System\Health;
use App\Services\System\Heartbeat;
use Carbon\CarbonImmutable;
use Illuminate\Http\JsonResponse;

/**
 * GET /api/health — the four things this app needs to be working, and whether
 * they are.
 *
 * This is not `/up`. Laravel's health route answers "did the framework boot",
 * which is already implied by anything answering at all; the interesting
 * failures on this machine are the ones that boot fine and then do nothing.
 *
 * **The queue worker and the scheduler cannot be asked**, so they are made to
 * prove it — see `Heartbeat`. Backlog would have been the obvious queue check
 * and it answers a different question: zero pending jobs is what a healthy
 * worker and a dead one both produce on an idle machine. It is reported
 * alongside anyway, because a heartbeat that is fresh *and* a backlog that is
 * growing is a worker that is alive and stuck, which looks like health from
 * either number alone.
 *
 * **The assistant is reported as configured, not as reachable.** Checking would
 * mean a paid round trip to Anthropic on every poll of a panel; a missing key
 * is the failure that actually happens, and it is free to see.
 *
 * The readings themselves are `Services\System\Health`'s, which the
 * diagnostics read as well. `ok` is the whole services list collapsed to one
 * boolean, because the chrome bar has room for a pill and not for four rows.
 */
class HealthController extends Controller
{
    public function __invoke(): JsonResponse
    {
        $database = Health::database();
        $queue = Health::heartbeat(Heartbeat::QUEUE) + Health::backlog();
        $scheduler = Health::heartbeat(Heartbeat::SCHEDULER);
        $assistant = Health::assistant();

        return response()->json([
            // `off` does not spoil `ok`, and that is the point of it being its
            // own state: the pill says whether something is *wrong*, and an
            // assistant the user switched off is working exactly as asked.
            // Saying DEGRADED there would teach the pill to be ignored.
            'ok' => $database['state'] === 'up'
                && $queue['state'] !== 'down'
                && $scheduler['state'] !== 'down'
                && $assistant['state'] !== 'down',
            'checked_at' => CarbonImmutable::now()->toIso8601String(),
            'database' => $database,
            'queue' => $queue,
            'scheduler' => $scheduler,
            'assistant' => $assistant,
        ]);
    }
}
