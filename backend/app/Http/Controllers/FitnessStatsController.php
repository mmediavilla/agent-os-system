<?php

namespace App\Http\Controllers;

use App\Services\FitnessStatsService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class FitnessStatsController extends Controller
{
    public function __construct(private readonly FitnessStatsService $stats) {}

    /**
     * GET /api/fitness/stats
     *
     * One endpoint rather than one per panel: every panel shares the same window
     * and the same base joins, so splitting them would multiply latency and let
     * panels disagree while a range change was in flight.
     */
    public function index(Request $request): JsonResponse
    {
        $data = $request->validate([
            'range' => ['nullable', 'string', 'in:auto,4w,12w,1y,all'],
        ]);

        return response()->json($this->stats->build($data['range'] ?? 'auto'));
    }
}
