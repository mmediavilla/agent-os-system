<?php

namespace App\Services\Auth;

use App\Models\SignIn;
use App\Models\User;
use App\Services\Owner;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;

/**
 * Signing the owner in with Google: the authorisation-code flow with PKCE,
 * written out rather than borrowed.
 *
 * Not Socialite: it keeps the flow's state in a session, and this API has none
 * — the app and the API are different sites, so the browser holds a bearer
 * token instead of a cookie. What the flow needs from a session is one value
 * for ten minutes, which is a cache entry keyed by `state`.
 *
 * **Two locks, both on the owner.** The Google account's email must be
 * `auth.owner_email`, and the first success pins the account's `sub` on the
 * owner row, after which the `sub` must match too. The email alone would hand
 * the database to whoever holds that address next; the `sub` alone could not
 * say who may sign in the first time. A refusal still writes a `sign_ins` row,
 * because a refused attempt leaves no token and would otherwise leave nothing.
 *
 * **The id token's signature is not checked**, as Google's own guidance allows:
 * it came straight from Google's token endpoint over TLS, in exchange for a
 * code only this server's secret could redeem, so nothing could have been
 * substituted on the way. Its claims are still checked — issuer, audience,
 * expiry, nonce and a verified email.
 */
class GoogleSignIn
{
    public const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

    public const TOKEN_URL = 'https://oauth2.googleapis.com/token';

    private const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

    /** How long a started sign-in may take before its state is forgotten. */
    public const STATE_TTL = 600;

    /**
     * Where to send the browser to begin.
     *
     * @return array{url: string}
     */
    public function start(): array
    {
        $this->assertConfigured();

        $state = Str::random(40);
        $verifier = Str::random(64);
        $nonce = Str::random(32);

        Cache::put(self::stateKey($state), ['verifier' => $verifier, 'nonce' => $nonce], self::STATE_TTL);

        return ['url' => self::AUTHORIZE_URL.'?'.http_build_query([
            'client_id' => config('services.google.client_id'),
            'redirect_uri' => config('services.google.redirect'),
            'response_type' => 'code',
            'scope' => 'openid email profile',
            'state' => $state,
            'nonce' => $nonce,
            'code_challenge' => self::challenge($verifier),
            'code_challenge_method' => 'S256',
            // Every time, so a browser signed into two Google accounts is asked
            // which one rather than quietly handing over whichever is default.
            'prompt' => 'select_account',
        ], '', '&', PHP_QUERY_RFC3986)];
    }

    /**
     * Finish a sign-in: redeem the code, decide, and issue a token.
     *
     * @return array{token: string, user: User}
     *
     * @throws SignInRefused
     */
    public function complete(string $code, string $state, ?string $ip, ?string $userAgent): array
    {
        $attempt = ['ip' => $ip, 'user_agent' => $userAgent];

        try {
            $this->assertConfigured();

            // Pulled, not read: a state works once, so a callback URL that
            // leaks from a history or a log redeems nothing.
            $pending = Cache::pull(self::stateKey($state));

            if (! is_array($pending)) {
                throw new SignInRefused('That sign-in link has expired or was already used. Start again.', 400, 'state');
            }

            $claims = $this->claims($this->exchange($code, $pending['verifier']), $pending['nonce']);
            $attempt += ['email' => $claims['email'], 'google_sub' => $claims['sub']];

            $user = $this->owner($claims);
        } catch (SignInRefused $refused) {
            SignIn::create($attempt + [
                'outcome' => $refused->status === 403 ? SignIn::REFUSED : SignIn::FAILED,
                'reason' => $refused->reason,
            ]);

            throw $refused;
        }

        $token = $user->createToken(DeviceLabel::from($userAgent));
        $token->accessToken->forceFill(['ip_address' => $ip, 'user_agent' => $userAgent])->save();

        SignIn::create($attempt + ['outcome' => SignIn::OK]);

        return ['token' => $token->plainTextToken, 'user' => $user];
    }

