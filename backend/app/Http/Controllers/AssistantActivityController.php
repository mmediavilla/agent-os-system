<?php

namespace App\Http\Controllers;

use App\Services\AssistantActivity;
use Illuminate\Http\JsonResponse;

/**
 * GET /api/assistant/activity
 *
 * What Assistant → Activity shows: the threads, messages, insights and frames
 * the assistant keeps, and what it did over the last week. Read-only by
 * design — nothing here writes or calls a model, which is what makes it safe to
 * poll while the tab is open. See `AssistantActivity`.
 */
class AssistantActivityController extends Controller
{
    public function __invoke(AssistantActivity $activity): JsonResponse
    {
        return response()->json($activity->current());
    }
}
