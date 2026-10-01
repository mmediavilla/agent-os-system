<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * The shared-secret gate on the agent surface.
 *
 * Everything behind this middleware can write — log a workout, replace one,
 * create an exercise — on the say-so of a language model, which raises the
 * stakes past what the rest of the API carries. So the agent routes are gated
 * from the day the first one exists rather than "once auth lands".
 *
 * Two properties are deliberate:
 *
 * It is a *machine* credential and authenticates nobody: no user is resolved and
 * `$request->user()` stays null. That used to matter a great deal, because every
 * ownership rule read `$request->user()?->id` against rows whose `user_id` was
 * null, so authenticating a user here would have silently repartitioned the whole
 * database. Since the owner backfill nothing reads the request for an owner at
 * all — `Owner::id()` answers from the database — so this is now a statement
 * about what the token *means* rather than a hazard being avoided. Turning it
 * into a user credential is still the Sanctum flip's job, and no longer carries a
 * migration with it.
 *
 * A missing secret closes the door rather than opening it. The alternative —
 * "no token configured, so let everyone through" — turns one blank line in
 * `.env` into an unauthenticated write endpoint, and nothing about the response
 * would look wrong.
 */
class ApiToken
{
    public function handle(Request $request, Closure $next): Response
    {
        $expected = config('agent.token');

        if (! is_string($expected) || $expected === '') {
            return new JsonResponse([
                'error' => 'The agent API is not configured. Set AGENT_API_TOKEN in the server environment.',
            ], 503);
        }

        $presented = $this->bearer($request);

        // hash_equals over `===` so a wrong token cannot be discovered one
        // character at a time by timing the response.
        if ($presented === null || ! hash_equals($expected, $presented)) {
            return new JsonResponse(
                ['error' => 'Invalid or missing API token.'],
                401,
                ['WWW-Authenticate' => 'Bearer']
            );
        }

        return $next($request);
    }

    /**
     * The token from `Authorization: Bearer <token>`.
     *
     * One header, one scheme. A second accepted location is a second thing to
     * get wrong in a client and a second thing to reason about here, and every
     * host that matters — Claude Code included — can set this one.
     */
    private function bearer(Request $request): ?string
    {
        $header = $request->header('Authorization');

        if (! is_string($header) || ! preg_match('/^Bearer\s+(\S+)$/i', $header, $m)) {
            return null;
        }

        return $m[1];
    }
}
