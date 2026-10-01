<?php

namespace App\Http\Controllers;

use App\Services\Voice\VoiceCredits;
use Illuminate\Http\JsonResponse;

/**
 * GET /api/voice/credits
 *
 * What is left of the ElevenLabs plan, for Assistant → Settings' Voice card.
 * Read on arrival, never polled. Always 200: `unconfigured` and `unavailable`
 * are states of the card with a sentence, the weather's rule — the card is the
 * place the sentence is read, and a 503 would put it in an error banner.
 *
 * Not gated by the Anthropic switch: reading a balance spends nothing, and it
 * is exactly what someone checks while the assistant is switched off.
 */
class VoiceCreditsController extends Controller
{
    public function __invoke(VoiceCredits $credits): JsonResponse
    {
        return response()->json($credits->read());
    }
}
