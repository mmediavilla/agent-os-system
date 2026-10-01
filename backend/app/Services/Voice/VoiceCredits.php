<?php

namespace App\Services\Voice;

use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Throwable;

/**
 * How much of the ElevenLabs plan is left, read from the account itself.
 *
 * Voice is billed by the minute against a monthly character allowance, and the
 * only sign the app had of it running out was a call cut halfway through an
 * answer. ElevenLabs reports the allowance (`/v1/user/subscription`: used,
 * limit, next reset), so this reads it and says it in numbers.
 *
 * **Cached like the weather**: ten minutes after a success, one after a
 * failure, so an open settings tab and a diagnosis in the same minute cost one
 * upstream call, and an outage is not a retry loop. A cache flush only costs a
 * fresh read — unlike `AnthropicCredit`, nothing here is a fact only a failed
 * call could prove.
 *
 * **Its own permission.** The key minting session tokens needs `convai_write`;
 * reading the subscription needs `user_read`. A key made for voice alone
 * authenticates and is refused here, and the sentence says which permission to
 * add rather than "unavailable".
 */
final class VoiceCredits
{
    public const CACHE_KEY = 'voice.credits';

    public const SCOPE_HINT = 'The ElevenLabs key is missing the user_read permission, so credits cannot be read — add it to the key in the dashboard.';

    /**
     * @return array{state: string, used: int|null, limit: int|null, remaining: int|null, resets_at: string|null, tier: string|null, message: string|null, checked_at: string}
     */
    public function read(): array
    {
        $key = (string) config('agent.voice.key');

        if ($key === '') {
            // Not cached: there is nothing to ask, and the answer changes the
            // moment the key is set rather than ten minutes later.
            return $this->result('unconfigured', message: 'Set ELEVENLABS_API_KEY to see voice credits.');
        }

        $cached = Cache::get(self::CACHE_KEY);

        if (is_array($cached)) {
            return $cached;
        }

        $result = $this->fetch($key);

        Cache::put(
            self::CACHE_KEY,
            $result,
            $result['state'] === 'available'
                ? (int) config('agent.voice.credits_ttl', 600)
                : (int) config('agent.voice.credits_failure_ttl', 60),
        );

        return $result;
    }

    /** @return array{state: string, used: int|null, limit: int|null, remaining: int|null, resets_at: string|null, tier: string|null, message: string|null, checked_at: string} */
    private function fetch(string $key): array
    {
        try {
            $response = Http::withHeaders(['xi-api-key' => $key])
                ->timeout(max(1, (int) config('agent.voice.token_timeout', 8)))
                ->get((string) config('agent.voice.subscription_endpoint'));
        } catch (Throwable) {
            // The exception's own text names the URL and nothing more useful;
            // the sentence is ours, as the calendar's are.
            return $this->result('unavailable', message: 'Could not reach ElevenLabs to read credits.');
        }

        if (! $response->successful()) {
            $body = (string) $response->body();

            return $this->result('unavailable', message: match (true) {
                str_contains($body, 'user_read') => self::SCOPE_HINT,
                $response->status() === 401 || $response->status() === 403 => 'ElevenLabs refused the API key when asked for credits.',
                default => "ElevenLabs answered {$response->status()} when asked for credits.",
            });
        }

        $used = $response->json('character_count');
        $limit = $response->json('character_limit');

        // A body without the two numbers is a change at their end, and a zero
        // drawn from a missing field would read as an empty account.
        if (! is_int($used) || ! is_int($limit)) {
            return $this->result('unavailable', message: 'ElevenLabs answered without a credit balance.');
        }

        $reset = $response->json('next_character_count_reset_unix');
        $tier = $response->json('tier');

        return $this->result(
            'available',
            used: $used,
            limit: $limit,
            remaining: max(0, $limit - $used),
            resetsAt: is_int($reset) ? CarbonImmutable::createFromTimestamp($reset)->toIso8601String() : null,
            tier: is_string($tier) ? $tier : null,
        );
    }

    /** @return array{state: string, used: int|null, limit: int|null, remaining: int|null, resets_at: string|null, tier: string|null, message: string|null, checked_at: string} */
    private function result(
        string $state,
        ?int $used = null,
        ?int $limit = null,
        ?int $remaining = null,
        ?string $resetsAt = null,
        ?string $tier = null,
        ?string $message = null,
    ): array {
        return [
            'state' => $state,
            'used' => $used,
            'limit' => $limit,
            'remaining' => $remaining,
            'resets_at' => $resetsAt,
            'tier' => $tier,
            'message' => $message,
            'checked_at' => CarbonImmutable::now()->toIso8601String(),
        ];
    }
}
