<?php

namespace App\Providers;

use App\Models\PersonalAccessToken;
use Illuminate\Cache\RateLimiting\Limit;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\ServiceProvider;
use Laravel\Sanctum\Sanctum;

class AppServiceProvider extends ServiceProvider
{
    /**
     * Register any application services.
     */
    public function register(): void
    {
        //
    }

    /**
     * Bootstrap any application services.
     */
    public function boot(): void
    {
        // Ours rather than Sanctum's, so `last_used_at` is written at most once a
        // minute and carries the address it came from.
        Sanctum::usePersonalAccessTokenModel(PersonalAccessToken::class);

        // The Diagnose button: a person presses it a few times a minute at most,
        // and each press starts a PowerShell. Its own bucket rather than
        // `agent`'s, which guards the requests that spend money.
        RateLimiter::for('diagnostics', fn (Request $request) => Limit::perMinute((int) config('diagnostics.rate_limit'))->by($request->ip()));
    }
}
