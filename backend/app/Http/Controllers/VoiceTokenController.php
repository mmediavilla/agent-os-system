<?php

namespace App\Http\Controllers;

use App\Services\AnthropicSwitch;
use App\Services\Exceptions\AnthropicDisabled;
use App\Services\Voice\VoiceSessionService;
use Illuminate\Http\JsonResponse;

/**
 * GET /api/voice/token
 *
 * Hands the page a short-lived token for one ElevenLabs session, and exists so
 * that the key does not have to be handed over instead: Expo inlines every
 * `EXPO_PUBLIC_*` value into the web bundle, so anything the page can send is
 * something anyone who loads the app can read.
 *
 * **Gated by the Anthropic switch, which is not obviously its business.** No
 * Anthropic call happens here — this mints an ElevenLabs token. But a session
 * exists to ask questions, every one of those questions runs the tool loop at
 * `POST /api/voice/turn`, and that is gated. Refusing to mint the token is how
 * the switch stops a session *starting* rather than letting one open, connect,
 * and 503 on the first thing said out loud. The switch has to mean the same for
 * voice as for typing or the `AI OFF` chip in the chrome bar is a lie.
 *
 * **A refusal is a refusal here**, unlike the text-to-speech proxy this
 * replaced, which answered 200 whatever happened because the browser's own
 * voice was a floor under it. There is no floor under this one: with no token
 * there is no session at all, so the reason has
 * to arrive somewhere the person who pressed Talk can see it. It goes in the
 * body, with a `reason` beside it, and the button puts the sentence on screen.
 *
 * **No conversation id is minted here**, though the plan for this phase called
 * for one. A thread would then be created every time Talk was pressed, whether
 * or not anything was ever said into it, and the app would collect empty
 * threads at the rate of a button. The turn endpoint already creates one lazily
 * and returns its id in the first answer, which is a thread with a question in
 * it — so the client adopts that instead.
 */
class VoiceTokenController extends Controller
{
    public function __invoke(VoiceSessionService $sessions): JsonResponse
    {
        if (! AnthropicSwitch::enabled()) {
            return response()->json([
                'reason' => 'disabled',
                'message' => AnthropicDisabled::MESSAGE,
            ], 503);
        }

        $result = $sessions->token();

        if ($result['ok'] === false) {
            // 503 for every one of them: unconfigured, no agent, and an
            // upstream failure are all "the service is not available to you
            // right now", and the client's behaviour is identical — say the
            // sentence, stay disconnected. `reason` is what tells them apart
            // for anyone reading a log, and the message is what a person reads.
            return response()->json([
                'reason' => $result['reason'],
                'message' => $result['message'],
            ], 503);
        }

        return response()->json(['token' => $result['token']]);
    }
}
