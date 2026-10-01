<?php

use App\Http\Middleware\ApiToken;
use App\Http\Middleware\EnsureOwner;
use App\Jobs\GenerateProactiveInsights;
use App\Jobs\RecordQueueHeartbeat;
use App\Services\Facts\FactExtractor;
use App\Services\FitnessSettings;
use App\Services\System\Heartbeat;
use Illuminate\Auth\AuthenticationException;
use Illuminate\Console\Scheduling\Schedule;
use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;
use Illuminate\Http\Exceptions\PostTooLargeException;
use Illuminate\Http\Request;
use Illuminate\Routing\Middleware\SubstituteBindings;
use Illuminate\Routing\Middleware\ValidateSignature;

return Application::configure(basePath: dirname(__DIR__))
    // No `web:`. This is an API and nothing else — the frontend is the Expo app
    // on its own origin, and every route here is under `/api`. What used to be
    // registered was Laravel's stock `/` serving `welcome.blade.php` through a
    // Vite + Tailwind toolchain whose `node_modules` was never installed; it and
    // its `resources/` went in the dead-code sweep. Adding a web route back
    // means deciding what renders it, because there are no views to render.
    ->withRouting(
        api: __DIR__.'/../routes/api.php',
        commands: __DIR__.'/../routes/console.php',
        health: '/up',
    )
    ->withMiddleware(function (Middleware $middleware): void {
        // Aliased rather than appended: `api.token` belongs on `POST /api/mcp`
        // alone — the app signs in and carries its owner's token instead — and
        // `owner` on the group that token opens (see routes/api.php).
        $middleware->alias([
            'api.token' => ApiToken::class,
            'owner' => EnsureOwner::class,
        ]);

        // There is no login *page* on this API — the app draws its own — so a
        // guest is answered, never redirected. Laravel's default redirects to a
        // `login` route that does not exist, which is a 500 for any request that
        // did not ask for JSON (curl, an `<img>`).
        $middleware->redirectGuestsTo(fn () => null);

        // Route middleware runs *after* the group's, and the `api` group ends
        // with SubstituteBindings — so a gated route with a model binding would
        // otherwise resolve the model before the token is checked, answering 404
        // or 401 depending on whether that row exists. That is an existence
        // oracle on the far side of the gate, and a database query paid for
        // before anyone has proved they may ask.
        //
        // Precautionary today: `/api/mcp` binds nothing, so nothing observable
        // depends on this. It is kept because the property has to hold for the
        // *next* gated route, and the failure it prevents is invisible from the
        // outside — a 404 and a 401 look equally like the gate working.
        //
        // ThrottleRequests already sorts ahead of SubstituteBindings, so putting
        // the token check immediately before it keeps the intended order:
        // throttle, then token, then anything that touches the database.
        $middleware->prependToPriorityList(SubstituteBindings::class, ApiToken::class);

        // The same property for the owner's gate and the signed URLs. `auth`
        // already sorts first (it is `AuthenticatesRequests` in the framework's
        // list); `owner` needs `auth`'s user, so it goes after that and before
        // the bindings. `signed` is not in the framework's list at all, so
        // without this a forged `/equipment/{id}/image` would answer 404 for an
        // id that does not exist and 403 for one that does.
        $middleware->prependToPriorityList(SubstituteBindings::class, EnsureOwner::class);
        $middleware->prependToPriorityList(SubstituteBindings::class, ValidateSignature::class);
    })
    ->withSchedule(function (Schedule $schedule): void {
        // The only scheduled work in the app. It is queued rather than run
        // inline because the model call it *may* make takes tens of seconds,
        // and `schedule:run` is a once-a-minute cron tick that should hand work
        // off rather than hold it — the same queue Phase 5's async runs need.
        //
        // Whether and when are Fitness → Settings rows, with `.env` as their
        // default. The schedule is rebuilt on every `schedule:run`, so a new
        // time lands on the next tick; `orConfig` keeps a checkout whose
        // `settings` table is not migrated yet ticking on `.env` alone.
        $schedule->job(new GenerateProactiveInsights)
            ->dailyAt(FitnessSettings::orConfig(
                FitnessSettings::nudgeTime(...),
                config('agent.proactive.time'),
            ))
            ->timezone(config('agent.timezone'))
            ->when(fn () => FitnessSettings::orConfig(
                FitnessSettings::nudgesEnabled(...),
                (bool) config('agent.proactive.enabled'),
            ))
            ->name('proactive-insights');

        // Both halves of the runtime proving they are alive, once a minute, in
        // one entry. The closure runs inside `schedule:run` itself, so it is the
        // scheduler's own signature; the job it queues can only be stamped by a
        // worker, so between them the two heartbeats say which of the two
        // Windows tasks is actually ticking. `/api/health` reads them, and the
        // whole cost is a cache write and a trivial job.
        //
        // Not `->when(...)` on anything: a heartbeat that can be switched off
        // reports "down" as "off", which is the one answer a health check must
        // never give.
        $schedule->call(function (): void {
            Heartbeat::beat(Heartbeat::SCHEDULER);
            RecordQueueHeartbeat::dispatch();
        })->everyMinute()->name('runtime-heartbeat');

        // Conversations gone quiet are read for facts about the owner (15.2).
        // Its own entry rather than a line in the heartbeat's closure: a query
        // that throws here (an unmigrated checkout) must not stop the
        // heartbeats, which would then report a live scheduler as dead. The
        // switch is checked inside, so switched off it queues nothing.
        $schedule->call(fn () => FactExtractor::dispatchDue())
            ->everyMinute()
            ->name('facts-extraction');
    })
    ->withExceptions(function (Exceptions $exceptions): void {
        // A sentence, as JSON, whatever the request asked for: the app reads a
        // 401 as "show Login", and curl deserves more than an empty body.
        $exceptions->render(fn (AuthenticationException $e, Request $request) => $request->is('api/*')
            ? response()->json(['message' => 'Sign in first.'], 401)
            : null);

        // A body over `post_max_size` is refused before routing, with an empty
        // 413 — Herd ships 8M, under `documents.max_kb`. Say which setting.
        $exceptions->render(fn (PostTooLargeException $e, Request $request) => $request->is('api/*')
            ? response()->json(['message' => 'That upload is bigger than PHP on this machine accepts (post_max_size is '
                .ini_get('post_max_size').'). Raise it in Herd — PHP → Max file upload size — or send something smaller.'], 413)
            : null);
    })->create();