    /** Refuse to start or finish anything while a setting is missing. */
    private function assertConfigured(): void
    {
        foreach (['services.google.client_id', 'services.google.client_secret', 'services.google.redirect', 'auth.owner_email'] as $key) {
            $value = config($key);

            if (! is_string($value) || trim($value) === '') {
                throw new SignInRefused(
                    'Sign-in is not set up on the server. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and AUTH_OWNER_EMAIL in backend/.env.',
                    503,
                    'unconfigured',
                );
            }
        }
    }

    /** Redeem the code for Google's id token. */
    private function exchange(string $code, string $verifier): string
    {
        try {
            $response = Http::asForm()->acceptJson()->timeout(10)->post(self::TOKEN_URL, [
                'grant_type' => 'authorization_code',
                'code' => $code,
                'code_verifier' => $verifier,
                'client_id' => config('services.google.client_id'),
                'client_secret' => config('services.google.client_secret'),
                'redirect_uri' => config('services.google.redirect'),
            ]);
        } catch (ConnectionException) {
            throw new SignInRefused('Google could not be reached. Try again in a moment.', 502, 'unreachable');
        }

        $idToken = $response->json('id_token');

        if (! $response->successful() || ! is_string($idToken)) {
            // Google's own error is not repeated: it can echo the request.
            throw new SignInRefused('Google did not accept that sign-in. Start again.', 400, 'exchange');
        }

        return $idToken;
    }

    /**
     * The id token's claims, once they have been checked.
     *
     * @return array{sub: string, email: string, name: ?string, picture: ?string}
     */
    private function claims(string $idToken, string $nonce): array
    {
        $parts = explode('.', $idToken);
        $claims = count($parts) === 3
            ? json_decode((string) base64_decode(strtr($parts[1], '-_', '+/'), true), true)
            : null;

        $valid = is_array($claims)
            && in_array($claims['iss'] ?? null, self::ISSUERS, true)
            && ($claims['aud'] ?? null) === config('services.google.client_id')
            && is_numeric($claims['exp'] ?? null) && (int) $claims['exp'] > now()->timestamp
            && is_string($claims['nonce'] ?? null) && hash_equals($nonce, $claims['nonce'])
            && is_string($claims['sub'] ?? null) && $claims['sub'] !== ''
            && is_string($claims['email'] ?? null);

        if (! $valid) {
            throw new SignInRefused('Google sent back a sign-in this app could not read. Start again.', 400, 'id_token');
        }

        // A string "true" is what some accounts carry, so both are accepted.
        if (! in_array($claims['email_verified'] ?? false, [true, 'true'], true)) {
            throw new SignInRefused('That Google account has no verified email address.', 403, 'unverified');
        }

        return [
            'sub' => $claims['sub'],
            'email' => $claims['email'],
            'name' => is_string($claims['name'] ?? null) ? $claims['name'] : null,
            'picture' => is_string($claims['picture'] ?? null) ? $claims['picture'] : null,
        ];
    }

    /**
     * The owner row, if these claims are the owner's — pinned and refreshed.
     *
     * @param  array{sub: string, email: string, name: ?string, picture: ?string}  $claims
     */
    private function owner(array $claims): User
    {
        if (strcasecmp(trim((string) config('auth.owner_email')), $claims['email']) !== 0) {
            throw new SignInRefused("{$claims['email']} is not allowed to sign in here.", 403, 'not_owner');
        }

        return DB::transaction(function () use ($claims) {
            $user = Owner::user();

            if ($user->google_sub !== null && ! hash_equals($user->google_sub, $claims['sub'])) {
                throw new SignInRefused(
                    'That address now belongs to a different Google account than the one linked here.',
                    403,
                    'sub_mismatch',
                );
            }

            $user->forceFill([
                'google_sub' => $claims['sub'],
                'email' => $claims['email'],
                'email_verified_at' => $user->email_verified_at ?? now(),
                'name' => $claims['name'] ?? $user->name,
                'avatar_url' => $claims['picture'],
                'last_login_at' => now(),
            ])->save();

            return $user;
        });
    }

    public static function stateKey(string $state): string
    {
        return 'auth.google.state.'.hash('sha256', $state);
    }

    /** PKCE's S256: base64url(sha256(verifier)), unpadded. */
    public static function challenge(string $verifier): string
    {
        return rtrim(strtr(base64_encode(hash('sha256', $verifier, true)), '+/', '-_'), '=');
    }
}
