<?php

namespace App\Http\Controllers;

use App\Jobs\SampleMachine;
use App\Services\System\SystemStats;
use Illuminate\Http\JsonResponse;

/**
 * GET /api/system/stats
 *
 * Answers from the last sample and queues the next one. It never probes, which
 * is what makes it safe to poll from a screen that is open all day — see
 * `SystemStats` for why a reading costs half a second on Windows and why that
 * price is paid on a worker instead.
 */
class SystemStatsController extends Controller
{
    public function __invoke(SystemStats $stats): JsonResponse
    {
        // Claimed atomically, so a HUD polling against a dead queue worker
        // queues one job rather than one per poll.
        if ($stats->stale() && $stats->claim()) {
            SampleMachine::dispatch();
        }

        return response()->json($stats->current());
    }
}
