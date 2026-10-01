<?php

use App\Http\Controllers\AgentActionController;
use App\Http\Controllers\AgentController;
use App\Http\Controllers\AgentConversationController;
use App\Http\Controllers\AgentRunController;
use App\Http\Controllers\AgentSnapshotController;
use App\Http\Controllers\AssistantActivityController;
use App\Http\Controllers\AuthController;
use App\Http\Controllers\AutomationController;
use App\Http\Controllers\CalendarController;
use App\Http\Controllers\CalendarFeedController;
use App\Http\Controllers\DeadlineController;
use App\Http\Controllers\DiagnosticsController;
use App\Http\Controllers\DocumentController;
use App\Http\Controllers\EquipmentController;
use App\Http\Controllers\ExerciseController;
use App\Http\Controllers\FactController;
use App\Http\Controllers\FitnessStatsController;
use App\Http\Controllers\HealthController;
use App\Http\Controllers\InsightController;
use App\Http\Controllers\McpController;
use App\Http\Controllers\NewsController;
use App\Http\Controllers\SettingsController;
use App\Http\Controllers\SystemStatsController;
use App\Http\Controllers\VoiceCreditsController;
use App\Http\Controllers\VoiceTokenController;
use App\Http\Controllers\VoiceTurnController;
use App\Http\Controllers\WeatherController;
use App\Http\Controllers\WorkoutController;
use Illuminate\Support\Facades\Route;

/*
|--------------------------------------------------------------------------
| API routes
|--------------------------------------------------------------------------
| All routes are prefixed with /api by Laravel's bootstrap configuration.
|
| Every route is behind the owner's sign-in (`auth:sanctum` + `owner`) except
| the short list in the first section below, each of which says why. The list is
| enforced rather than remembered: `RouteGateTest` fails on any `api/*` route
| that is neither gated nor named in `RouteGateTest::PUBLIC`, so a new route
| cannot skip the gate by being written outside the group.
*/

// --- Outside the gate -------------------------------------------------------

// Signing in, which cannot require being signed in. Throttled hard: a real
// person makes one of each per sign-in, and anything faster is guessing.
Route::middleware('throttle:10,1')->group(function () {
    Route::post('auth/google/start', [AuthController::class, 'start'])->name('auth.google.start');
    Route::post('auth/google/callback', [AuthController::class, 'callback'])->name('auth.google.callback');
});

// Whether the database, the worker, the scheduler and the assistant are up.
// Public so the PowerShell checks in CLAUDE.md work without a token; it names
// no row, holds nothing personal, and says of the MCP token only whether one
// is set.
Route::get('health', HealthController::class)->name('health');

// Three reads made by the browser itself — two `<img>` tags and an
// `EventSource` — none of which can carry an `Authorization` header. Each URL is
// minted, signed and time-limited inside an authenticated response instead, so
// holding one is proof the gate was passed a moment ago. `signed` sorts ahead of
// the model binding (bootstrap/app.php), so a forged URL learns nothing about
// which ids exist.
//
// The photo sits before the equipment resource so `/{equipment}/image` is never
// mistaken for a nested resource segment.
Route::get('equipment/{equipment}/image', [EquipmentController::class, 'image'])
    ->middleware('signed')
    ->name('equipment.image');

// A filed document, opened in a tab or embedded in the page (16.0). Same
// problem as the photo above — neither an `<a download>` nor an `<embed>` can
// carry the header — and the same answer, on the same day-boundary expiry, so
// a twenty-megabyte scan is fetched once rather than on every read.
Route::get('documents/{document}/file', [DocumentController::class, 'file'])
    ->middleware('signed')
    ->name('documents.file');

// A diagnosis's `.md`, saved from the Stats page through an `<a download>`
// (18.0), which cannot carry the header either. Minted inside the gated
// `GET /api/diagnostics`, on the documents' day-boundary expiry.
Route::get('diagnostics/{report}/file', [DiagnosticsController::class, 'file'])
    ->middleware('signed')
    ->name('diagnostics.file');

