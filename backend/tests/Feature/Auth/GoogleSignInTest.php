<?php

namespace Tests\Feature\Auth;

use App\Models\PersonalAccessToken;
use App\Models\SignIn;
use App\Services\Auth\GoogleSignIn;
use App\Services\Owner;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Request as HttpRequest;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

class GoogleSignInTest extends TestCase
{
    use RefreshDatabase;

    protected bool $actsAsOwner = false;

    private const OWNER = 'owner@example.com';

    private const CLIENT = 'client-123.apps.googleusercontent.com';

    private const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

    protected function setUp(): void
    {
        parent::setUp();

        config([
            'services.google.client_id' => self::CLIENT,
            'services.google.client_secret' => 'secret',
            'services.google.redirect' => 'http://localhost:8082/auth/callback',
            'auth.owner_email' => self::OWNER,
        ]);
    }

    public function test_start_hands_back_googles_address_with_pkce(): void
    {
        $url = $this->postJson('/api/auth/google/start')->assertOk()->json('url');

        $this->assertStringStartsWith(GoogleSignIn::AUTHORIZE_URL.'?', $url);
        parse_str((string) parse_url($url, PHP_URL_QUERY), $query);

        $this->assertSame(self::CLIENT, $query['client_id']);
        $this->assertSame('http://localhost:8082/auth/callback', $query['redirect_uri']);
        $this->assertSame('S256', $query['code_challenge_method']);
        $this->assertSame('openid email profile', $query['scope']);
        $this->assertNotEmpty($query['state']);
        $this->assertNotEmpty($query['nonce']);
    }

    public function test_the_owner_signs_in_and_gets_a_token(): void
    {
        [$state, $nonce, $challenge] = $this->begin();
        $this->fakeGoogle(['nonce' => $nonce]);

        $response = $this->withHeader('User-Agent', self::UA)
            ->postJson('/api/auth/google/callback', ['code' => 'the-code', 'state' => $state])
            ->assertOk()
            ->assertJsonPath('user.email', self::OWNER)
            ->assertJsonPath('user.name', 'M C')
            ->assertJsonPath('user.avatar_url', 'https://lh3.example/a.png');

        // The verifier sent to Google is the one whose challenge went out.
        Http::assertSent(function (HttpRequest $request) use ($challenge) {
            return $request->url() === GoogleSignIn::TOKEN_URL
                && GoogleSignIn::challenge($request['code_verifier']) === $challenge
                && $request['code'] === 'the-code'
                && $request['client_secret'] === 'secret';
        });

        $owner = Owner::user()->fresh();
        $this->assertSame('google-sub-1', $owner->google_sub);
        $this->assertNotNull($owner->last_login_at);

        $token = PersonalAccessToken::sole();
        $this->assertSame('Chrome on Windows', $token->name);
        $this->assertSame(self::UA, $token->user_agent);
        $this->assertSame($owner->id, (int) $token->tokenable_id);

        $this->assertSame(SignIn::OK, SignIn::sole()->outcome);

        // And the token opens the gate.
        $this->withToken($response->json('token'))
            ->getJson('/api/auth/me')
            ->assertOk()
            ->assertJsonPath('email', self::OWNER)
            ->assertJsonPath('linked_at', fn ($v) => is_string($v));
    }

    public function test_the_owner_email_matches_whatever_its_case(): void
    {
        [$state, $nonce] = $this->begin();
        $this->fakeGoogle(['nonce' => $nonce, 'email' => 'Owner@Example.com']);

        $this->postJson('/api/auth/google/callback', ['code' => 'c', 'state' => $state])->assertOk();
    }

    public function test_any_other_account_is_refused_and_recorded(): void
    {
        [$state, $nonce] = $this->begin();
        $this->fakeGoogle(['nonce' => $nonce, 'email' => 'someone@example.com', 'sub' => 'other']);

        $this->postJson('/api/auth/google/callback', ['code' => 'c', 'state' => $state])
            ->assertForbidden()
            ->assertJsonPath('reason', 'not_owner')
            ->assertJsonPath('message', 'someone@example.com is not allowed to sign in here.');

        $this->assertSame(0, PersonalAccessToken::count());
        $this->assertNull(Owner::user()->fresh()->google_sub);

        $row = SignIn::sole();
        $this->assertSame(SignIn::REFUSED, $row->outcome);
        $this->assertSame('someone@example.com', $row->email);
    }

    public function test_once_linked_a_different_google_account_on_the_same_address_is_refused(): void
    {
        Owner::user()->forceFill(['google_sub' => 'google-sub-1'])->save();

        [$state, $nonce] = $this->begin();
        $this->fakeGoogle(['nonce' => $nonce, 'sub' => 'google-sub-2']);

        $this->postJson('/api/auth/google/callback', ['code' => 'c', 'state' => $state])
            ->assertForbidden()
            ->assertJsonPath('reason', 'sub_mismatch');

        $this->assertSame('google-sub-1', Owner::user()->fresh()->google_sub);
        $this->assertSame(0, PersonalAccessToken::count());
    }

