<?php

namespace App\Http\Middleware;

use App\Services\Owner;
use Closure;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Only the owner gets past the gate.
 *
 * `auth:sanctum` proves a token is real; this proves it is the owner's. Today
 * the owner is the only user who can hold one — sign-in issues tokens to
 * `Owner::user()` and nobody else — so this never refuses anyone. It is here so
 * that stays true if a second row ever appears in `users`: reads are not scoped
 * by owner (see CLAUDE.md), so any other account that could authenticate would
 * see everything.
 */
class EnsureOwner
{
    public function handle(Request $request, Closure $next): Response
    {
        if ($request->user()?->getKey() !== Owner::id()) {
            return new JsonResponse(['message' => 'This account is not allowed here.'], 403);
        }

        return $next($request);
    }
}