// Outside `throttle:agent` on purpose. That ceiling is there because a client
// stuck retrying a *tool-calling* endpoint spends real money — but a browser
// watching a stream reconnects every time the response is capped, and at 30/min
// it would exhaust the allowance protecting the endpoint that actually costs
// something. These spend one indexed query.
//
// `after` is left out of the stream's signature: it is the resume cursor a
// client appends, not a grant of anything.
Route::middleware('throttle:120,1')->group(function () {
    Route::get('agent/runs/{run}/stream', [AgentRunController::class, 'stream'])
        ->middleware('signed:after')
        ->name('agent.runs.stream');

    // A camera frame the user attached to a turn, fetched by an `<img>`. A
    // transcript with four pictures in it would otherwise spend four of an
    // allowance meant for the endpoint that spends money.
    Route::get('agent/snapshots/{snapshot}', AgentSnapshotController::class)
        ->middleware('signed')
        ->name('agent.snapshots.show');
});

// --- Agent: MCP -------------------------------------------------------------
// Handed to an external host (Claude Code), which does its own prompting and
// its own confirmations. Token-gated because a host is configured with a
// credential anyway, and because this is the route an off-machine client would
// ever be pointed at. `throttle` runs first: a client hammering the endpoint
// with a bad token should be shown the door by the cheaper check.
Route::middleware(['throttle:agent', 'api.token'])->group(function () {
    Route::post('mcp', McpController::class)->name('mcp');
});

