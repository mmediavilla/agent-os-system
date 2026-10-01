<?php

namespace App\Services\Voice;

use Illuminate\Support\Facades\Http;
use Throwable;

/**
 * The one thing this side of the spoken conversation owns: the credential.
 *
 * ElevenLabs runs the agent — speech to text, text to speech, turn-taking — and
 * the page talks to it directly over WebRTC. That is the whole point of the
 * client-tool architecture: nothing of ours is exposed, no tunnel exists, and
 * the audio never passes through Laravel. What the page cannot be trusted with
 * is the API key: every `EXPO_PUBLIC_*` value is inlined into the web bundle,
 * so a key the page could send is a key anyone who loads `projectmc-app.test`
 * can read.
 *
 * So this mints a **conversation token**: short-lived, scoped to one session
 * with one agent, and useless for anything else on the account. The browser
 * gets that and never the key.
 *
 * **A refusal here is not a state to shrug at.** There is no floor under it —
 * the old text-to-speech proxy fell back to the browser's own voice, and this
 * has nothing to fall back to: without a token there is no session, and the
 * Talk button did nothing. The reason has to reach the person who pressed it,
 * which is why every path here carries a sentence and why the controller does
 * not pretend a failure was a success.
 */
final class VoiceSessionService
{
    /** What a key without `convai_write` on it looks like from here. */
    public const SCOPE_HINT = 'The ElevenLabs key is missing the convai_write permission — add it to the key in the dashboard.';

    /**
     * A token for one session, or the reason there is not one.
     *
     * @return array{ok: true, token: string}|array{ok: false, reason: string, message: string}
     */
    public function token(): array
    {
        $key = (string) config('agent.voice.key');
        $agent = (string) config('agent.voice.agent_id');

        // Named separately rather than collapsed into "unconfigured", because
        // they are two different pieces of setup with two different fixes and
        // the second is the one somebody has just done half of: a key is copied
        // once and an agent is created afterwards.
        if ($key === '') {
            return $this->refuse('unconfigured', 'Set ELEVENLABS_API_KEY to talk to the assistant.');
        }

        if ($agent === '') {
            return $this->refuse('no_agent', 'Set ELEVENLABS_AGENT_ID to the id of the Life OS agent.');
        }

        try {
            $response = Http::withHeaders(['xi-api-key' => $key])
                ->timeout(max(1, (int) config('agent.voice.token_timeout', 8)))
                ->get((string) config('agent.voice.token_endpoint'), ['agent_id' => $agent]);
        } catch (Throwable $e) {
            return $this->refuse('upstream', 'Could not reach ElevenLabs: '.$e->getMessage());
        }

        if (! $response->successful()) {
            return $this->refuse('upstream', $this->reason($response->status(), (string) $response->body()));
        }

        // The field has been `token` throughout, but a body that parsed and
        // carried nothing usable is worth telling apart from one that failed:
        // the first is a change at their end and the second is an outage.
        $token = $response->json('token');

        if (! is_string($token) || $token === '') {
            return $this->refuse('upstream', 'ElevenLabs returned no session token.');
        }

        return ['ok' => true, 'token' => $token];
    }

    /**
     * Why the call was refused, in a sentence rather than a status code.
     *
     * A 401 here is almost never a wrong key — it is a *right* key without
     * `convai_write` on it, which is what a key made for text-to-speech looks
     * like, and the body says so where the status code cannot. Passing that
     * through is the difference between "add a permission" and an afternoon
     * spent believing the feature is broken.
     */
    private function reason(int $status, string $body): string
    {
        if (str_contains($body, 'convai_write')) {
            return self::SCOPE_HINT;
        }

        return match (true) {
            $status === 401 || $status === 403 => 'ElevenLabs refused the API key.',
            $status === 404 => 'ElevenLabs does not know that agent id.',
            $status === 429 => 'ElevenLabs is rate limiting this account.',
            default => "ElevenLabs answered {$status}.",
        };
    }

    /** @return array{ok: false, reason: string, message: string} */
    private function refuse(string $reason, string $message): array
    {
        return ['ok' => false, 'reason' => $reason, 'message' => $message];
    }
}
