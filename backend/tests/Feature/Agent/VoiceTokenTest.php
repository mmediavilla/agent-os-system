<?php

namespace Tests\Feature\Agent;

use App\Services\AnthropicSwitch;
use App\Services\Voice\VoiceSessionService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

/**
 * `GET /api/voice/token` — the only part of the spoken conversation this
 * server is in the middle of.
 *
 * The page opens its own WebRTC session straight to ElevenLabs, so the audio
 * never comes through here and neither does the answer. What comes through here
 * is permission: a short-lived conversation token, minted with a key the
 * browser must never see. That is the whole route, and it is why the two things
 * asserted hardest below are that the key does not appear in any response and
 * that a refusal says *why* in words.
 */
class VoiceTokenTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        config()->set('agent.voice.key', 'xi-secret-key');
        config()->set('agent.voice.agent_id', 'agent_life_os');
        config()->set('agent.voice.token_endpoint', 'https://api.elevenlabs.io/v1/convai/conversation/token');
    }

    public function test_it_mints_a_token_for_the_configured_agent(): void
    {
        Http::fake([
            'api.elevenlabs.io/*' => Http::response(['token' => 'tok_abc123']),
        ]);

        $this->getJson('/api/voice/token')
            ->assertOk()
            ->assertExactJson(['token' => 'tok_abc123']);

        Http::assertSent(function ($request) {
            return $request->hasHeader('xi-api-key', 'xi-secret-key')
                && str_contains($request->url(), 'agent_id=agent_life_os');
        });
    }

    public function test_the_api_key_never_reaches_the_browser(): void
    {
        Http::fake([
            // A body carrying the key back would be the obvious way to leak it,
            // and an upstream that echoed its own request is not far-fetched.
            'api.elevenlabs.io/*' => Http::response(['token' => 'tok_abc123', 'key' => 'xi-secret-key']),
        ]);

        $body = $this->getJson('/api/voice/token')->assertOk()->content();

        $this->assertStringNotContainsString('xi-secret-key', $body);
    }

    public function test_it_refuses_while_the_anthropic_switch_is_off(): void
    {
        Http::fake();
        AnthropicSwitch::set(false);

        $this->getJson('/api/voice/token')
            ->assertStatus(503)
            ->assertJsonPath('reason', 'disabled');

        // The point of gating here rather than at the first spoken question:
        // nothing is opened, so there is no session to 503 into.
        Http::assertNothingSent();
    }

    public function test_an_unset_key_says_which_setting_is_missing(): void
    {
        Http::fake();
        config()->set('agent.voice.key', null);

        $this->getJson('/api/voice/token')
            ->assertStatus(503)
            ->assertJsonPath('reason', 'unconfigured')
            ->assertJsonPath('message', fn (string $m) => str_contains($m, 'ELEVENLABS_API_KEY'));

        Http::assertNothingSent();
    }

    public function test_a_key_with_no_agent_behind_it_is_told_apart_from_no_key(): void
    {
        Http::fake();
        config()->set('agent.voice.agent_id', '');

        $this->getJson('/api/voice/token')
            ->assertStatus(503)
            ->assertJsonPath('reason', 'no_agent')
            ->assertJsonPath('message', fn (string $m) => str_contains($m, 'ELEVENLABS_AGENT_ID'));
    }

    /**
     * The failure this project actually hit: a real key, authenticated, and
     * without `convai_write` on it. A "401" would send somebody looking for a
     * bad key; the body says which permission is missing, so it is repeated.
     */
    public function test_a_key_missing_the_convai_scope_says_so(): void
    {
        Http::fake([
            'api.elevenlabs.io/*' => Http::response([
                'detail' => [
                    'status' => 'missing_permissions',
                    'message' => 'The API key you used is missing the permission convai_write to execute this operation.',
                ],
            ], 401),
        ]);

        $this->getJson('/api/voice/token')
            ->assertStatus(503)
            ->assertJsonPath('reason', 'upstream')
            ->assertJsonPath('message', VoiceSessionService::SCOPE_HINT);
    }

    public function test_an_unknown_agent_id_is_reported_as_such(): void
    {
        Http::fake([
            'api.elevenlabs.io/*' => Http::response(['detail' => 'not found'], 404),
        ]);

        $this->getJson('/api/voice/token')
            ->assertStatus(503)
            ->assertJsonPath('reason', 'upstream')
            ->assertJsonPath('message', fn (string $m) => str_contains($m, 'agent id'));
    }

    /**
     * A 200 with nothing usable in it is not a success. It is worth telling
     * apart from an outage because it means their contract moved, not that
     * their service is down.
     */
    public function test_a_successful_call_with_no_token_in_it_is_a_failure(): void
    {
        Http::fake([
            'api.elevenlabs.io/*' => Http::response(['ok' => true]),
        ]);

        $this->getJson('/api/voice/token')
            ->assertStatus(503)
            ->assertJsonPath('reason', 'upstream');
    }

    public function test_an_unreachable_service_is_reported_rather_than_thrown(): void
    {
        Http::fake(function () {
            throw new ConnectionException('cURL error 6: could not resolve host');
        });

        $this->getJson('/api/voice/token')
            ->assertStatus(503)
            ->assertJsonPath('reason', 'upstream');
    }
}
