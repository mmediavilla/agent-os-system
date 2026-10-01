<?php

namespace App\Http\Controllers;

use App\Models\PersonalAccessToken;
use App\Models\SignIn;
use App\Models\User;
use App\Services\Auth\GoogleSignIn;
use App\Services\Auth\SignInRefused;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;
use Illuminate\Validation\ValidationException;

/**
 * Signing in, and the account behind it.
 *
 * `start` and `callback` are the only routes here outside the gate. Everything
 * else reads or ends the owner's own sessions, and Profile (14.2) is its screen.
 */
class AuthController extends Controller
{
    /** How many sign-in attempts Profile lists. */
    public const HISTORY = 20;

    public function __construct(private readonly GoogleSignIn $google) {}

    /** POST /api/auth/google/start → { url } */
    public function start(): JsonResponse
    {
        try {
            return response()->json($this->google->start());
        } catch (SignInRefused $refused) {
            return $this->refusal($refused);
        }
    }

    /** POST /api/auth/google/callback { code, state } → { token, user } */
    public function callback(Request $request): JsonResponse
    {
        $data = $request->validate([
            'code' => ['required', 'string', 'max:2048'],
            'state' => ['required', 'string', 'max:128'],
        ]);

        try {
            $result = $this->google->complete($data['code'], $data['state'], $request->ip(), $request->userAgent());
        } catch (SignInRefused $refused) {
            return $this->refusal($refused);
        }

        return response()->json([
            'token' => $result['token'],
            'user' => $this->user($result['user']),
        ]);
    }

    /** GET /api/auth/me */
    public function me(Request $request): JsonResponse
    {
        return response()->json($this->user($request->user()));
    }

    /** GET /api/auth/sessions — every signed-in browser, this one marked. */
    public function sessions(Request $request): JsonResponse
    {
        $current = $this->currentTokenId($request);
        $minutes = config('sanctum.expiration');

        $sessions = $request->user()->tokens()
            ->orderByDesc('last_used_at')->orderByDesc('id')
            ->get()
            ->map(fn (PersonalAccessToken $token) => [
                'id' => $token->id,
                'name' => $token->name,
                'ip_address' => $token->ip_address,
                'user_agent' => $token->user_agent,
                'created_at' => $token->created_at?->toIso8601String(),
                'last_used_at' => $token->last_used_at?->toIso8601String(),
                'expires_at' => $minutes ? $token->created_at?->copy()->addMinutes($minutes)->toIso8601String() : null,
                'current' => $token->id === $current,
            ]);

        return response()->json(['data' => $sessions->values()]);
    }

    /**
     * DELETE /api/auth/sessions/{id}, or DELETE /api/auth/sessions?others=1.
     *
     * The bulk form needs `others` spelled out, so a client that drops an id
     * signs out one browser rather than all of them.
     */
    public function revoke(Request $request, ?string $token = null): JsonResponse
    {
        $tokens = $request->user()->tokens();

        if ($token === null) {
            if (! $request->boolean('others')) {
                throw ValidationException::withMessages(['others' => 'Name a session, or pass others=1 to sign out every other browser.']);
            }

            $revoked = $tokens->whereKeyNot($this->currentTokenId($request) ?? 0)->delete();

            return response()->json(['revoked' => $revoked]);
        }

        abort_unless(ctype_digit($token) && $tokens->whereKey((int) $token)->delete() > 0, 404);

        return response()->json(['revoked' => 1]);
    }

    /** POST /api/auth/logout — ends this browser's session and nothing else. */
    public function logout(Request $request): JsonResponse
    {
        $id = $this->currentTokenId($request);

        if ($id !== null) {
            $request->user()->tokens()->whereKey($id)->delete();
        }

        return response()->json(['signed_out' => true]);
    }

    /** GET /api/auth/sign-ins — the latest attempts, refusals included. */
    public function signIns(): JsonResponse
    {
        $rows = SignIn::query()
            ->orderByDesc('created_at')->orderByDesc('id')
            ->limit(self::HISTORY)
            ->get()
            ->map(fn (SignIn $row) => [
                'id' => $row->id,
                'email' => $row->email,
                'outcome' => $row->outcome,
                'reason' => $row->reason,
                'ip' => $row->ip,
                'user_agent' => $row->user_agent,
                'created_at' => $row->created_at?->toIso8601String(),
            ]);

        return response()->json(['data' => $rows->values()]);
    }

    /** @return array<string, mixed> */
    private function user(User $user): array
    {
        $linkedAt = $user->google_sub === null ? null : SignIn::query()
            ->where('outcome', SignIn::OK)
            ->where('google_sub', $user->google_sub)
            ->min('created_at');

        $mcp = config('agent.token');

        return [
            'id' => $user->id,
            'name' => $user->name,
            'email' => $user->email,
            'avatar_url' => $user->avatar_url,
            'linked_at' => $linkedAt === null ? null : Carbon::parse($linkedAt)->toIso8601String(),
            'last_login_at' => $user->last_login_at?->toIso8601String(),
            'timezone' => config('agent.timezone'),
            // Whether, never what: the value is the MCP host's credential.
            'mcp_token_configured' => is_string($mcp) && $mcp !== '',
        ];
    }

    /** The id of the token this request came in on, or null for any other kind. */
    private function currentTokenId(Request $request): ?int
    {
        $token = $request->user()?->currentAccessToken();

        return $token instanceof PersonalAccessToken && $token->exists ? (int) $token->getKey() : null;
    }

    private function refusal(SignInRefused $refused): JsonResponse
    {
        return response()->json([
            'reason' => $refused->reason,
            'message' => $refused->getMessage(),
        ], $refused->status);
    }
}
