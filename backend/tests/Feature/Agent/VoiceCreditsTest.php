<?php

namespace Tests\Feature\Agent;

use App\Services\AnthropicSwitch;
use App\Services\Diagnostics\Checks\AssistantChecks;
use App\Services\Diagnostics\Severity;
use App\Services\Voice\VoiceCredits;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

/**
 * `GET /api/voice/credits` — what is left of the ElevenLabs plan, in numbers.
 *
 * Always a 200 with a state, the weather's rule, because the Voice card is
 * where the sentence is read. The key is asserted never to leave, as on the
 * token route beside it.
 */
class VoiceCreditsTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        config()->set('agent.voice.key', 'xi-secret-key');
        config()->set('agent.voice.subscription_endpoint', 'https://api.elevenlabs.io/v1/user/subscription');
        Cache::forget(VoiceCredits::CACHE_KEY);
    }

    public function test_it_reads_used_limit_and_reset_off_the_subscription(): void
    {
        Http::fake(['api.elevenlabs.io/*' => Http::response(self::subscription(used: 22_500, limit: 30_000))]);

        $response = $this->getJson('/api/voice/credits')
            ->assertOk()
            ->assertJsonPath('state', 'available')
            ->assertJsonPath('used', 22_500)
            ->assertJsonPath('limit', 30_000)
            ->assertJsonPath('remaining', 7_500)
            ->assertJsonPath('tier', 'starter')
            ->assertJsonPath('message', null);

        $this->assertStringStartsWith('2026-10-14T', (string) $response->json('resets_at'));
        $this->assertStringNotContainsString('xi-secret-key', $response->getContent());

        Http::assertSent(fn ($request) => $request->hasHeader('xi-api-key', 'xi-secret-key')
            && $request->url() === 'https://api.elevenlabs.io/v1/user/subscription');
    }

    public function test_a_reading_is_cached_so_the_card_and_diagnose_cost_one_call(): void
    {
        Http::fake(['api.elevenlabs.io/*' => Http::response(self::subscription())]);

        $this->getJson('/api/voice/credits')->assertOk();
        $this->getJson('/api/voice/credits')->assertOk();
        app(VoiceCredits::class)->read();

        Http::assertSentCount(1);
    }

    public function test_used_past_the_limit_is_zero_left_not_negative(): void
    {
        Http::fake(['api.elevenlabs.io/*' => Http::response(self::subscription(used: 31_000, limit: 30_000))]);

        $this->getJson('/api/voice/credits')->assertJsonPath('remaining', 0);
    }

    public function test_no_key_is_unconfigured_and_asks_nothing(): void
    {
        config()->set('agent.voice.key', null);
        Http::fake();

        $this->getJson('/api/voice/credits')
            ->assertOk()
            ->assertJsonPath('state', 'unconfigured')
            ->assertJsonPath('remaining', null);

        Http::assertNothingSent();
    }

    public function test_a_key_without_user_read_names_the_permission(): void
    {
        Http::fake(['api.elevenlabs.io/*' => Http::response([
            'detail' => ['status' => 'missing_permissions', 'message' => 'The API key you used is missing the permission user_read to execute this operation.'],
        ], 401)]);

        $this->getJson('/api/voice/credits')
            ->assertOk()
            ->assertJsonPath('state', 'unavailable')
            ->assertJsonPath('message', VoiceCredits::SCOPE_HINT);
    }

    public function test_an_unreachable_elevenlabs_is_a_sentence_without_the_url(): void
    {
        Http::fake(fn () => throw new ConnectionException('cURL error 6: Could not resolve host api.elevenlabs.io'));

        $response = $this->getJson('/api/voice/credits')
            ->assertOk()
            ->assertJsonPath('state', 'unavailable');

        $this->assertStringNotContainsString('api.elevenlabs.io', (string) $response->json('message'));
    }

    public function test_a_body_without_the_numbers_is_not_read_as_empty(): void
    {
        Http::fake(['api.elevenlabs.io/*' => Http::response(['tier' => 'starter'])]);

        $this->getJson('/api/voice/credits')
            ->assertJsonPath('state', 'unavailable')
            ->assertJsonPath('remaining', null);
    }

    public function test_the_anthropic_switch_does_not_hide_the_balance(): void
    {
        AnthropicSwitch::set(false);
        Http::fake(['api.elevenlabs.io/*' => Http::response(self::subscription())]);

        $this->getJson('/api/voice/credits')->assertOk()->assertJsonPath('state', 'available');
    }

    public function test_diagnose_warns_when_low_and_calls_empty_a_problem(): void
    {
        $used = 0;
        // One fake reading a variable: a second `Http::fake` would stack
        // behind the first and never answer.
        Http::fake(function () use (&$used) {
            return Http::response(self::subscription(used: $used, limit: 30_000));
        });

        $finding = function (int $now) use (&$used): ?object {
            $used = $now;
            Cache::forget(VoiceCredits::CACHE_KEY);

            return collect((new AssistantChecks)->run())->firstWhere('key', 'assistant.voice_credits');
        };

        $this->assertSame(Severity::Ok, $finding(10_000)->severity);
        $this->assertSame(Severity::Warn, $finding(28_000)->severity);

        $empty = $finding(30_000);
        $this->assertSame(Severity::Problem, $empty->severity);
        $this->assertContains('voice credits: 0 of 30,000 left', $empty->evidence);
    }

    /** @return array<string, mixed> */
    private static function subscription(int $used = 1_000, int $limit = 30_000): array
    {
        return [
            'tier' => 'starter',
            'character_count' => $used,
            'character_limit' => $limit,
            // 2026-10-14T00:00:00Z
            'next_character_count_reset_unix' => 1_791_936_000,
            'status' => 'active',
        ];
    }
}
