<?php

namespace App\Services\Diagnostics\Checks;

use App\Models\PersonalAccessToken;
use App\Services\Diagnostics\Finding;
use App\Services\Owner;

/**
 * Google sign-in can work, the owner's account is pinned, and the sessions are
 * not all about to run out at once.
 *
 * Settings are reported as set or not set, never their values.
 */
class SignInChecks extends Check
{
    public static function group(): string
    {
        return 'sign_in';
    }

    public static function title(): string
    {
        return 'Sign-in';
    }

    public function run(): array
    {
        return [
            $this->settings(),
            $this->pinned(),
            $this->sessions(),
        ];
    }

    private function settings(): Finding
    {
        $settings = [
            'GOOGLE_CLIENT_ID' => config('services.google.client_id'),
            'GOOGLE_CLIENT_SECRET' => config('services.google.client_secret'),
            'GOOGLE_REDIRECT_URI' => config('services.google.redirect'),
            'AUTH_OWNER_EMAIL' => config('auth.owner_email'),
        ];

        $evidence = [];
        $missing = [];

        foreach ($settings as $name => $value) {
            $evidence[] = "{$name}: ".(filled($value) ? 'set' : 'not set');

            if (blank($value)) {
                $missing[] = $name;
            }
        }

        if ($missing === []) {
            return $this->ok('settings', 'Google sign-in settings', 'All four are set.', $evidence);
        }

        return $this->problem(
            'settings',
            'Google sign-in settings',
            'Sign-in answers 503 until these are set, so a signed-out browser cannot get back in.',
            $evidence,
            manual: 'Set '.implode(', ', $missing).' in backend/.env, then run php artisan config:clear.',
        );
    }

    /**
     * The first sign-in pins the account's Google `sub`; until then the email
     * alone decides, which is the weaker of the two locks.
     */
    private function pinned(): Finding
    {
        $owner = Owner::user();
        $title = 'Owner account pinned';

        if ($owner->google_sub !== null) {
            return $this->ok('pinned', $title, 'The owner\'s Google account is pinned; a different account with the same address is refused.', [
                'last sign-in: '.($owner->last_login_at?->toIso8601String() ?? 'never'),
            ]);
        }

        return $this->warn(
            'pinned',
            $title,
            'Nobody has signed in yet, so no Google account is pinned to the owner.',
            ['google account: not pinned'],
            manual: 'Sign in once at https://projectmc-app.test.',
        );
    }

    private function sessions(): Finding
    {
        $minutes = (int) config('sanctum.expiration');
        $days = (int) config('diagnostics.sign_in.expiring_days');
        $title = 'Sessions';

        $query = PersonalAccessToken::query();
        if ($minutes > 0) {
            $query->where('created_at', '>', now()->subMinutes($minutes));
        }
        $live = $query->get(['id', 'created_at']);

        $evidence = ["live sessions: {$live->count()}"];

        if ($live->isEmpty() || $minutes === 0) {
            return $this->ok('sessions', $title, $live->isEmpty() ? 'No browser is signed in.' : 'Sessions do not expire.', $evidence);
        }

        $cutoff = now()->addDays($days)->subMinutes($minutes);
        $expiring = $live->filter(fn (PersonalAccessToken $token) => $token->created_at->lt($cutoff))->count();
        $evidence[] = "expiring within {$days} days: {$expiring}";

        if ($expiring === $live->count()) {
            return $this->warn(
                'sessions',
                $title,
                "Every signed-in browser's session ends within {$days} days, so you will be signed out everywhere at once.",
                $evidence,
                manual: 'Sign in again from one browser to start a fresh session.',
            );
        }

        return $this->ok('sessions', $title, 'At least one session has more than a week left.', $evidence);
    }
}