// --- Behind the gate --------------------------------------------------------
// A Sanctum bearer token, issued by Google sign-in to the owner row and nobody
// else. Bearer rather than a cookie because the app (projectmc-app.test) and
// this API (projectmc.test) are different sites, so a session cookie would be a
// third-party one. `auth` and `owner` both sort ahead of the model bindings, so
// an anonymous request is a 401 whether or not the row it names exists.
Route::middleware(['auth:sanctum', 'owner'])->group(function () {
    // --- The owner's own account -------------------------------------------
    // Profile's reads, and the ways out. The bulk revoke is spelled
    // `?others=1`, so a client that drops an id cannot sign out everything.
    Route::get('auth/me', [AuthController::class, 'me'])->name('auth.me');
    Route::get('auth/sessions', [AuthController::class, 'sessions'])->name('auth.sessions');
    Route::delete('auth/sessions', [AuthController::class, 'revoke'])->name('auth.sessions.revoke-others');
    Route::delete('auth/sessions/{token}', [AuthController::class, 'revoke'])->name('auth.sessions.revoke');
    Route::post('auth/logout', [AuthController::class, 'logout'])->name('auth.logout');
    Route::get('auth/sign-ins', [AuthController::class, 'signIns'])->name('auth.sign-ins');

    // --- Fitness ----------------------------------------------------------------
    Route::post('workouts/import', [WorkoutController::class, 'importCsv'])
        ->name('workouts.import');

    Route::apiResource('workouts', WorkoutController::class)
        ->only(['index', 'store', 'show', 'update', 'destroy']);

    // --- Fitness analytics ------------------------------------------------------
    Route::get('fitness/stats', [FitnessStatsController::class, 'index'])->name('fitness.stats');

    // --- Exercises --------------------------------------------------------------
    Route::apiResource('exercises', ExerciseController::class)
        ->only(['index', 'store', 'show', 'update', 'destroy']);

    // --- Equipment --------------------------------------------------------------
    // Writing a photo; reading one is a signed URL outside the gate. Registered
    // before the resource so `/{equipment}/image` is never read as a nested segment.
    Route::post('equipment/{equipment}/image', [EquipmentController::class, 'uploadImage'])
        ->name('equipment.image.upload');
    Route::delete('equipment/{equipment}/image', [EquipmentController::class, 'deleteImage'])
        ->name('equipment.image.destroy');

    Route::apiResource('equipment', EquipmentController::class)
        ->only(['index', 'store', 'show', 'update', 'destroy']);

    // --- Documents ----------------------------------------------------------
    // The filing cabinet (16.0). Fields as JSON, the file as its own POST —
    // the equipment photo's arrangement, for its reasons: PHP does not parse a
    // multipart PUT, and a record saved first means a failed upload loses the
    // upload rather than the form. Reading the file is the signed route above.
    //
    // Outside `throttle:agent`: nothing here calls a model.
    Route::get('documents', [DocumentController::class, 'index'])->name('documents.index');
    Route::post('documents', [DocumentController::class, 'store'])->name('documents.store');
    Route::patch('documents/{document}', [DocumentController::class, 'update'])->name('documents.update');
    Route::delete('documents/{document}', [DocumentController::class, 'destroy'])->name('documents.destroy');

    Route::post('documents/{document}/file', [DocumentController::class, 'uploadFile'])
        ->name('documents.file.upload');
    Route::delete('documents/{document}/file', [DocumentController::class, 'deleteFile'])
        ->name('documents.file.destroy');

    // --- Deadlines ----------------------------------------------------------
    // Dates somebody must act on (16.2), which may point at a document and
    // outlive it. Completing is its own route, and so is taking it back, so a
    // PATCH of the fields can never tick one off.
    //
    // Outside `throttle:agent`: nothing here calls a model.
    Route::get('deadlines', [DeadlineController::class, 'index'])->name('deadlines.index');
    Route::post('deadlines', [DeadlineController::class, 'store'])->name('deadlines.store');
    Route::patch('deadlines/{deadline}', [DeadlineController::class, 'update'])->name('deadlines.update');
    Route::delete('deadlines/{deadline}', [DeadlineController::class, 'destroy'])->name('deadlines.destroy');

    Route::post('deadlines/{deadline}/complete', [DeadlineController::class, 'complete'])
        ->name('deadlines.complete');
    Route::delete('deadlines/{deadline}/complete', [DeadlineController::class, 'reopen'])
        ->name('deadlines.reopen');

    // --- Calendar ---------------------------------------------------------------
    // The user's calendars — Google, iCloud, anything with an iCal address — read
    // through each one's secret or published address: no OAuth, no developer
    // project. The addresses are managed by Settings and stored encrypted; no route
    // below ever returns one, and FeedAddress decides which ones may be fetched at
    // all. The app's own `events` table went in 10.2: events are made in each
    // calendar's own app now, not here.
    //
    // `calendar` is a window, not a page, and it has no default: the times are
    // wall clock and this server runs eight hours behind the only person using it,
    // so which day counts as "today" is the client's to say.
    Route::get('calendar', CalendarController::class)->name('calendar');
    Route::get('calendar/feeds', [CalendarFeedController::class, 'index'])->name('calendar.feeds.index');
    Route::post('calendar/feeds', [CalendarFeedController::class, 'store'])->name('calendar.feeds.store');
    Route::patch('calendar/feeds/{feed}', [CalendarFeedController::class, 'update'])->name('calendar.feeds.update');
    Route::delete('calendar/feeds/{feed}', [CalendarFeedController::class, 'destroy'])->name('calendar.feeds.destroy');

    // --- The HUD's telemetry ----------------------------------------------------
    // Three reads (and `health`, outside the gate), all cheap by construction.
    // None probes anything inside the request: the machine sample is taken on a
    // queue worker and the forecast is cached. `stats` and `weather` are polled
    // for as long as someone leaves the HUD open. (`system/summary` went in
    // 18.1: Stats draws a diagnosis now, and its numbers are checks' evidence.)
    Route::get('system/stats', SystemStatsController::class)->name('system.stats');
    Route::get('weather', WeatherController::class)->name('weather');

    // --- Diagnostics ------------------------------------------------------------
    // The Stats page's Diagnose (18.0) and Troubleshoot (18.2) buttons. Read on
    // open and after a press, never polled. Each press starts a PowerShell and
    // resolves every calendar's host, so they share a limiter of their own —
    // not `throttle:agent`, which is for requests that spend money, and none of
    // this does.
    Route::get('diagnostics', [DiagnosticsController::class, 'index'])->name('diagnostics.index');
    Route::post('diagnostics/run', [DiagnosticsController::class, 'run'])
        ->middleware('throttle:diagnostics')
        ->name('diagnostics.run');
    Route::post('diagnostics/troubleshoot', [DiagnosticsController::class, 'troubleshoot'])
        ->middleware('throttle:diagnostics')
        ->name('diagnostics.troubleshoot');

    // --- Settings ---------------------------------------------------------------
    // The kill switch on Anthropic usage. A write only: its state is reported by
    // `GET /api/health`, which the shell already polls for the status pill, and a
    // second endpoint for it would be a second reading of one truth.
    Route::post('settings/anthropic', [SettingsController::class, 'anthropic'])
        ->name('settings.anthropic');

    // The morning nudge's settings, which the scheduler and the worker read. Fitness
    // → Settings is their only screen, so they have a read of their own.
    Route::get('settings/fitness', [SettingsController::class, 'fitness'])
        ->name('settings.fitness');
    Route::patch('settings/fitness', [SettingsController::class, 'updateFitness'])
        ->name('settings.fitness.update');

    // Which models answer, how hard they think and how far a message may go — read
    // by the worker, the scheduler and voice turns. Assistant → Settings is their
    // only screen.
    Route::get('settings/assistant', [SettingsController::class, 'assistant'])
        ->name('settings.assistant');
    Route::patch('settings/assistant', [SettingsController::class, 'updateAssistant'])
        ->name('settings.assistant.update');

    // The instructions the owner may reword — persona, scope, spoken answers and
    // the two unprompted writers' briefs. Assistant → Instructions is their only
    // screen; saving one calls no model, so no `throttle:agent`.
    Route::get('settings/instructions', [SettingsController::class, 'instructions'])
        ->name('settings.instructions');
    Route::patch('settings/instructions', [SettingsController::class, 'updateInstructions'])
        ->name('settings.instructions.update');

    // The owner's news interests, which `get_news` searches on the worker and in a
    // voice turn. Outside `throttle:agent`: saving a list calls no model.
    Route::get('settings/news', [SettingsController::class, 'news'])
        ->name('settings.news');
    Route::patch('settings/news', [SettingsController::class, 'updateNews'])
        ->name('settings.news.update');

    // --- News -------------------------------------------------------------------
    // The HUD's read of the news (19.2), which marks nothing seen, and the owner's
    // reading list. Pinning sends an id the service handed out, never a URL.
    // Outside `throttle:agent`: nothing here calls a model, and an outlet is only
    // asked once its own cache is due.
    Route::get('news', [NewsController::class, 'index'])->name('news.index');
    Route::get('news/pins', [NewsController::class, 'pins'])->name('news.pins.index');
    Route::post('news/pins', [NewsController::class, 'pin'])->name('news.pins.store');
    Route::delete('news/pins/{pin}', [NewsController::class, 'unpin'])->name('news.pins.destroy');

    Route::post('news/pins/{pin}/read', [NewsController::class, 'read'])->name('news.pins.read');
    Route::delete('news/pins/{pin}/read', [NewsController::class, 'reopen'])->name('news.pins.reopen');

    // --- Facts --------------------------------------------------------------------
    // What the assistant has on file about the owner — the Facts overlay. Outside
    // `throttle:agent`: nothing here calls a model. A proposal is decided with a
    // PATCH; forgetting an active fact is a DELETE, and a hard one.
    Route::get('facts', [FactController::class, 'index'])->name('facts.index');
    Route::post('facts', [FactController::class, 'store'])->name('facts.store');
    Route::patch('facts/{fact}', [FactController::class, 'update'])->name('facts.update');
    Route::delete('facts/{fact}', [FactController::class, 'destroy'])->name('facts.destroy');

    // --- Automations ----------------------------------------------------------
    // Scheduled conversations — the Automations overlay (15.4). Rows are cheap
    // CRUD, like Facts'; `run` and `due` each can queue a real model call, so
    // those two carry `throttle:agent` and the rest do not.
    Route::get('automations', [AutomationController::class, 'index'])->name('automations.index');
    Route::post('automations', [AutomationController::class, 'store'])->name('automations.store');
    Route::patch('automations/{automation}', [AutomationController::class, 'update'])->name('automations.update');
    Route::delete('automations/{automation}', [AutomationController::class, 'destroy'])->name('automations.destroy');

    Route::middleware('throttle:agent')->group(function () {
        Route::post('automations/{automation}/run', [AutomationController::class, 'run'])->name('automations.run');
        // The HUD's own call, on load and on the tab becoming visible — not a
        // cron tick. See AutomationController::due().
        Route::post('automations/due', [AutomationController::class, 'due'])->name('automations.due');
    });

    // --- Agents -----------------------------------------------------------------
    // Assistant → Agents (17.2): which kinds of work the assistant may do. Outside
    // `throttle:agent`, like Facts — nothing here calls a model. A switched-off
    // agent's tools leave the next turn's registry (Services\Agents\AgentScope).
    Route::get('agents', [AgentController::class, 'index'])->name('agents.index');
    Route::post('agents', [AgentController::class, 'store'])->name('agents.store');
    Route::patch('agents/{agent}', [AgentController::class, 'update'])->name('agents.update');
    Route::delete('agents/{agent}', [AgentController::class, 'destroy'])->name('agents.destroy');

    // What the assistant keeps and what it did this week — Assistant → Activity.
    // Outside `throttle:agent` on purpose: that ceiling is for the requests that
    // spend money, and a tab polling a few indexed counts would only eat into it.
    Route::get('assistant/activity', AssistantActivityController::class)
        ->name('assistant.activity');

    // --- The spoken conversation ------------------------------------------------
    // One question, asked out loud, answered in the same request. The caller is a
    // **client tool** registered on an ElevenLabs agent, which runs in this page on
    // this machine — so nothing is exposed, no tunnel exists, and the perimeter is
    // exactly where the block above `/agent` assumes it is. A webhook tool would
    // have needed a public endpoint.
    //
    // Synchronous, unlike `POST /agent/conversations/{id}/messages`: that answers
    // 202 because a browser can be handed a run to watch, and a tool call blocked
    // on this response cannot watch anything.
    //
    // Read-only. The runner behind it is built on `ToolRegistry::readOnly()`, so
    // the writing tools are not offered rather than offered and refused — there is
    // no approval card in front of a spoken sentence.
    //
    // Its own limiter: it spends what `agent` spends, but sharing that bucket would
    // let a spoken question cost a typed one its slot, and both are used in the
    // same thread by the same person.
    //
    // The token beside it is the credential half: the page opens the session
    // itself, over WebRTC, straight to ElevenLabs — so the only thing it needs
    // from us is permission to, and that must not be the API key, which Expo
    // would inline into the web bundle the moment it became an EXPO_PUBLIC_*
    // value. Same limiter, because
    // a session is one token and then many turns, and a client asking for tokens in
    // a loop is the same runaway as one asking questions in a loop.
    Route::middleware('throttle:voice')->group(function () {
        Route::post('voice/turn', VoiceTurnController::class)->name('voice.turn');
        Route::get('voice/token', VoiceTokenController::class)->name('voice.token');
    });

    // Outside the voice limiter, like the run stream outside `throttle:agent`:
    // opening Assistant → Settings must not eat the allowance a spoken turn
    // needs. It is cached, so it costs ElevenLabs one call per ten minutes.
    Route::get('voice/credits', VoiceCreditsController::class)->name('voice.credits');

    // --- Insights (AI-generated reports) ----------------------------------------
    Route::get('insights', [InsightController::class, 'index'])->name('insights.index');
    Route::post('insights/fitness', [InsightController::class, 'fitness'])->name('insights.fitness');

    // --- Agent: chat ------------------------------------------------------------
    // The loop this app runs itself, driven by the app's own Chat screen, where the
    // confirmation gate is ours — a proposed write waits in `agent_actions` until
    // POST /agent/actions/{id} decides it.
    //
    // Not on `api.token`: Expo inlines every EXPO_PUBLIC_* value into the web
    // bundle, so a shared secret here would be one anyone loading the page holds.
    // The owner's sign-in is the credential instead — issued per browser, never
    // part of the bundle.
    //
    // `throttle:agent` stays, because that ceiling was never about authentication:
    // a client stuck retrying a tool-calling endpoint spends real money, not CPU.
    Route::middleware('throttle:agent')->group(function () {
        Route::get('agent/conversations', [AgentConversationController::class, 'index'])
            ->name('agent.conversations.index');
        Route::post('agent/conversations', [AgentConversationController::class, 'store'])
            ->name('agent.conversations.store');
        Route::get('agent/conversations/{conversation}', [AgentConversationController::class, 'show'])
            ->name('agent.conversations.show');
        Route::delete('agent/conversations/{conversation}', [AgentConversationController::class, 'destroy'])
            ->name('agent.conversations.destroy');
        Route::post('agent/conversations/{conversation}/messages', [AgentConversationController::class, 'message'])
            ->name('agent.conversations.message');

        Route::post('agent/actions/{action}', AgentActionController::class)
            ->name('agent.actions.decide');
    });

    // --- Agent: watching a run ---------------------------------------------
    // A message does not wait for the loop; it queues a run and answers 202,
    // and this is how a polling client follows it. The stream is the same log
    // over SSE, and sits outside the gate above because `EventSource` cannot
    // send a header — it is reached through the run's signed `stream_url`.
    Route::middleware('throttle:120,1')->group(function () {
        Route::get('agent/runs/{run}', [AgentRunController::class, 'show'])
            ->name('agent.runs.show');
    });
});
