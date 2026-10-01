<?php

namespace App\Http\Controllers;

use App\Services\Weather\WeatherService;
use Illuminate\Http\JsonResponse;

/**
 * GET /api/weather
 *
 * Always 200. Unconfigured and unavailable are states of the panel rather than
 * failures of the request — a 503 here would make an unset latitude look like a
 * broken server, and would put an error banner over a HUD that is otherwise
 * working perfectly.
 */
class WeatherController extends Controller
{
    public function __invoke(WeatherService $weather): JsonResponse
    {
        return response()->json($weather->current());
    }
}