    public function test_a_state_works_once(): void
    {
        [$state, $nonce] = $this->begin();
        $this->fakeGoogle(['nonce' => $nonce]);

        $this->postJson('/api/auth/google/callback', ['code' => 'c', 'state' => $state])->assertOk();

        $this->postJson('/api/auth/google/callback', ['code' => 'c', 'state' => $state])
            ->assertStatus(400)
            ->assertJsonPath('reason', 'state');

        $this->assertSame(1, PersonalAccessToken::count());
        $this->assertSame([SignIn::OK, SignIn::FAILED], SignIn::orderBy('id')->pluck('outcome')->all());
    }

    public function test_an_unknown_state_never_reaches_google(): void
    {
        Http::fake();

        $this->postJson('/api/auth/google/callback', ['code' => 'c', 'state' => 'made-up'])
            ->assertStatus(400);

        Http::assertNothingSent();
    }

    public function test_an_unverified_email_is_refused(): void
    {
        [$state, $nonce] = $this->begin();
        $this->fakeGoogle(['nonce' => $nonce, 'email_verified' => false]);

        $this->postJson('/api/auth/google/callback', ['code' => 'c', 'state' => $state])
            ->assertForbidden()
            ->assertJsonPath('reason', 'unverified');
    }

    public function test_an_id_token_for_another_client_is_refused(): void
    {
        [$state, $nonce] = $this->begin();
        $this->fakeGoogle(['nonce' => $nonce, 'aud' => 'someone-elses-client']);

        $this->postJson('/api/auth/google/callback', ['code' => 'c', 'state' => $state])
            ->assertStatus(400)
            ->assertJsonPath('reason', 'id_token');
    }

    public function test_a_wrong_nonce_is_refused(): void
    {
        [$state] = $this->begin();
        $this->fakeGoogle(['nonce' => 'not-the-one-we-sent']);

        $this->postJson('/api/auth/google/callback', ['code' => 'c', 'state' => $state])
            ->assertStatus(400)
            ->assertJsonPath('reason', 'id_token');
    }

    public function test_an_expired_id_token_is_refused(): void
    {
        [$state, $nonce] = $this->begin();
        $this->fakeGoogle(['nonce' => $nonce, 'exp' => now()->subMinute()->timestamp]);

        $this->postJson('/api/auth/google/callback', ['code' => 'c', 'state' => $state])
            ->assertStatus(400);
    }

    public function test_a_rejected_code_is_a_sentence_that_quotes_nothing(): void
    {
        [$state] = $this->begin();
        Http::fake([GoogleSignIn::TOKEN_URL => Http::response(['error' => 'invalid_grant', 'error_description' => 'Bad code the-secret-code'], 400)]);

        $response = $this->postJson('/api/auth/google/callback', ['code' => 'the-secret-code', 'state' => $state])
            ->assertStatus(400)
            ->assertJsonPath('reason', 'exchange');

        $this->assertStringNotContainsString('the-secret-code', $response->getContent());
    }

    public function test_no_owner_email_means_nobody_can_sign_in(): void
    {
        config(['auth.owner_email' => null]);

        $this->postJson('/api/auth/google/start')
            ->assertStatus(503)
            ->assertJsonPath('reason', 'unconfigured');
    }

    public function test_a_started_sign_in_expires(): void
    {
        [$state, $nonce] = $this->begin();
        $this->fakeGoogle(['nonce' => $nonce]);

        $this->travel(GoogleSignIn::STATE_TTL + 1)->seconds();

        $this->postJson('/api/auth/google/callback', ['code' => 'c', 'state' => $state])
            ->assertStatus(400)
            ->assertJsonPath('reason', 'state');
    }

    /**
     * Start a sign-in and read back what went into Google's URL.
     *
     * @return array{0: string, 1: string, 2: string} state, nonce, code challenge
     */
    private function begin(): array
    {
        $url = $this->postJson('/api/auth/google/start')->assertOk()->json('url');
        parse_str((string) parse_url($url, PHP_URL_QUERY), $query);

        return [$query['state'], $query['nonce'], $query['code_challenge']];
    }

    /** @param  array<string, mixed>  $claims */
    private function fakeGoogle(array $claims): void
    {
        $claims += [
            'iss' => 'https://accounts.google.com',
            'aud' => self::CLIENT,
            'sub' => 'google-sub-1',
            'email' => self::OWNER,
            'email_verified' => true,
            'name' => 'M C',
            'picture' => 'https://lh3.example/a.png',
            'exp' => now()->addHour()->timestamp,
        ];

        $segment = fn (array $data) => rtrim(strtr(base64_encode(json_encode($data)), '+/', '-_'), '=');

        Http::fake([GoogleSignIn::TOKEN_URL => Http::response([
            'access_token' => 'ya29.x',
            'id_token' => $segment(['alg' => 'RS256']).'.'.$segment($claims).'.signature',
            'token_type' => 'Bearer',
            'expires_in' => 3599,
        ])]);
    }
}
