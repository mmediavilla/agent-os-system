# ProjectMC — Life OS

A single-user Life OS: a training log, an assistant that reads and (with
approval) writes it, remembers what it is told about the owner, keeps their
documents and the dates they must act on, reads them the news, and opens a
conversation of its own at an hour they set, and a heads-up display (the HUD)
that is left open all day.
Web is the only target — the native fallbacks were deleted in Phase 7.0.

This file keeps the **why** behind every decision that is still true in the
code. How a thing got there is in git and the PRs; a section here earns its
place by saving the next person from undoing something on purpose.

## Project layout

```
ProjectMC/
  backend/    Laravel 13 API (PHP 8.4, SQLite)
  app/        Expo SDK 54 + React Native Web frontend
```

## Dev server setup — DO NOT CHANGE

### Laravel API — https://projectmc.test
- Served by **Laravel Herd** automatically — no manual start needed.
- **Do NOT use** `php artisan serve` — Herd's CLI has a port-binding bug that causes "Failed to listen" errors.
- Fallback (no Herd): `Start-Process cmd.exe -ArgumentList "/c","php -S 127.0.0.1:8001 -t public" -WorkingDirectory ".\backend"`

### Expo web — https://projectmc-app.test
- Herd proxies `projectmc-app.test` → `localhost:8082`, but **Expo must be started manually**.
- A 502 at `https://projectmc-app.test` means the Expo dev server is not running — start it:
  `Start-Process cmd.exe -ArgumentList "/c","npx expo start --web --port 8082" -WorkingDirectory ".\app"`
- **Do NOT** use `Start-Process -FilePath "npx"` — `npx` is a `.ps1`/`.cmd` script, not a Win32 binary. Use the cmd.exe wrapper or call `npx.cmd` directly.

### Scheduler and queue — Windows Task Scheduler, not Herd

Herd serves HTTP and nothing else: **no cron tick, no queue worker.** Without
both, the chat loop's runs sit at `queued` forever and the proactive layer never
fires — silently. Register them once:

```powershell
# From an ELEVATED PowerShell — silent, and runs while logged off.
powershell -ExecutionPolicy Bypass -File backend\scripts\register-runtime-tasks.ps1
```

That creates two tasks under your own account (`-Remove` deletes them):

| Task | Runs | Why |
|---|---|---|
| `ProjectMC scheduler` | `schedule:run`, every minute | Laravel's scheduler decides from there what is actually due. |
| `ProjectMC queue worker` | `queue:work --sleep=1`, every 5 min, `IgnoreNew` | Self-healing: a dead worker is restarted by the next tick, a live one ignores it. `--max-time=3600` makes it exit hourly, so code changes land within the hour — **restart it by hand after a backend change** or it keeps running the old copy. `--sleep` is the floor on how long a chat message waits before the assistant starts. |

```powershell
Stop-ScheduledTask -TaskName "ProjectMC queue worker"
Start-ScheduledTask -TaskName "ProjectMC queue worker"
```

**The logon type is the one decision.** The default is S4U — no console window,
runs whether or not you are logged on — and registering it *requires an
elevated shell*; the script refuses up front rather than letting
`Register-ScheduledTask` answer "Access is denied" and carry on. `-Interactive`
works from an ordinary shell but only runs while you are logged on and flashes a
console window once a minute. **S4U also means the worker has no desktop**
(session 0), which is why anything that opens a window must run in a Herd
request instead — see *The assistant reaches this machine*.

Three Windows landmines are baked into the script:

- **A colon is illegal in a task name.** `ProjectMC schedule:run` fails with
  `The parameter is incorrect` (0x80070057), naming neither.
- **`[TimeSpan]::MaxValue` is not "repeat forever".** It serialises out of
  range. The repetition duration is ten years.
- **`Register-ScheduledTask` ignores `$ErrorActionPreference`.** Without an
  explicit `-ErrorAction Stop` it prints the error and returns, so the script
  also re-reads each task after creating it.

`php` on PATH is Herd's `bin\php.bat` shim; the script follows it to the real
`php84\php.exe` so a tick does not wrap itself in a `cmd.exe`.

```powershell
Get-ScheduledTask -TaskName "ProjectMC*" | Select-Object TaskName, State
Get-ScheduledTaskInfo -TaskName "ProjectMC scheduler"   # LastTaskResult 0 = the tick ran
php artisan schedule:list        # `proactive-insights` (0 7 * * *), `runtime-heartbeat`, `facts-extraction`
php artisan proactive:check      # what would fire right now — free, no model call
php artisan facts:extract        # read the latest thread for facts now, without waiting 20 minutes
```

### Checking the servers
```powershell
curl.exe -sk -o NUL -w "%{http_code}" https://projectmc.test/api/workouts              # should be 401 — the gate is up
(Invoke-WebRequest "https://projectmc-app.test" -UseBasicParsing).StatusCode            # should be 200
Invoke-RestMethod https://projectmc.test/api/health | ConvertTo-Json -Depth 3        # database, worker, scheduler, assistant
```

For anything past "is it up", **`php artisan diagnose`** (from `backend/`) runs
every check the Stats page runs and names the command for each fault, and
`php artisan troubleshoot` applies the soft fixes — see *Diagnostics*. Both work
when the HUD will not load.

## Platform traps

Each of these cost somebody an afternoon, and none of them announces itself.

**`public/index.php` pre-loads `.env` with `createMutable`.** Laravel's
`createImmutable` will not override a variable already set in the process, so a
shell holding `ANTHROPIC_API_KEY=""` from an earlier test run silently beat the
real key. The pre-load makes `.env` always win.

**A Windows path in `.env` must be single-quoted.** Unquoted it dies on the
spaces ("unexpected whitespace"); double-quoted it dies on the backslashes,
because quoting turns on escape sequences and `\U` is not one. Either way it is
an uncaught `InvalidFileException` before Laravel boots, so *every* route 500s.

**Herd's 30s `max_execution_time` is wall clock on Windows.** Elsewhere the
limit leaves out time spent in system calls and streams; on Windows every second
counts, including seconds spent waiting on Claude or sleeping between polls. A
request that crosses it dies with a fatal and a bare 500, and not one more line
runs. So every long request raises its own limit:

- `VoiceTurnController` → `AgentRun::VOICE_MAX_SECONDS` (150), past the 120s
  ElevenLabs waits on the `ask_life_os` tool, so the agent gives up and says so
  before PHP kills the turn.
- `AgentRunController::stream` → the stream's own cap plus 15s, set where the
  loop starts, because `set_time_limit` restarts the count. Before this, every
  stream died at 30s with "headers already sent"; `EventSource` reconnected, so
  it looked fine.
- A fatal leaves a voice run `running`, which locked its thread for good.
  `RunDispatcher::active()` fails voice runs still running past
  `VOICE_MAX_SECONDS` + 30s.
- `DiagnosticsController` → 60s for a run and 120s for Troubleshoot
  (`config/diagnostics.php`): a run starts a PowerShell and resolves every
  calendar's host, and Troubleshoot is two runs plus a bounded wait on each
  restarted task.

The queue worker runs under the CLI, where the limit is 0. **`POST
/api/insights/fitness` is the one request still on the default** — a synchronous
Opus call. Anything new that waits on a model inside a request needs a
`set_time_limit` of its own.

**SQLite runs in WAL, with a 5s busy timeout, and begins every transaction
`IMMEDIATE`** (`config/database.php`). The first two arrived when the run stream started reading the
database in a loop while the worker wrote to it. The third is what makes the
second work: a `DEFERRED` transaction that reads and then writes, after someone
else committed in between, gets `SQLITE_BUSY_SNAPSHOT` — and SQLite does not
call the busy handler for that at all, because waiting cannot fix a stale
snapshot. Measured, 300 read-then-write transactions against a concurrent
writer: `DEFERRED` 38 ok / 262 "database is locked" in ~2ms; `IMMEDIATE` 300 ok.
**A fast "locked" error is the tell** — a working timeout looks like a slow
request. The victim was mostly `RateLimiter::hit()` (a counter in the `cache`
table), which 500ed agent requests that had nothing else wrong with them.
`lockForUpdate()` is no defence — SQLite's grammar compiles it to nothing.

- Writers now serialise, so contention arrives as latency; a transaction
  holding the lock past 5s would bring the error back (the CSV import is the
  only long one).
- The suite cannot test any of this (`:memory:`, `CACHE_STORE=array`), so
  `DatabaseConfigTest` pins the three settings rather than reproducing the race.
- Laravel honours `transaction_mode` on **PHP 8.4+ only**; below that PDO's own
  deferred `BEGIN` comes back and so does all of this.
- Expect `-wal` and `-shm` files beside `database/database.sqlite`; both are
  transient and stay out of git.

**Herd's PHP must accept more than a document may be.** A stock Herd takes a
2MB upload and an 8MB body (`upload_max_filesize`, `post_max_size` in
`~\.config\herd\bin\php84\php.ini`), a tenth of the 20MB cap
(`DOCUMENTS_MAX_KB`). Raise both to **30M** through Herd's own setting,
**PHP → Max file upload size**; a fresh Herd install goes back to 2M/8M. Neither limit announces itself: PHP drops the
file before Laravel sees it, so the `file` rule would have said "The file failed
to upload." Both now answer with a 413 sentence naming the setting
(`DocumentRejected::overPhpLimit()` and a `PostTooLargeException` renderer in
`bootstrap/app.php`) — but **over `post_max_size` the sentence does not survive
the trip**: PHP answers while the body is still arriving, the connection closes,
and the client gets a bare 413 (checked live with 3MB and 9MB files). Past the
raise, a 12MB PDF uploads and a 25MB one gets the app's own "limit is 20.0MB"
413 (checked live); only a file over 30MB still gets the bare one. nginx
already allows 128M.

**PowerShell's web cmdlets buffer the whole response**, which makes a working
stream look broken — test SSE with `curl.exe -N`. `Invoke-RestMethod` also
throws on a 503 rather than returning its body.

**Keep the project out of OneDrive.** Cloud-only files carry a reparse point
that breaks PHP's bootstrap cache writes and Expo's `node_modules`.

## Data and the catalog

### Units are a display layer, not a storage format

The API and the database always speak kilograms, kilometres and centimetres.
The unit setting (`app/src/units.ts` + `UnitsProvider`) converts on the way onto
the screen and back on the way into a payload, so switching units never
rewrites stored data and never needs a migration.

There are exactly two conversion points for a set — `setInputFrom` (stored →
form) and `setPayload` (form → API) — and everything between them is in the
user's units. Read values go through `displayMetric` / `fmtWeight`.

Consequence: editing in a non-canonical unit is slightly lossy. 100kg shows as
220.5lb, which converts back to 100.02kg, so re-saving a workout in pounds can
nudge the stored kilos by ~0.03 — well under the resolution anyone logs at, and
the price of one-decimal display. Body measurements have a stored preference but
no display sites yet; Fitness → Settings says so.

### Fitness settings are split by who reads them

Fitness → Settings is the overlay's fifth tab (`components/FitnessSettings.tsx`),
and everything that changes how training numbers read lives there, not in the
HUD's Settings — units moved in 12.0 because kilos and kilometres only ever
appear on the Fitness screens. Where each setting is stored follows one
question: **does anything without a browser read it?**

- **Browser-only**: units (`UnitsProvider`) and the **default stats range**
  Home opens on (`fitnessPrefs.ts`, `FitnessPrefsProvider`, key
  `projectmc.fitness`; `auto` is the shortest window with training in it, so a
  database last trained in months ago still opens full). Nothing but this screen
  reads them.
- **Rows in `settings`** (`Services\FitnessSettings`), for `AnthropicSwitch`'s
  reason: the **morning nudge** (on/off, time, which of the four triggers may
  speak) is decided by the scheduler and written by the worker; the **e1RM
  formula** (Epley or Brzycki) and **the week's first day** (Monday or Sunday)
  change the one `FitnessStatsService` payload that the 07:00 check,
  `get_fitness_stats` and the dashboard all read. Kept in a browser, the nudge
  would call a week a drop that Home drew as normal.

The rules the rows keep:

- **`.env` is the default, not a second switch.** `PROACTIVE_INSIGHTS_ENABLED`
  and `PROACTIVE_TIME` answer until a choice is saved; from then on the row
  answers. A stored value outside its closed set (a hand-edited row, a renamed
  trigger) falls back the same way rather than failing a tick. An empty trigger
  list is a real answer — all switched off — and is not "never set".
- **The schedule reads through `FitnessSettings::orConfig()`**, because
  `schedule:run` rebuilds the schedule every minute, including on a checkout
  whose `settings` table is not migrated yet; a missing table would otherwise
  read as a dead scheduler. A new time lands on the next tick.
- **`ProactiveTriggers::check()` stays pure**: switched-off triggers are dropped
  from its result (`FitnessSettings::allowed()`) by the job and by
  `proactive:check`, never inside it.
- **The payload says what it used**: `settings: { e1rm_formula, week_start }`,
  and `get_fitness_stats`'s description tells the model to name the formula.
  Brzycki reads ~3% high on a single; that is the user's call, and it cannot
  poison PRs, because every point and prior best in one payload share a
  formula. `E1RM_MAX_REPS` (12) is also what keeps Brzycki's denominator
  positive. The heatmap's day labels are read off the grid's `from`
  (`dayLabels()`), not assumed Monday.
- **The screen is not optimistic.** A control is disabled while its write is out
  and redraws from the answer (`useServerSettings`) — a nudge setting that looked
  saved and was not would be found out at 07:00 the next morning.
- **`GET` + partial `PATCH /api/settings/fitness`**, unlike the switch's
  write-only route: nothing polls these, and one tab shows them. Either half —
  `nudges` or `calculations` — may be sent alone.
- **The tab uses the overlay's full width** in two wrapping columns (Units + Home
  | Calculations + Morning nudges), one under ~900px; the HUD's Settings keeps its
  720px column.

### Equipment photos are streamed by the API, not served from the web root

The conventional setup — the `public` disk plus `php artisan storage:link` — is
one more step to get wrong on a fresh checkout, and on Windows the symlink needs
privileges that are not always there. Photos live on the private `local` disk
(`storage/app/private/equipment`) and `GET /api/equipment/{id}/image` streams
them. Being a route is also what let it be gated when sign-in landed: an `<img>`
cannot send the token, so `image_url` is a signed URL (see *What cannot send a
header gets a signed URL*).

`image_url` appends `?v={updated_at}`, so replacing a photo changes the URL,
which is what lets the response carry `Cache-Control: immutable` without ever
showing a stale picture. Fields and photos travel separately — JSON for fields,
their own POST/DELETE for the photo — so creating an item with a photo is two
requests, and a failed upload leaves the record saved rather than losing the form.

### An item without a photo gets a drawing, and the drawing is never stored

Equipment with no photo shows one of sixteen illustrations — its **thumbnail**
(`app/src/equipmentArt.ts`) — so the catalog reads as a list of things rather
than a column of identical tiles. Shipping sixteen PNGs and seeding
`image_path` was rejected because it makes a default indistinguishable from a
real photo: every "has a photo?" check would need a second condition, "Remove
photo" would offer to delete something never uploaded, and a rename could strand
an item on the wrong picture. So `image_url` stays null until someone uploads,
and the drawing is a pure function of (name, type) built into an SVG data URI at
render time.

- **The name is consulted before the category**, because "Treadmill" says more
  than "Cardio". Matching is on whole words against a singularised name, so
  "Plates" finds `plate` and "Matrix" does not find `mat`; the order of the
  keyword table is what makes "Smith Machine" a rack and "Bench Press" a bench.
  An unrecognised name falls to its category, and an unrecognised category to a
  gym bag — `equipment_type` is free text, so that step is reachable.
- **The two colours are hardcoded** slate-500 and indigo-500: a data-URI SVG is
  its own document and cannot see `var(--c-*)`. Both clear 3.5:1 on the navy
  `bg`.
- **`equipment.thumbnail` lets an item pick its own** ("Landmine" is not a
  dumbbell). It stores the *key* of a drawing, never a path, and stays
  **nullable with no default**: null means "whatever the name implies", and a
  value written at insert would freeze the pick so a rename could no longer move
  it. The picker's **Automatic** stores null — a choice of nothing, not a
  seventeenth drawing.
- **Photo and thumbnail are independent.** A thumbnail is not a photo, so the
  picker stays live while a photo is staged — it is what shows if that photo is
  ever removed.
- **The key is a closed set** (`EquipmentController::THUMBNAILS`, kept in sync
  with `EQUIPMENT_ARTS`): a key with no drawing renders as an empty box, which
  cannot be told apart from a picture that failed to load. Both sides degrade:
  an unknown key falls back to the derived drawing, and the form sends null
  rather than echoing it into a 422.

### Exercises name their equipment as a string, and picture it anyway

`exercises.equipment` was free text long before the equipment table existed, and
it stayed a string — an FK would have needed a backfill guessing which row each
label meant. The link is kept honest the way `workout_sets.exercise_title` is:
**renaming equipment propagates into `exercises.equipment` in the same
transaction** (`EquipmentController::update`). Deleting equipment deliberately
leaves the label on the exercise, as deleting an exercise leaves its historical
sets alone — so the picker appends whatever value the exercise holds to its
options, or a stale label would leave nothing highlighted and no way to clear
it. `EQUIPMENT_OPTIONS` is the fallback vocabulary for an empty or unreachable
catalog.

Every place the Exercises screen names equipment — the form's picker, the
filter, each list row — draws the same picture the Equipment screen does:
photo, else pinned thumbnail, else derived. So `Exercises` keeps the whole
`Equipment[]` rather than mapping it to names. `Dropdown` takes
`renderIcon(value, size)` rather than an icon per option (five other callers
build options from plain strings); supplying it reserves the slot on every row,
the clear entry included, so labels stay in a column. A list row keeps its 44px
slot even with no equipment, left empty rather than boxed, so names stay
aligned. A name the catalog does not hold still gets a drawing from the name
alone. The screen's tests assert on `EquipmentImage`'s props — which item goes in
which slot — and which drawing comes out is `EquipmentImage`'s own test.

### Catalog pagination is opt-in

`GET /api/exercises` and `GET /api/equipment` page only when the request names a
`per_page`; otherwise they return every matching row (`PaginatesIndex`). A
default page size would silently shorten the two callers that need the whole
set — the exercise form's Equipment picker and the Workouts exercise picker —
and a missing dropdown option is a bug nobody reports.

`meta` is returned either way (`per_page` null when unpaginated). A page past
the end is clamped rather than 404'd, because deleting the last row of the last
page would otherwise strand the client, so screens follow `meta.page` back.
Filters are exact matches fed from the forms' own option lists, and a blank value
means no filter.

### The owner is a row in `users`, and reads are not scoped yet

Six tables carry `user_id`, and until PR #52 every row held null. That was
**Landmine 3**, and null was a poor name for the one owner twice over:

- **SQL treats each null as distinct inside a unique index**, so
  `unique(user_id, name)` on exercises and equipment enforced nothing; only the
  validator stood between the catalog and two "Bench Press" rows, and the CSV
  import does not go through it.
- **Null would change meaning the day auth lands**: new rows stamped with a real
  id beside every old row still null — one database silently cut in two.

`Owner::id()` answers from the database rather than the request, because three
of the nine writers (the 07:00 nudge, `save_insight`, `WorkoutWriter` under the
queue) have no request at all. **`BelongsToOwner` stamps `user_id` at
`creating`**, deferring to one already set, so a new write site cannot skip it —
the `MutatingTool` argument again. The columns are `not null`; `down()` relaxes
them but never re-nulls the ids. Nothing reads `$request->user()?->id` any more
(`ownerId()` is gone rather than kept as a fallback), which is why turning
Sanctum on in Phase 14 moved no data: signing in authenticates *this* row.

The owner has **no usable password**: it is random, hashed and discarded, because
a known default on the account that owns everything would be a worse landmine.
Google is the only way in — see *Sign-in*.

**Reads are not scoped by owner**, deliberately — with one owner it is invisible,
and a global scope is a surprise not worth adding speculatively. A second user
would *see* the first's rows, which is "multi-user is not implemented" rather
than a database quietly cut in two. `FitnessStatsService::muscleSplit()` already
dedupes the catalog by name for that reason. `agent_runs`, `agent_actions`,
`conversation_messages` and `snapshots` reach their owner through
`conversations`. **`documents` is the first table where this would hurt** — a
passport scan is personal in a way a workout is not — so the day a second
account can authenticate, scoping reads comes before anything else.

## Sign-in

Every route but a short, enforced list is behind the owner's Google sign-in
(Phase 14). Until then the perimeter was `projectmc.test` being Herd-only DNS,
with no login page and no identity.

### Google, the owner, and nobody else

`Services\Auth\GoogleSignIn` is the authorisation-code flow with PKCE, **written
out rather than Socialite**, which keeps its state in a session this API does
not have. What the flow needs from a session is one value for ten minutes, so
`POST /api/auth/google/start` puts `state → { verifier, nonce }` in the cache and
the callback **`Cache::pull`s it** — a state works once, so a callback URL that
leaks from a history or a log redeems nothing.

**Two locks, both on the owner row** (`Owner::user()`):

- **The email must be `AUTH_OWNER_EMAIL`** (case-insensitive). Blank means
  nobody, not everybody — an unset client id, secret or owner email is a 503
  sentence naming the three settings.
- **The first success pins the account's Google `sub`**; after that it must
  match. The email alone would hand the database to whoever holds that address
  next; the `sub` alone could not say who may sign in the first time.

A third lock is on Google's side: the consent screen stays in **Testing** with
only the owner as a test user. `EnsureOwner` (`owner`) sits behind `auth:sanctum` and
refuses any token not held by the owner row — it never fires today, since only
the owner can be issued one, and it is there because **reads are not scoped by
owner**: any second account that could authenticate would see everything.

- **The id token's signature is not checked**, as Google allows for a token
  taken straight from its token endpoint over TLS for a code only our secret can
  redeem. Its claims are: `iss`, `aud`, `exp`, the **nonce** and
  `email_verified` (the string `"true"` too — some accounts carry it).
- **Every attempt is a `sign_ins` row**, refusals included — a refused attempt
  leaves no token and would otherwise leave nothing. The outcome is `ok`,
  `refused` (a 403: wrong email, wrong `sub`, unverified) or `failed` (a 400
  state/exchange/id-token, a 502 unreachable Google, a 503 unconfigured).
- **Nothing quotes the code or the token**, and Google's own error body is not
  repeated (it can echo the request). Both auth routes are `throttle:10,1`.
- `prompt=select_account` every time, so a browser signed into two Google
  accounts is asked rather than quietly handing over the default.
- A success refreshes the owner's name, email and avatar and sets
  `last_login_at`; the token is named for the device (`DeviceLabel`, from the
  user agent) and records its IP and user agent.

### A bearer token, because the app and the API are two sites

`projectmc-app.test` and `projectmc.test` are **different sites**, so a Sanctum
session cookie would be a third-party cookie, which browsers refuse. So a sign-in
issues a **Sanctum personal access token**, sent as `Authorization: Bearer`,
kept in `localStorage` under `projectmc.auth` (`auth.ts`, every access in
try/catch, with an in-memory copy when storage throws). Sanctum's `guard` is
`[]` — bearer only. Tokens last `AUTH_TOKEN_DAYS` (30) from when they were made.

- **Every app request goes through `apiFetch`** (`api.ts`), which adds the
  header. **A 401 anywhere drops the token and shows Login**
  (`notifyUnauthorized` → `AuthProvider`), which is how a session revoked from
  another browser, or expired, finds out.
- **A guest gets a 401 JSON sentence** (`Sign in first.`), never a redirect:
  `redirectGuestsTo(null)` plus an `AuthenticationException` renderer, because
  Laravel's default redirects to a `login` route that does not exist — a 500 for
  curl or an `<img>`.
- **`AuthProvider` has four states**: `checking`, `signedOut`, `signedIn` and
  **`offline`**. A token the API could not be *asked* about is not one it
  refused; throwing it away because Herd was restarting would make the owner sign
  in again for nothing, so `offline` keeps it and offers Retry.
- **Nothing polls before sign-in.** `App` renders `Gate`: Login
  (`screens/Login.tsx`), or the providers and the shell — which is where the
  health poll lives, so it does not mount on the login screen.

### Google returns to localhost, and the page forwards itself

**Google refuses `.test` redirect URIs and origins** — only public TLDs and
`localhost`. So `GOOGLE_REDIRECT_URI` is `http://localhost:8082/auth/callback`:
the **same Expo dev server** under a name Google accepts. Expo serves
`index.html` for any path, so no static bounce page is needed.

`callbackStep()` (`auth.ts`, pure, tested without a browser) reads the load:

- **On any origin but `EXPO_PUBLIC_APP_URL`**: `bounceIfNeeded()` does
  `location.replace` to the same path and query on `https://projectmc-app.test`,
  **before anything renders** — no provider, no poll, no half a HUD on an origin
  about to be replaced.
- **On the app's own origin**: the `state` is compared with the one this tab
  kept in `sessionStorage` (read once, then forgotten) before anything is sent,
  the code is posted, the token stored, and `history.replaceState` puts the
  address back to `/`. A cancelled consent reads "Sign-in was cancelled."

### The route table is checked, not remembered

`routes/api.php` has two sections: **outside the gate**, each route saying why,
and one `['auth:sanctum', 'owner']` group holding everything else.
**`RouteGateTest` fails on any `api/*` route that is neither gated nor listed in
`RouteGateTest::PUBLIC`** — with the middleware it must carry — so a new route
cannot skip the gate by being written outside the group. The `MutatingTool`
argument again. The public list is:

- the two sign-in routes (`throttle:10,1`);
- **`GET /api/health`**, so the PowerShell checks above work without a token —
  it names no row, holds nothing personal, and says of the MCP token only
  whether one is set;
- **`POST /api/mcp`** (`api.token`);
- the five **signed** reads, below.

`auth` already sorts ahead of `SubstituteBindings`; **`owner` and
`ValidateSignature` are prepended ahead of it** in `bootstrap/app.php`, for
`ApiToken`'s reason — otherwise a forged or anonymous request for a bound model
answers 404 or 401/403 depending on whether the row exists.

### What cannot send a header gets a signed URL

Two `<img>` tags (equipment photos, camera frames), an `EventSource` (the run
stream), a new tab (a filed document) and an `<a download>` (a diagnosis's
`.md`) cannot carry `Authorization`. Each URL is **minted, signed and
time-limited inside a response that did pass the gate** (`Support\SignedUrl`),
so holding one is proof the gate was passed a moment ago.

- **Pictures and documents expire at the end of the next UTC day**
  (`picture()`, `file()`), not "a day from now": a
  moving expiry is a new URL on every read, which is a new download, which is
  exactly what the photos' `immutable` caching (and `?v=`) exists to avoid.
  Pinned to a day boundary, every read in a day mints the same URL, and a HUD left
  open overnight still has one good for 24h.
- **The run payload carries `stream_url`**, absolute and signed for 30 minutes.
  The route is `signed:after`, so a client may append `&after=N` without
  breaking the signature — it is a cursor, not a grant. `watchRun` takes the URL
  as given and **polls without one**; an expired URL errors the `EventSource` and
  polling takes over, as it always did.

### `last_used_at` is written at most once a minute

Sanctum stamps `last_used_at` on every authenticated request — here, every 5s
machine poll and 15s health poll while the HUD is open: a steady writer against
the WAL database (*Platform traps*), for a column nobody reads more finely than
"a minute ago". `Models\PersonalAccessToken` **drops a touch that changes only
the time while the stored one is under `TOUCH_SECONDS` (60) old**, and the touch
that lands records the IP.

### Profile is the account, its sessions, and who tried

The core menu's **08 Profile** panel, always the last — the owner's Google photo and name as its
head (initials if the photo fails), the address as a readout, and **Sign out**
as a row, because leaving is what people most often come to a profile for. Its
title opens the **Profile** overlay (`components/ProfileView.tsx`), one page of
`StatParts` cards like Stats: **Account** (linked since, last sign-in, timezone,
MCP token set or not — never the value), **Sessions & devices** (Revoke each,
or **Sign out everywhere else**) and **Sign-in history** (the last 20, refusals
in amber with their reason).

- **Read on open, never polled** — a new session is a sign-in somewhere else,
  which is rare and shows the next time it opens.
- **Revoking is not optimistic**, for `useServerSettings`' reason: the list is
  re-read from the answer, a 404 (already gone) included.
- **This browser's own row has no Revoke.** Revoking it is signing out, which is
  the Sign out button — it also clears the token here. A Revoke on its own row
  would leave the page holding a token the server had just thrown away.
- **The bulk revoke is `DELETE /api/auth/sessions?others=1`**, spelled out, so a
  client that drops an id cannot sign out everything.
- **The account is `AuthProvider`'s**, handed down (`Hud`'s `account` prop);
  without one there is no Profile panel.

**`php artisan auth:token {name}`** mints a token without a browser, for the
smoke tests below. It is an ordinary session: it shows in Profile, expires with
the rest, and is revoked the same way.

## The assistant

### The tools are objects in `app/Agent`, and every driver uses the same ones

The assistant is driven three ways — Claude Code over MCP, this app's own chat
loop, and the spoken assistant — and the durable asset in all three is the
**tool layer**. `Tool::schema()` returns literally the array the Messages API
takes as `tools`; MCP's `tools/list` differs by one key (`input_schema` →
`inputSchema`, renamed in `McpServer::toolDefinitions()`), so one definition
serves every driver.

- **Schemas are hand-written**, not derived from the Laravel rules: a parameter
  description is the highest-leverage part of a tool definition, and rules carry
  none. Tests keep them honest instead — every `required` is a subset of
  `properties` (recursively; `log_workout`'s real contract is three levels down),
  and fields and enums must agree with the writer that accepts them.
- **Each tool validates its own input and throws.** A thrown exception becomes a
  `tool_result` marked `is_error`, which is how the model sees its mistake and
  corrects it. A 500 would end the conversation. `ToolRegistry::attempt()`
  renders that once, so MCP and the loop show the same words.
- **Two limits are server-side whatever the schema says**, because a schema is a
  hint to a model: `limit` clamps to 50, and `ResultEncoder` caps a result at
  20KB. A result is re-sent on every later turn, so over-budget results drop
  rows from their longest list **and say so** — silent truncation would let the
  model answer "you trained 12 times" off a list cut at 12.
- **Tools project fields explicitly** and never `toArray()` a model
  (`Workout::$appends` would ship four extra fields on every row).
- **`AgentServiceProvider::TOOLS` is append-only**, for a cost that does not
  exist yet: **nothing in the backend sets `cache_control`**, so today
  reordering or renaming costs nothing. The rule is kept because the definitions
  would be the bulk of a cached prefix the day caching is turned on, and by then
  the ordering is years of habit. `list_events` kept its name and slot when its
  source changed; `save_facts` went on the end. The facts block sits after
  `TOOLS` for the same anticipated reason — it is the one part of the prompt
  that changes between two turns of the same day. Agents (Phase 17) break the
  bet in one known way: a toggle changes the `tools` array, so caching would
  keep a prefix per combination of enabled agents.
- **`MutatingTool` is a marker interface**, not a list kept elsewhere, so a new
  write tool cannot skip the confirmation gate; a test asserts every tool whose
  name starts with a writing verb declares it (the verbs are that test's own
  list, so a write with a new one — `pin_articles` was — adds its verb there).
  The gated-tool list in the system
  prompt is derived from the registry for the same reason. **`LocalTool` is its
  parallel** — a tool whose effect lands on this machine rather than in the
  database — so `ToolRegistry::withoutLocalTools()` filters generically instead
  of naming `OpenOnThisMachine` wherever an unattended run needs it excluded
  (see *Automations are rows, delivered on first load*). **`Tool::group()`** is
  the third declaration of the kind: every tool names its `CapabilityGroup`, and
  `ToolRegistry::forGroups()` is what a switched-off agent cuts with (see
  *Agents are rows over code-supplied capability groups*).

Seventeen tools always: eleven reads (`get_fitness_stats`, `list_workouts`,
`get_workout`, `search_exercises`, `list_equipment`, `list_events`,
`get_weather`, `search_documents`, `list_deadlines`, `get_news`,
`list_pinned_articles`) and six writes (`log_workout`, `update_workout`,
`create_exercise`, `save_insight`, `save_facts`, `pin_articles`). The Records
tools (see *Records*) went on the end of `TOOLS` after a write, and the three
news tools (see *News*) after them in the order they arrived, a write between
two reads — the append-only rule doing what it is for.
`open_on_this_machine` is added where the machine opts in, and the voice
registry adds `show_google_calendar` (below). "Always" is the catalog: a
switched-off agent takes its groups' tools out of what the model is offered.

`WorkoutWriter`, `ExerciseWriter`, `WorkoutTranscript` and the `FiltersCatalog`
scopes were extracted before the tools existed, and each removes duplication
that predates the agent (`store()`/`update()` were ~95% the same). The proof the
extraction preserved behaviour is that the controller tests passed unchanged.

### The MCP server is hand-rolled, over HTTP, behind a shared secret

`POST /api/mcp` (`McpController` → `Agent\Mcp\McpServer`) implements four methods
— `initialize`, `ping`, `tools/list`, `tools/call` — over the registry.

- **Not `laravel/mcp`**, which was a beta when this shipped: a beta dependency in
  a write-capable request path costs more than ~200 lines, and a stateless
  tools-only server needs none of its parts. Sessions, resources, prompts and
  sampling are declined honestly in `capabilities`.
- **Streamable HTTP, not stdio**: stdio is a second application lifecycle to
  keep working on Windows, for an app Herd already serves. A `GET` 405s, which
  tells a host this server never opens a stream of its own.
- **A failed tool call is a successful protocol exchange** — `isError: true`
  inside a 200, so the model can retry. Only an unknown tool name is `-32602`.
- `readOnlyHint` is derived from `MutatingTool`, so a write tool cannot
  advertise itself as safe. **There is no confirmation gate on this path**: MCP
  hosts prompt the user themselves.
- **`tools/list` is scoped by the agents**, like the loop's: a switched-off
  agent's tools are not listed, and calling one anyway is "Unknown tool". A
  host is sent `TOOLS` alone, so nothing tells it *why*.
- **`ApiToken`** (aliased `api.token`, applied to the MCP group alone — the
  app carries its owner's sign-in instead) compares `Authorization: Bearer` to
  `config('agent.token')` with `hash_equals()`. **A missing secret closes the
  route (503)** rather than opening it. It authenticates a machine, not a user.
  It is sorted **ahead of `SubstituteBindings`** (`prependToPriorityList` in
  `bootstrap/app.php`), or an anonymous request to a
  route with a bound model answers 404 or 401 depending on whether the row
  exists — an existence oracle beyond the gate. `/api/mcp` binds nothing; the
  owner's gate, which does, is sorted the same way (see *Sign-in*).
- `throttle:agent` caps it at 30/min: a client stuck retrying a tool-calling
  endpoint spends money, not just CPU.

### The chat routes carry the owner's sign-in, not the MCP token

`/api/agent/*` once sat behind the MCP token. **Every `EXPO_PUBLIC_*` value is
inlined into the web bundle**, so any token the page could send from its build is
one anyone loading the page can read. Shipping the MCP token publishes it; a
second app-only token is a gate everyone holds the key to. So the chat routes
were ungated until Phase 14, and they now sit behind the owner's sign-in like
every other app route: a token **issued per browser at sign-in** and kept in
`localStorage`, never part of the bundle (see *Sign-in*). That is what separates
it from the `EXPO_PUBLIC_*` token that was never a secret.

The sign-in decides *who*; what stands between the model and the database is
still the **confirmation gate**. `/api/mcp` keeps its own token, because a host
is configured with a credential anyway and it is the route that might one day
face off-machine. `AGENT_API_TOKEN` is therefore MCP-only, and a checkout without
one still has a working assistant (asserted).

### The persona is in the loop's prompt, not the shared instructions

The assistant answers as a butler — addresses the owner as Sir, composed and
discreet, corrects the owner when they are wrong, never dresses a guess up as a
fact.
`Instructions::TOOLS` is sent **verbatim by both drivers**, and an MCP host
prepends it to its own prompt — so a persona there would be this app telling
Claude Code how to address its user in unrelated sessions. `Instructions::PERSONA`
is separate, sent by the loop alone, and **leads** the prompt; `InstructionsTest`
asserts both halves of that split, because a later "everything in one place"
tidy-up would quietly undo it.

**The persona's last sentence is load-bearing**: it bans the theatre ("very
good, sir"), because a flourish every turn stops reading as courtesy. The two
unprompted writers — the weekly assessment and the 07:00 nudge — keep "address
the user as you", word caps and no greetings; adopting "Sir" there means
rewriting those prompts, not prepending to them — which the owner can now do in
Assistant → Instructions. What this section describes is the **default**; see
*The instructions are the owner's to reword*.

**`Instructions::SCOPE` follows the persona, and says the assistant is for
everything.** Asked about the weather before `get_weather` existed, it offered
"your training log, calendar events, or exercise records instead", reading the
list of tools as a list of permitted subjects. So the loop is told to answer
anything that does not need the user's data from its own knowledge, use a tool
when it does, and say plainly when something live is out of reach. It is
loop-only, like the persona: telling an MCP host what it may answer would be
the same overreach in the other direction (asserted). **The news came off its
out-of-reach list** when `get_news` arrived (19.1) and joined what a tool can
see; prices and scores are still named as things it cannot look up.

### The assistant knows the owner, and that knowledge is a prompt block

A `facts` table of short claims — category, key, one sentence — is rendered by
`Services\Facts\FactsBlock` as the **last section of the loop's system prompt**,
after `TOOLS`. Everything else about Phase 15 follows from that one choice.

**A block, not a `recall_facts` tool.** A tool is one the model has to think to
call, and the facts that matter most are exactly the ones nobody asks about
directly: "doesn't eat pork" has to shape a meal suggestion that never mentions
food preferences. In the prompt it shapes every answer, typed or spoken, for a
few hundred tokens a turn. **Voice gets it for free**, because
`Instructions::systemPrompt()` is one builder; **MCP never sees it**, because a
host is sent `TOOLS` alone.

- **Capped at 2KB, newest first**, and past the cap the block ends with "N older
  facts are not shown" — so the model knows its memory has a horizon rather than
  believing it knows everything. A `search_facts` tool comes when that line
  starts appearing, not before. An empty store renders nothing, not an empty
  heading.
- **Each line carries its date and its confidence**, and the guidance paragraph
  says how to hold them: an old one may be out of date, an `inferred` one is the
  model's guess and never the owner's word. **It does not narrate its memory**
  every turn (open question 1's default) — it mentions a fact only when that
  fact is the reason for the answer, and then says it is what it has on file,
  which is how a wrong one gets noticed.

**One live claim per key, and the history is kept.** `Services\Facts\FactWriter`
is the only writer, `WorkoutWriter`'s rule, because the thing that matters is
two writes that must land together: the new row `active`, the old one
`superseded`. The index that enforces it is **partial** —
`unique(user_id, category, key) where status = 'active'`, created with
`DB::statement` because the schema builder cannot express it — since a plain
unique would forbid keeping the old row at all. Category and key are lowercased
and trimmed (they are what the index compares); the value is the owner's words.
Re-saving the value already active is a no-op, or a restated preference would
bury its real date under a fresh one.

**Four statuses, and two ways for a fact to end.** `proposed` waits for the
owner; `active` is in the prompt; `superseded` is history. **`rejected` is a
tombstone, not a delete** — the extractor reads it so a refused claim is not
proposed again every evening. **Forget is a hard delete**, of the key and its
superseded history: the owner asked for it gone, and a tombstone would be the
app keeping it anyway. Rejections for that key survive a forget, because they
are refusals rather than knowledge. A decision that finds its fact already
decided (another tab) throws `FactNotPending`, which the API returns as a 409 —
never a second write.

**Facts arrive three ways, and the third asks first.**

- **The owner types one** on Facts → Tell me something: `manual`, `stated`,
  active at once.
- **`save_facts`** (a `MutatingTool`) takes an **array**, so "remember I don't
  eat pork and I take my coffee black" is one approval card rather than two —
  two cards for one sentence teaches the owner to wave them through. Validated
  whole and written in one transaction, so a bad third item leaves the first two
  unsaved rather than half the sentence on file. Its description confines it to
  what the user asks to have remembered or plainly states as lasting; passing
  remarks are the extractor's job. Typed chat and MCP only — **voice stays
  read-only**, so a spoken fact reaches the store through extraction.
  `conversation_id` is null: a tool is handed its arguments and nothing about
  the thread it was called in.
- **Extraction proposes** (below), and a proposal reaches the prompt only once
  it is kept.

**Extraction reads a conversation once it has gone quiet.** Nothing marks a
thread finished, so `Services\Facts\FactExtractor` calls it finished at **20
minutes idle with messages past its watermark**
(`conversations.facts_extracted_through`). Its own `everyMinute` schedule entry,
not a line inside the heartbeat closure — a query that throws on an unmigrated
checkout must not take the heartbeats down with it, which would report a live
scheduler as dead. The migration set every existing thread's watermark to its
newest message, so deploying it spent nothing, and a thread picked up again
later is read from the watermark rather than twice.

- **One paid call per thread**, on the chat model, with the answer held to a
  **JSON schema** (`ClaudeService::complete(schema:)`) rather than a forced tool
  call — a forced tool would have meant giving up thinking for it.
- **It proposes, never saves**, and the watermark moves **only after a parsed
  answer**, so a failure re-reads the same ground. `Jobs\ExtractFacts` has
  `tries = 1`, the nudge's rule. The claim (`Cache::add`, an hour) is what
  spaces the retries.
- **The switch stops it twice**: the scheduler dispatches nothing while it is
  off, and `client()` refuses anyway. At most five threads a tick, ten proposals
  a call: caps sized for a bug, not a person.
- **A thread with nothing the owner said** — tool results, a frame with no
  words — is marked read without a call at all.
- **Rejections are filtered here as well as shown to the model**, because being
  told not to propose something is not the same as being unable to.
- **What extraction costs is in Activity's totals, not on a line of its own.**
  It is a `complete()` call, and `ClaudeService` records every paid call in the
  usage ledger (see *Assistant → Activity*); nothing says which rows were
  extraction's.

**The Facts overlay is a trust surface, not a management system**
(`components/FactsView.tsx`, the core menu's 05 Facts title): three cards — To
review, What I know, Tell me something — with no filters and no pagination,
because facts are never the point of a screen and the 2KB cap keeps the whole
set a page long. Read on arrival, never polled, like Profile. **Nothing is
optimistic** (`useServerSettings`' rule) and one write is out at a time. **Only
Forget asks first**: a rejection leaves a tombstone and a keep can be forgotten,
so neither is irreversible. A proposal for a key already on file is shown beside
what it would replace. The panel head says **"N to review"**, the way Assistant
says "new reply", polled every 60s only while the menu is out.

Three commands, from `backend/`:

```powershell
php artisan facts:add food coffee "black, no sugar" # active at once, source manual; --inferred for a guess
php artisan facts:probe "what should I cook tonight?"   # the same question with and without the block — two paid calls
php artisan facts:extract                               # read the latest thread now, rather than waiting 20 minutes
```

`facts:probe` is the **premise test** the epic was gated on: it asks one
question twice through the full system prompt, once with the block and once
without, and prints both. If the answers had not differed in useful ways,
Phase 15 would have stopped at the store.

### The chat loop is written by hand and parks itself in the database

`AgentRunner` is a manual loop, not the SDK's `toolRunner()`, because it has to
**stop in the middle and resume in a later request**: a write happens only after
the user approves it, and a generator cannot be parked in SQLite. So the loop's
position is in the schema — `conversation_messages` says how far it got,
`agent_actions` what it is waiting for. The same property is what later let it
move onto a queue unchanged.

- **`content` is always a list of wire content blocks.** An assistant turn is
  stored as `json_encode($response->content)` verbatim, thinking blocks and
  signatures included, so replay is byte-identical — which the API requires when
  a tool call follows a thinking block. `MessageCodec` does no case mapping.
- **`ClaudeService::turn()` returns the wire shape, not SDK objects**, because
  of two SDK traps: `$response->stopReason` throws, and a block rehydrated from
  snake_case leaves typed properties uninitialised, so `->toolUseID` fatals on a
  replayed turn. It sits beside `complete()` (one string in, one out), which the
  weekly insight still uses.
- **The assistant turn is persisted before any tool runs** — a tool that fatals
  loses its own result, which the model survives; losing the turn that asked for
  it leaves a transcript that cannot be replayed.
- **Every parallel `tool_use` is answered in one user message**; splitting them
  teaches the model parallel calls are not worth making.
- **Hitting the iteration ceiling answers** with one last `toolChoice: none`
  call instead of throwing after a dozen paid round trips.
- **`agent_actions` holds every tool call**, reads born `approved` and writes
  `pending`, because a turn's read results must wait somewhere until its write
  is decided and all `tool_result`s go back together. "What has the assistant
  changed" is `where requires_confirmation and status = 'approved'`.
- **Deciding twice cannot write twice**: `decide()` claims the row with a
  conditional `update … where status = 'pending'`, and `tool_use_id` is unique.
- **A message while a write is undecided is a 409**, not a queue: the transcript
  ends with an unanswered `tool_use`, and appending to it is a request the API
  refuses. Thinking blocks are dropped from responses by `TranscriptPresenter`,
  never from storage.

### The loop runs on a queue and is watched through a table

`POST /messages` stores the user's turn, queues `RunAgentTurn`, and answers
**202 with a run id**. The job appends to `agent_run_events` — text as it is
written, each tool as it starts and returns.

- **The events are a presentation of the run, never its record.** Every event
  duplicates something written to `conversation_messages` or `agent_actions`,
  so a client that hears none of it and re-reads the thread ends up identical.
  That makes the stream safe to cap, drop, resume and miss; the screen throws
  the live view away and re-reads the thread when a run ends.
- **The table exists because the job and the stream are different processes**
  (no shared memory, no Redis). `GET /runs/{id}/stream` (SSE) and `GET
  /runs/{id}` (polling) are the same log through two transports, and polling is
  the baseline: React Native has no `EventSource`. `seq` is the resume token —
  `Last-Event-ID` or `?after=`.
- **The closing event ends the stream, not the row** (the row is written a
  moment earlier; breaking on it loses the event). A terminal row with no event
  — a killed worker — gets two seconds.
- **Deltas are coalesced** on a time bound *and* a size bound, and anything that
  is not a delta flushes first; otherwise prose written before a tool call
  arrives after it.
- **A failed run is reported on the run** (`agent_runs.error`) — nobody is
  waiting on a response, and no turn is written.
- **One run per conversation.** Two loops appending to one transcript produce a
  transcript the API refuses.

`ClaudeService::turn()` **always streams**, reassembled by `StreamAccumulator`
into the same array shape. Thinking is `summarized` (`ANTHROPIC_THINKING_DISPLAY`)
because an eight-second think otherwise looks like a frozen page; the summary is
stored and re-sent, which is why it is a setting (Assistant → Settings → Reasoning). **Deltas arriving early needed
`StreamingTransport`**: Guzzle's PSR-18 `sendRequest()` drops `stream`, so curl
buffered the whole body, and PHP's stream layer then buffers 8KB per read. It
uses `send()` with `stream => true` and `stream_set_read_buffer($resource, 0)`.
Without both, streaming is correct and indistinguishable from not streaming.

### A deterministic check decides whether the assistant speaks first

Asking Claude every morning whether anything interesting happened pays to hear
*no* most days, and a model asked daily for news will eventually find some.
So `Services\Fitness\ProactiveTriggers::check()` decides **whether**, and the
model only writes the prose. Four triggers, all from one
`FitnessStatsService::build()` payload: a layoff of ≥4 days, last completed
week's hard sets down >30% on the mean of the three before, a PR dated
yesterday, a muscle group under an 8% share. `check()` is a pure function of
that array (today is `range.to`), unit-tested off array literals. Each trigger
carries a finished `summary` sentence, and that is what the model rewrites — so
the numbers in the nudge stay true.

- **The window is 12 weeks**, and **both end buckets are dropped**: the first is
  clipped by the window, and the last is the week in progress (reading it as
  "last week" reports a collapse every Monday). Weeks start on the day Fitness →
  Settings names, and the triggers only read buckets, so a Sunday origin needs
  nothing of their own (asserted).
- **What the owner switched off is filtered after the check** — see *Fitness
  settings are split by who reads them*, which is also where the time and the
  on/off switch live now.
- **Two silences are deliberate**: a layoff past 45 days does not fire (a dormant
  database is not a lapse), and a zero-session week produces no volume trigger
  (the layoff says it better).
- **The cooldown is per trigger**, each with its own window; `muscle_gap` gets
  28 days because a split that neglects glutes today does next week too.
- `GenerateProactiveInsights` writes `kind: 'proactive_nudge'` into `insights`,
  so it needs no client surface of its own, and has `tries = 1` — a retry
  re-pays to fix what is usually an outage, and tomorrow covers it.

It is silent by design, so `php artisan proactive:check` runs the same free
check and prints the result without dispatching anything.

### Automations are rows, delivered on the HUD's first load

An **automation** is a scheduled conversation: a name, a time, what it is for,
and which context it may bring with it. Row one, seeded disabled, is *Morning
greeting*, 06:30, agenda + weather + training.

**It is the nudge's opposite, and the two are not merged.** The nudge asks
whether anything is worth saying and is usually silent; an automation **always
speaks**, because the owner asked for it at that hour. So there is no condition
language on a row — inventing one would be rebuilding `ProactiveTriggers`
badly — and no automation decides anything for itself.

**Delivery is the first HUD load past the hour, never a cron tick.** A greeting
written at 06:30 by a worker and found at 09:00 is a message timestamped before
anyone sat down. So nothing is written until the HUD asks: `useDueAutomations`
posts `/automations/due` **on arrival and each time the tab comes back**, the
two moments somebody has just started looking. (The desk-only assumption is
deliberate and was re-confirmed when the hosting epic was parked; a phone push
would change this trigger and nothing else.)

- **The claim is the server's**, not the hook's: `due()` claims each eligible
  row with a conditional update on `last_run_on` before dispatching — the shape
  `AgentAction::decide()` uses — so two tabs open at once cannot both fire one
  greeting, and asking twice a minute is free.
- **A claim is not a delivery.** Assembling the turn fetches the agenda and the
  weather, which has no business happening inside the request that claimed it,
  so the conversation does not exist yet when the claim answers. The hook polls
  the claimed rows until `last_run_at` moves past the claim, then hands the
  conversation up. Bounded both ways (4s × 20), so a dead worker costs a handful
  of reads rather than a loop all day.
- **A failure here is silent.** The row's own outcome is in the Automations
  overlay, which is where "why didn't it run?" is asked. What the hook must
  never do is invent a delivery.

**The first turn is assembled, stored, and not drawn.** `AutomationRunner`
joins the intent, the current time and a fetch per named context piece —
`list_events`, `get_weather`, `get_fitness_stats`, `list_deadlines`, `get_news`,
called through `ToolRegistry::attempt()` directly rather than through a turn —
into one plain
`user` message, then queues an ordinary run. From there it is the same job, the
same transcript, the same confirmation gate.

- **The time is named outright**, not left to the system prompt's date: a first
  load at 15:00 needs an afternoon greeting, not "good morning".
- **`facts` is in `Automation::CONTEXT` but fetches nothing** — facts are
  already in the system prompt on every turn. It is a readout on the card, and
  a stored value survives because the toggles rebuild the array from the row.
  **They rebuild it by filtering the app's `AUTOMATION_CONTEXT`**, so a value
  the server allows and the app does not list is dropped by the first click —
  which is why `deadlines` reached the app in the same PR as the server.
- **`deadlines` brings the next fourteen days and anything overdue**
  (`AutomationRunner::DEADLINE_HORIZON_DAYS`): long enough to act on a renewal,
  short enough that a date a year off is not read out every morning. It is the
  whole of how a deadline speaks unprompted — see *Records*.
- **`news` brings the local beat, then the owner's interests when any are set**
  (19.4), **through `get_news` itself** — so a greeting marks what it hands over
  as told, and "what's the news?" later that morning flags those stories as
  repeats (see *News*). With no interests the second fetch is skipped: the tool
  would answer with a sentence about where to set them, which is not a greeting.
  Appended after `facts`, on both sides in one PR — the `deadlines` lesson.
- **The message carries `meta.automation_id`** (a new nullable json column), and
  `TranscriptPresenter` drops it the way it drops thinking blocks: the owner
  reads the greeting, not the prompt that asked for it. `MessageCodec` needed no
  change — it sends `content` verbatim whatever else the row holds.
- **Assembly happens before the conversation is created**, so a failed fetch
  leaves no orphan thread — only an outcome.
- **The switch off is `skipped`, not `failed`** (the Anthropic switch's rule: a
  decision is not a fault). Anything else that throws is `failed` with the
  message kept, and rethrown so `Jobs\RunAutomation` (`tries = 1`) logs it.
- **`AgentRun::TRIGGER_AUTOMATION` changes exactly one thing**: `RunAgentTurn`
  builds its runner on `ToolRegistry::withoutLocalTools()`, because nobody is at
  the machine an unattended run could open a window on — and the worker has no
  desktop anyway (see *The assistant reaches this machine*).

**The Automations overlay** (`components/AutomationsView.tsx`, the core menu's
06 Automations title) is one card per row plus an add card; new rows are created
**switched off**. Nothing is optimistic, one write at a time, and text fields
are drafts committed on blur (the nudge time's rule) — **resynced from the row's
values *and* a write counter**, which is the pair that makes both halves true: a
refused rename is pulled back rather than left looking saved, while the Run-now
loop's background re-reads leave a half-typed field alone. **The time is the
browser's own picker** (`DateTimeInput`, shared with Fitness → Settings' nudge
time and the workout form's date and times), so the only thing it can hand back
that is not a time is nothing at all: an emptied field is a clear, and the
stored time goes back rather than a complaint — an emptied name or intent's
rule. **Run now is
watched**, because the endpoint answers when the job is queued, not when it ran.
**It works on a row that is switched off, and the card says how it went**: Last
run reports any run that happened, and reads "switched off" only in place of
"never" — the card's head already says the row is off. It used to put "switched
off" ahead of the outcome, which made the press look like it had done nothing.
`run` and `due` carry `throttle:agent` (they can spend money); plain CRUD does
not.

**A delivered thread is switched to only when nothing would be lost** — no run
going, no write parked, no call, nothing staged or typed, the Assistant not
already open. Otherwise it lights "new reply" and waits, and `openAssistant`
lands on it, because the answer to whatever you were in the middle of would
otherwise arrive in a thread you had just been moved out of. **Looking at it is
what clears it** (the Assistant open on Chat, on that thread), not the switch.

A delivery that can be *heard* rather than read offers a card under the core and
borrows the microphone — see *The spoken assistant is the same assistant*.

### The Anthropic switch is a row in the database

Six paths spend money: the weekly assessment, the chat loop, the 07:00 nudge,
the spoken turn, fact extraction and an automation's delivered conversation.
Deleting `ANTHROPIC_API_KEY` to stop them needs an editor
and a cache clear, and makes a machine kept quiet on purpose indistinguishable
from an unfinished one. `AnthropicSwitch` is the control, in a `settings` row:

- **Not `localStorage`** — the nudge fires on a worker at 07:00 with no browser
  open, and a switch the scheduler cannot see is decoration.
- **Not the cache** — a flush turns a switch that was *off* back on, with the
  invoice as the first evidence. A row fails the safe way.
- **Not a second `.env` flag** — two switches give "why is it quiet?" two
  answers. The default is `true`, in one constant.

**The gate is `ClaudeService::client()`**, the one method every paid call goes
through, checked **before the memoised client is returned** (a worker holds the
instance for an hour). Entry points check it *as well*, only to fail early:
`POST /messages` 503s **before storing a turn**, and the voice token route
refuses so a session never starts. Extraction checks it in the scheduler, so a
switched-off machine queues nothing at all, and an automation checks it in the
runner, which records `skipped`. **Two paths are not gated**: `/api/mcp` spends
the host's money, not ours, and deciding a parked write stays open so a
conversation cannot be stranded (the continuation fails harmlessly).

**`off` is its own state beside `up` and `down`, and does not spoil `ok`** — a
decision is not a fault, and a status light that calls it one teaches people to
stop reading it. An amber **`AI OFF`** chip sits beside the pill when it is off;
there is no `AI ON` chip. There is no `GET /api/settings`: `/api/health` already
reports it on the shell's 15s poll, and the write answers with the new state.

**The switch lives in Assistant → Settings** (`components/AssistantSettings.tsx`),
moved out of the HUD's Settings in 13.0 so it sits beside the other things that
decide what the assistant spends; the HUD's Settings has a footnote saying where
it went. Its row and route did not move.

### An empty Anthropic account is a refusal, recorded

**Anthropic has no API that reports a prepaid balance**, so the app shows no
Claude balance — only an estimate of what it spent (Assistant → Activity, below).
What it can know for sure is what a refused call proves:
`ClaudeService::billed()` wraps both `complete()` and `turn()`, and a
`billing_error` (a 402), or the older 400 whose message says "credit balance",
anywhere in the exception chain is recorded by `AnthropicCredit` and rethrown as
`AnthropicOutOfCredit`, a sentence in place of the SDK's JSON dump. A stream can
be refused part-way through (an `error` event), which is why `turn()` iterates
inside the wrapper.

- **A row, not the cache** (`anthropic.credit_exhausted`), for the switch's
  reason: the nudge and extraction fail on a worker, and a flush would turn an
  empty account back into a green light.
- **It clears itself on the next call that goes through**, and **it never blocks
  a call**. A flag that stopped calls could only be cleared by hand, and a
  top-up would look like it had not worked. The clear reads before it writes,
  so a healthy machine adds no writer per call.
- **`since` is the first refusal**; `last_refused_at` moves.
- **It is not a fifth state.** The key is fine (not `down`) and nobody chose it
  (not `off`), so `/api/health` carries `assistant.credit` beside the state,
  and `ok` is untouched: the pill is about this machine, and this is the
  account. A red **`NO CREDIT`** chip sits beside `AI OFF`. Red, because the
  core is red too: `whyUnavailable()` names the account. Assistant → Settings'
  status line says how it clears, and Diagnose reports `assistant.credit` as a
  problem.
- **Every surface says it as a sentence**: the typed run's error (no "Claude
  call failed:" prefix, which would make a top-up read like a bug), a 503 for
  the weekly assessment, and `VoiceTurnController::OUT_OF_CREDIT` for the agent
  to read out.

### Assistant settings are split by who reads them

Assistant → Settings is the Assistant overlay's last tab, and it follows the
question *Fitness settings are split by who reads them* asks: **does anything
without a browser read it?**

- **Browser-only** (`assistantPrefs.ts`, `AssistantPrefsProvider`, key
  `projectmc.assistant`): **announce new replies** (off keeps the menu title and
  the caption quiet) and **what opening the Assistant shows** — where you left
  off, or a new chat. Nothing but this screen reads them.
- **Rows in `settings`** (`Services\AssistantSettings`): the **chat model** (the
  tool loop, typed and spoken), the **insight model** (the weekly assessment and
  the 07:00 nudge), **effort** (every paid call), **thinking display**, the
  **iteration ceiling** and **camera frames re-sent**. The worker, the scheduler
  and a voice turn all read them with no browser open. `/api/health`'s
  `assistant.model` is the chat model's row.

The rules the rows keep:

- **`.env` is the default, not a second switch** — `FitnessSettings`' rule.
  `ANTHROPIC_AGENT_MODEL`, `ANTHROPIC_MODEL`, `ANTHROPIC_EFFORT`,
  `ANTHROPIC_THINKING_DISPLAY`, `AGENT_MAX_ITERATIONS` and
  `AGENT_SNAPSHOT_REPLAY` answer until a choice is saved. A row outside its
  closed set (hand-edited, a retired model) falls back rather than failing a
  paid call. An explicit argument to `ClaudeService` still wins over both.
- **Each is a closed set**: models `claude-sonnet-5 | claude-opus-5`, effort
  `low | medium | high`, display `summarized | omitted`, iterations `6 | 12 | 20`,
  replay `1 | 3 | 5`. **Replay is never 0**: the frame on the message being sent
  is one of those replayed, so zero would send the question without its picture.
  An `.env` effort outside the set (`xhigh`, `max`) is reported as it is and
  selects no radio.
- **A model change applies to threads already under way.** It replays thinking
  blocks signed by the other model, so this was checked live before shipping: a
  Sonnet 5 block replayed to Opus 5 in the middle of a tool loop, and the reverse,
  were both accepted. So there is no per-conversation model column. What a change
  does cost is the cached prompt prefix, once, because the cache is per model —
  the screen says so.
- **Voice is a read-only card**: whether the ElevenLabs key and agent are set
  (never the key), that audio goes to ElevenLabs, that voice cannot write, and
  whether local actions are on. Those are `.env` and dashboard settings, and a
  toggle here would be a second answer.
- **The screen is not optimistic**, for Fitness's reason: `useServerSettings`
  (now `components/useServerSettings.ts`, shared by both tabs) disables a
  section while its write is out and redraws from the answer.
- **`GET` + partial `PATCH /api/settings/assistant`**, by group (`models`,
  `reasoning`, `limits`). Limits must be real integers (`integer:strict`), and a
  `voice` block in a `PATCH` is ignored.
- **Two columns** like Fitness → Settings: the switch, Models and Reasoning on
  the left; Limits, Voice and Chat on the right.

### The instructions are the owner's to reword, and blank is the default

Five of the things Claude is told are editable in **Assistant → Instructions**
(`components/InstructionsView.tsx`, the tab between Agents and Settings):
the **persona**, the **scope**, the **spoken** addendum, and the whole briefs of
the **weekly assessment** and the **morning nudge**. `Services\AssistantInstructions`
is the one reader and writer. A rewording is a `settings` row
(`assistant.instructions.{key}`), read on every prompt, uncached, so it lands on
the next turn without a worker restart.

- **The code keeps every default** (`Instructions::PERSONA`, `SCOPE`, `SPOKEN`,
  `InsightController::PROMPT`, `GenerateProactiveInsights::PROMPT`), and
  **blank means the default, never "no instructions"** — the agents' guardrail
  rule (the owner's call). Clearing a field, pressing Reset, or saving the default
  word for word **deletes the row**, so an instruction nobody changed follows the
  code when the code changes. A hand-edited row that is not a non-blank string
  falls back rather than sending an empty section.
- **What is not rewordable, and why.** `Instructions::TOOLS` is sent verbatim to
  MCP hosts and states facts about the data (kilograms, where the calendars come
  from) that a rewording could only make false. The gate paragraph, the agents
  paragraph and the facts block are derived. The formatting and camera
  paragraphs describe what the chat window and the camera do. Fact extraction's
  prompt is held to a JSON schema its parser depends on. The tab's first card
  says so, so nobody goes looking.
- **The split with MCP holds**: a reworded persona reaches the loop and voice
  and never `initialize` (asserted). Rewording the persona to drop "Sir" and the
  anti-theatre sentence is the owner's call, made on purpose.
- **Defaults are shown unwrapped, and sent as the source has them.** The
  constants are hard-wrapped at ~90 columns, which breaks every line twice in a
  field a card wide; `AssistantInstructions::unwrap()` joins them for the API,
  keeping blank lines and the assessment's indented bullets. `get()` never
  unwraps, so an unreworded machine's prompt does not move by a byte, and saving
  the unwrapped default back is still "the default" (asserted).
- **The list is the server's**, each with a label and a sentence saying where it
  lands (`used_by`), so the screen keeps no copy. `AgentsView`'s rules
  otherwise: read on arrival, never polled; nothing optimistic; one write out at
  a time; drafts committed on blur and resynced from the text *and* a write
  counter; nothing asks first, because anything can be reset. **A paste over
  `MAX_CHARS` (4000) is refused in the browser and kept in the field** rather
  than resynced away; the server's 422 is the backstop.
- **The voice runner reads its addendum when it is built**, which is per request
  (the contextual binding in `AgentServiceProvider`), so a rewording lands on the
  next spoken question too.

### Agents are rows over code-supplied capability groups

An **agent** is a kind of work the assistant does, as a row: a name, a purpose
in the owner's words, the capability groups it owns, and a switch. **Switched
off, its tools are not offered at all** — the mechanism that makes voice
read-only, not a rule the model is asked to obey. Two are built in, **Fitness
coach** and **Secretary**, and further ones are created in Assistant → Agents
(Phase 17). The **News desk** is the first of those: a row a migration writes,
and the owner's to edit or delete like any agent the owner makes (below).

**Rows, not free-form agents.** A created agent cannot invent a capability:
tools are PHP classes that touch the database and the disk, and a typed tool
list would be a second copy of the registry — what `Instructions` stopped being
when it derived the gated list. So an agent picks from a closed set,
`Automation::CONTEXT`'s rule.

**Every tool declares its group** (`Tool::group()`, abstract on `BaseTool`), for
`MutatingTool`'s reason: a new tool cannot be added without saying which group
it joins, and a map kept elsewhere is the copy nothing tests.
`App\Agent\CapabilityGroup` is the closed set, and its values are what rows
store, so **it is append-only** — renaming one strands every row that names it.

| Group | Tools | Ownable |
|---|---|---|
| `fitness` | the nine training tools, reads and writes | Fitness coach |
| `calendar` | `list_events`, and voice's `show_google_calendar` | Secretary |
| `documents` | `search_documents` | Secretary |
| `deadlines` | `list_deadlines` | Secretary |
| `machine` | `open_on_this_machine` | nobody claims it yet |
| `core` | `get_weather`, `save_facts` | **never** |
| `news` | `get_news`, `pin_articles`, `list_pinned_articles` | any agent the owner makes — the News desk today |

(`news` is last only because the values are append-only.)

- **`core` is not ownable**, and it rides along inside
  `ToolRegistry::forGroups()` rather than being passed by each caller, so a
  caller cannot forget it. The weather is what every answer leans on, and
  `save_facts` behind a toggle would silently break the assistant's memory; both
  already have switches of their own. **Re-checked when the news arrived as a
  third domain** (19.1): `get_weather` stays. The training log and every
  greeting lean on it and the news does not, so no one domain has the better
  claim to own it.
- **Documents and deadlines are two groups, not one `records`**: an agent that
  only chases dates is plausible, and a group is cheaper to split before rows
  store it than after.
- **A group is withheld when no enabled agent owns it — unless it has no rule
  and nobody claims it.** Three cases:
  - *Owned, and every owner is off*: that is the agent's switch.
  - *A rule, and no owner at all*: **withheld too** (19.4). A rule reaches the
    prompt only on an enabled owner's line, so offered unowned its tools would
    arrive with no rule, and nothing on Agents could switch them off. That is
    `news` the day the News desk is deleted; making an agent that owns it is how
    it comes back.
  - *No rule, and no owner*: rides along — `machine` today, which has
    `LOCAL_ACTIONS_ENABLED` — because a switch nobody made cannot be off.

  One enabled owner keeps a shared group. `Agent::groups()` drops unknown values
  and `core` rather than throwing, so a hand-edited row costs that one claim,
  never a turn. With no rows at all, the model is offered `machine` and `core`.

**`Services\Agents\AgentScope` is the one place rows become both the registry
and the prompt**, `FactWriter`'s rule: a prompt saying the coach is off beside a
registry still holding `log_workout` is the switch lying one way or the other.
`load()` reads the table once and both halves come off that read; `of()` builds
a state that is not on disk, for tests and the probe. **It only ever removes** —
`registry()` takes the caller's starting point (read-only for voice, no local
tools for an automation's run) and cuts it.

**Applied where the model chooses, and nowhere else.**

- **Scoped**: the typed loop (`RunAgentTurn`, loaded per run, so a toggle lands
  on the next message without restarting a worker), voice (the contextual
  `AgentRunner` binding, applied *after* `show_google_calendar` is appended, so
  the Secretary off takes it with `list_events`) and **MCP** (a contextual
  `ToolRegistry` for `McpServer` — a switched-off agent that Claude Code could
  still drive would make the switch a lie). `listChanged: false` stays honest:
  a host gets a new server per request. A host is sent `TOOLS` alone, so it gets
  no off-sentence, and a withheld tool it calls anyway is "Unknown tool".
- **Never by rebinding the `ToolRegistry` singleton**, because
  `AutomationRunner` calls `list_events`, `get_fitness_stats`, `list_deadlines`
  and `get_news` itself to assemble a greeting. That is the app calling its own
  tools; switching the Secretary off must not turn a morning greeting into
  `Unknown tool: list_events` and a `failed` row. The automation's *conversation*
  that follows is an ordinary run, and is scoped like one.
- **Deciding a parked write stays unscoped** (the container's full-registry
  runner): a write proposed while its agent was on must still be approvable or
  declinable after it goes off — the Anthropic switch's rule that a conversation
  is never stranded on a card. Both exemptions are pinned by tests.

**The prompt says so, rather than going quiet.** `AgentScope::instructions()`
goes into `Instructions::systemPrompt()` **straight after the gate paragraph** —
both are standing rules about what this caller may do, and both are derived.
It lists the agents that are on with their purpose and guardrail, then the ones
that are off **and only the groups that being off actually took away**, and
tells the model to say the agent is switched off and where to switch it on,
never to answer from memory. Without it, "why doesn't it know about my
training?" is indistinguishable from a bug. **A guarded group with no owner gets
a sentence of its own** (`AgentScope::unowned()`): no agent of the user's does
the news, and one that owns it can be *made* in Assistant → Agents — "switched
off" would send the owner looking for a switch that is not there (asserted both
ways: an agent that is off is named as off, never as missing). The same paragraph explains why
`TOOLS`, shared verbatim with MCP hosts and never edited per caller, may name a
tool the model was not given. The gated-tool sentence narrows by itself, since
it was always read off the registry. It is passed into `AgentRunner` (its fourth
argument) from the same load that cut the registry, so the two are never read at
different moments.

**A guardrail defaults from the groups and is the owner's to reword.** Each
group carries a default rule (`CapabilityGroup::guardrail()`), one sentence per
group and never one shared across several, so no group's rule depends on which
others it is owned with; `machine` and `core` have none. An agent — seeded or
created — is held to the rules of the groups it owns (`defaultGuardrail()`, in
the enum's order), composed *with* its `purpose` and never instead of it, and
that default follows its groups when they change. Until this, only the two
seeded agents had one, keyed on `system_key`, and a created agent had none.

- **Every guardrail is editable per agent** (the owner's call, reversing 17.1's "code,
  never a field"). A rewording is stored in `agents.custom_guardrail`, which is
  not fillable: only `Agent::rewordGuardrail()` writes it.
- **Blank is the default, never "no rule"** (the owner's call). Clearing the field, or
  saving the default word for word, stores null, so an agent that was only ever
  shown its default keeps following its groups. **A hat is not expertise**: an
  accountant agent is the same model with different words, and "never an
  advisor" must not vanish with a cleared field. It can still be reworded into
  something weaker — that is the owner's call, made on purpose.
- In a `PATCH`, the groups are applied before the guardrail, because "the
  default" is read off them.
- `system_key` is not fillable and never validated, so no request can make a
  row seeded or unmake one.

**Both seeded agents are ON** (the owner's call, reversing the plan). The Morning
greeting was seeded off because an automation off *adds* nothing; an agent off
*takes tools away*, so seeding these off would have been the migration switching
off the training log on the day it ran. **A created agent defaults on** for the
same reason.

**What the code owns and what the owner owns.** A built-in agent's **groups are
fixed** (a 422) and it **cannot be deleted** (a 409): the two of them keep the
training log and the secretary's three groups owned, so those are only ever
switched off, never lost. Its name, purpose, guardrail and switch are the
owner's. Every agent owns **at least one group**.

**What keeps a rule beside its tools is the scope, not the seeding.** A
guardrail reaches the prompt only on an enabled owner's line, and through 19.3
the answer to "what if nobody owns the group?" was to seed an owner that could
not be deleted. Since 19.4 it is the withholding rule above, and `AgentScopeTest`
pins it for any set of rows: every guarded group the model is offered arrives
with its rule.

**A new agent is the owner's, not built in** (the owner's call, 19.4). The News desk
was seeded with a `system_key` in 19.1, for the reason just given; a day later
the owner wanted it to be an agent like any other they make — groups editable, deletable. A
second migration clears the key and **keeps the row**: its name, purpose, switch
and any rewording were already the owner's. `Agent::NEWS_DESK` is retired, and only
those two migrations name it. So a fresh checkout still gets a News desk,
switched on; it is just not protected. The next domain follows this — add the
group and its rule, and let an agent be made for it — rather than a third
built-in.

**Assistant → Agents** (`components/AgentsView.tsx`) is the Assistant overlay's
third tab, between Activity and Settings — Settings stays last, as on Fitness.
Not a core-menu panel of its own: agents are about what the assistant may do,
which is what that overlay holds.

- **The groups come from the server** with the rows (`GET` answers `groups`
  beside `data`, each labelled by `CapabilityGroup::label()` with the tools it
  holds on this machine), so the screen keeps no second copy of the registry.
  The label is the one the off-sentence uses, so the two cannot disagree.
- **Each card says what its switch takes away now**, from the row's `withholds`
  — read off the same `AgentScope` — never worked out in the browser, because
  who else holds a group is the scope's question. An agent off whose groups
  another enabled agent still holds says so: "changes nothing right now".
- **The last group on a saved card is a disabled switch**, not one that springs
  back from a 422 — a control that always undoes itself lies. The add card may
  start empty.
- **Every card's guardrail is a field**, a draft committed on blur like the
  purpose. Emptied while it is already the default, it is put back unsent; a
  reworded one says so and offers **Reset to default** (`guardrail: null`). The
  add card's placeholder is the default for what is ticked, composed from the
  groups' own rules (`defaultGuardrail()` in `AgentsView`) — worked out in the
  browser, because that agent does not exist yet to be asked.
- **The Delete dialog says what deleting takes away** (`deleteMessage()`), the
  other thing worked out in the browser, because it is about the page *after*
  the delete. A guarded group no other agent owns stops being offered until an
  agent that owns it is made, so the dialog names it rather than promising it
  goes back to being offered. It also says it cannot be undone, and — for an
  agent that owns the news — that the interests and pins are kept on 08 News:
  they are the owner's, not the agent's (see *News*).
- `AutomationsView`'s rules otherwise: read on arrival, never polled; nothing
  optimistic; one write out at a time, and every write re-reads the list (one
  agent's switch can change another's card); drafts committed on blur, resynced
  from the values *and* a write counter; only Delete asks first. The client type
  is `AssistantAgent`, because `useAgentSession` already has an agent — the
  ElevenLabs one.

**`php artisan agents:probe [--off=…] [--on=…]`** prints what each caller would
be offered (typed and MCP, voice), what is withheld, and the prompt's agents
paragraph. Free, no model call: the switch is proven by what the model is
*offered*, not by what it says. `--off` and `--on` take a name or a system key
and try a state in memory, so "what would switching the Secretary off take
away?" is answered before anyone does it.

**Decided against, and why:**

- **Nested sub-agents.** `AgentRunner` exists to park mid-loop in SQLite;
  nesting means parking a *tree*, because a sub-agent's pending write would have
  to suspend its parent. A `delegate(agent, task)` tool is designed in the plan
  and deliberately unbuilt — its first version, if ever, delegates to a
  read-only scope and parks nothing. The fitness coach never needs it.
- **The Claude Agent SDK** (no PHP binding — a second runtime with the gate on
  the wrong side of it) and **the SDK's Tool Runner** (runs to completion in one
  process; cannot wait ten minutes for a card).
- **Managed Agents: deferred, not disqualified.** A spike (2026-09-25) showed a
  CMA session *does* park a custom tool call across a process death and needs no
  public URL, so "it cannot host the gate" is false and must not be repeated. It
  is deferred for: beta in a write path, Anthropic owning the transcript, a
  container per session that nothing uses, and agent definitions living outside
  the repo (the ElevenLabs router's lesson). Revisit when hosting lands or the
  beta goes GA.
- **Tool search** (`defer_loading`) is the cheaper answer if tool *count* ever
  becomes the problem. Agents exist for the switch and the guardrails, not for
  that.

**Two costs, written down rather than solved:**

- **It is the fifth switch** (the Anthropic switch, `LOCAL_ACTIONS_ENABLED`, the
  nudge's triggers, each automation's `enabled`, now each agent's). The derived
  off-sentence is the mitigation; if "why is it quiet?" still has too many
  answers, the fix is one readout naming every switch that is off, not a sixth
  switch.
- **Toggles change the `tools` array per request**, so the day `cache_control`
  is turned on there is a cached prefix **per combination of enabled agents**,
  and a toggle costs one cold prefix. Nothing caches today, so it costs nothing
  yet — the append-only rule on `TOOLS` is the same bet.

### The assistant reaches this machine through a tool, not a desktop shell

A page cannot launch a process, and the near-misses (a protocol handler, a PWA,
the File System Access API) each give the job back. But **the server half of the
app is on the same machine** — Herd serves PHP from this disk — so reaching the
machine is an ordinary tool. A desktop shell would now buy only a global hotkey,
a tray icon and always-on voice, which is why none was built.

**`open_on_this_machine` is a `MutatingTool` for two independent reasons.**
Launching a program is not a read. And an approved call runs inside the
**decision HTTP request**, which Herd serves on the interactive desktop, while
the S4U worker has no desktop — `php-cgi` in session 14, the worker's `php` in
session 0. A window opened from the worker would appear nowhere. The gate is what
makes it safe *and* visible.

- **The model cannot name a path.** It picks a key from
  `config('agent.local.targets')` (`config/agent.php`), the whole of the tool's
  authority. Free-form
  arguments would be remote code execution guarded by someone reading a string.
- **Off by default, and off means unregistered** (`LOCAL_ACTIONS_ENABLED`): not
  in `tools/list`, not in `tools`, not named in the prompt.
- **The target is checked against live config at call time**, not the enum that
  was advertised, since a parked call can outlive a config edit.
- A target takes no arguments yet ("open the editor on this file" wants a second
  key).

The same switch offers the spoken assistant `show_google_calendar` — the mirror
image: ungated, and only acceptable because it is voice-only. See *The spoken
assistant*.

### A camera frame is staged on the composer and kept out of the transcript

The camera is **a monitor with a shutter**, the owner's choice, with the rules in
`camera.ts` and the handles in `useCamera`. It is **Optics**
(`components/OpticsPopout.tsx`): a button under the core, just above its
caption, whose glass card — a round live lens beside the controls — sits above
the sphere, so nothing covers the core. The microphone sits beside the button
(13.0); the core menu's Camera row went with the Assistant panel's other rows.
It was the bottom panel of the left rail, then a popout over the weather's
button, and settled here in Phase 11 after the owner tried it top left, top middle and
inside the sphere. The two pieces are at opposite ends of the sphere, so it is
not a `Popout`: `Hud` places `OpticsButton` and `OpticsCard` separately. The
preview is free — frames painted by the browser and read by nobody — and
`Capture` stages one downscaled frame on the composer, which goes up when the
message does. The card says so under its own buttons.

**The camera is on only while its card is out.** `Hud` passes `useCamera` an
`active` that is false whenever the Optics card is shut, so putting it away —
its button, its ✕, Escape, another corner's button, the core menu or an overlay
opening — releases
the track. A popout makes a live camera easy to hide, and a light on behind a
shut card is one nothing on screen explains. The cost: Capture opens the full
Assistant, which puts the card away, so replacing a frame means reopening Optics
and pressing Start again.

**The bytes are not in the transcript.** Inlining base64 into
`conversation_messages.content` makes every thread re-read download every
picture, and an image is re-sent on **every later turn** at roughly
`width × height / 750` input tokens. So a frame goes to the private disk
(`SnapshotStore`, a `snapshots` table), and the turn holds a reference that
`MessageCodec` resolves to base64 for the model and `TranscriptPresenter` to a
URL for the browser. That is the one exception to "stored verbatim, replayed
verbatim", and it is narrow: the rule protects *assistant* turns' signatures.

- **Only the latest few frames are carried** (`AGENT_SNAPSHOT_REPLAY`, 3, or
  Assistant → Settings → Limits). Older
  ones **become a line of text saying so**, or the model answers a question
  whose picture silently vanished.
- **Downscaled to 1024px JPEG on the client**: Anthropic downsamples past 1568px
  anyway, and PNG is ~10× larger for a photograph.
- **`AGENT_SNAPSHOT_MAX_KB` is a 413, not a resize** — the client already
  downscales, so an oversize frame is a bug to see. **`AGENT_SNAPSHOTS_PER_DAY`**
  is sized for a stuck loop, not a person, on `agent.timezone`'s day.
- **Bytes are checked with `getimagesizefromstring`**, not trusted from the
  header, or arbitrary bytes would be stored and served as an image.
- **Order in `POST /messages` is load-bearing**: switch, busy and parked checks
  run before anything touches the disk, and a `ConversationBusy` after the write
  deletes the frame. Deleting a thread deletes its pictures **through the
  model** (`Snapshot`'s `deleting` hook) — a DB cascade fires no events.
- **A picture is a whole question**: `message` is `required_without:image`.
- **Leaving the tab closes the camera**, as does shutting its card,
  and coming back does not reopen it. **The preview is not mirrored**, because its job is to show what
  would be sent. **Remove is never disabled**, not even with the switch off —
  taking a picture back sends nothing.
- `useCamera` attaches the stream from an effect (the `<video>` may mount after
  `getUserMedia` resolves), and `start()` carries a token so a superseded request
  cannot install its stream over the winner's and leak a live camera.

### The spoken assistant is the same assistant

Voice is a live conversation on **ElevenAgents**, and **the brain stays in
Laravel**. ElevenLabs does speech-to-text, turn-taking and text-to-speech. Its
agent, `Life OS`, is a router configured in their dashboard, whose prompt sends
**every** question to one **client tool**, `ask_life_os(question)`, and
relays the answer. "Every", not "anything about the user", since the weather
work: a router told to forward only the user's own business answered "what's the
weather?" itself, which meant not at all. Anything but small talk goes through. That tool runs in the page and posts to `POST
/api/voice/turn`, which runs the same `AgentRunner`, persona and transcript as
typing, plus `Instructions::SPOKEN` as a per-caller addendum. One loop, one audit log, one place a write could ever be approved. So the
router model should be **cheap and fast** (Haiku 4.5 or Flash Lite): it holds no
knowledge and is billed on top of the minutes.

- **A client tool, not a webhook or Custom LLM**: both need a public URL, which
  means a tunnel through a perimeter that rests on `projectmc.test` being
  Herd-only DNS. The cost: voice works only with the HUD open on this machine.
  Revisit when a VPS exists.
- **The turn is synchronous**, because the caller is a tool call blocked on the
  response. It still takes an `agent_runs` row (`TRIGGER_VOICE`) so a spoken and
  a typed turn cannot interleave in one thread. A typical turn is ~8s, covered by
  the agent's pre-tool speech and a ~3s soft timeout — the pair that decides
  whether the wait feels alive. `ask_life_os` waits up to 120s
  (`response_timeout_secs`, set on the ElevenLabs tool); the request lives 150s
  (see *Platform traps*).
- **It answers into the thread the HUD shows**, read through a ref so a
  mid-session switch answers into the new thread; with no id the endpoint makes
  one lazily. The token route mints no thread, or every press of Talk would leave
  an empty one. `onTurn` re-reads the thread — there is no second store.
- **Every refusal is a sentence, because the agent reads it out**: 503 switched
  off, 409 busy or a write parked, 502 a failed Claude call. The client tool
  returns the sentence rather than throwing; an unhandled call leaves a router
  improvising about someone's training.
- **A call ElevenLabs cuts says why under the core.** A cut arrives as
  `reason: "agent"`, the same as an ordinary hang-up, with the reason in
  `closeReason`. So `disconnectNote` shows it only on an abnormal close (a code
  other than 1000) and stays quiet for goodbyes. **Running out of credits** is
  the case found live: the call stopped halfway through an answer with nothing
  on screen. It now reads as out of credits, with ⌘K to type instead, both at
  start (`[quota_exceeded]`) and mid-call ("exceeds your quota limit").
- **What is left of the plan is a number** (`Services\Voice\VoiceCredits`),
  read from ElevenLabs' `/v1/user/subscription`: characters used, the limit and
  the next reset. Assistant → Settings' Voice card shows it on arrival, never
  polled (`GET /api/voice/credits`, outside the voice limiter so opening the tab
  cannot eat a spoken turn's allowance), and Diagnose warns under 10% left and
  calls zero a problem. **Cached like the weather** (ten minutes after a
  success, one after a failure), so the card and a diagnosis cost one call.
  **It needs `user_read` on the key**, which the token call does not; a key
  without it is a sentence naming the permission. Always 200: `unconfigured`
  and `unavailable` are states of the card, and the key never leaves.
- **The key never reaches the page.** `GET /api/voice/token` mints a short-lived
  WebRTC token for one session and 503s with a sentence when it cannot. **A key
  made for text-to-speech authenticates and is refused** unless it carries
  `convai_write`; `VoiceSessionService` names the permission.

**Voice is read-only.** `AgentServiceProvider` gives `VoiceTurnController` its
own `AgentRunner` on `ToolRegistry::readOnly()` (then cut by the agents' switches
like every model-facing caller), so writing tools are never
offered, and the prompt's gate paragraph inverts to "that has to be typed". It
stayed read-only once reads were proven because a parked write's continuation
runs as a queued run whose answer never reaches the agent (closing that needs a
push into the live session), and an approval must stay a click, never a "yes"
heard across a room. Enabling writes later: give the voice runner the full
registry, add a spoken sentence for `awaiting_confirmation`, and decide how the
continuation's answer reaches the session.

**The one exception opens a page and writes nothing: `show_google_calendar`.**
"Show me what my week looks like" is answered out loud *and* puts Google
Calendar on screen. The owner chose an ungated, voice-only opener over saying "approve
this on screen" to a microphone, and the wiring keeps it narrow:

- **Voice only** — appended last to `readOnly()` by
  `AgentServiceProvider::voiceTools()`, never in `TOOLS`, so typed chat and MCP
  never see it. The voice turn runs in Herd's request on the interactive
  desktop; ungated on the typed loop it would run on the S4U worker and open a
  tab nobody can see.
- **Only where `LOCAL_ACTIONS_ENABLED` is on.**
- **One address**: `config('calendar.open.url')` plus a validated view (day,
  week, month) and date assembled into Google's path (`/r/week/2026/9/14`). The
  model never names a URL.
- **Once**: a second call inside five seconds opens nothing (`Cache::add`), and a
  failed launch clears it.
- It reads nothing back, so its description says to call `list_events` beside it.
- **A tab, not a window**, at the owner's instruction: a window needed the browser's
  executable named (`--new-window` is a program flag) plus a setting for its
  path; a tab is the same `start ""` as `open_on_this_machine`.
- **The tab comes to the front, and the call survives it.** Chrome offers nothing
  outside it a way to open a background tab, and the HUD hangs up when its tab is
  hidden. `useAgentSession` excuses a hide that lands while a spoken question is
  in our loop (`inLoop`) — the only time the tool can run. Switching tabs
  yourself in those seconds is excused too; the agent's silence timeout bounds a
  call left behind the calendar.

**There is no always-on.** An open session bills by the minute whether or not
anyone speaks (a Starter plan is 75 minutes a month). Talk is press-to-start, and a
session ends on Stop, on leaving the tab (bar the case above), and on two agent
settings that are **not in this repository** and are both set on the live agent:
`conversation_config.turn.silence_end_call_timeout` is **15** (its default is
`-1`, off) and `conversation_config.conversation.max_duration_seconds` is
**300**. A client-side timer would be a second copy that fails open in a
throttled tab.

**Typed replies are not read aloud** — the 7.5 text-to-speech proxy and its
`speechSynthesis` floor were deleted in 9.2 at the owner's call, because a
conversation with a robot-voice fallback is a different feature. That is the
accepted cost.

**The one thing this app ever puts into the agent's configuration is a
greeting's first sentence.** A delivered automation (above) offers a card
between the sphere and the buttons; pressing the microphone opens an ordinary
session with `overrides.agent.firstMessage` set to the greeting already on
screen, and the agent opens the call by saying it.

- **An override is silently ignored unless the agent allows that field** in its
  ElevenLabs security settings (`platform_settings.overrides.conversation_
  config_override.agent.first_message`, enabled 2026-09-24 on the owner's instruction;
  `agent.language` and `conversation.text_only` are the other two). No error, no
  warning — the call just opens in silence. **A greeting that arrives on screen
  and is not spoken is that flag, not the code.**
- **The press is the floor.** A browser will not make a sound unprompted and an
  open session bills by the minute, so nothing speaks on its own; the card is
  the invitation and the press is the consent.
- **`spokenText` takes the markdown off and changes nothing else** — never
  shortened, summarised or cut, because the same words are in the thread and a
  spoken version that stopped halfway would disagree with what is on file. A
  greeting too long to hear is an automation asking for too much. It is read out
  of the transcript on screen rather than fetched again.
- **Offered only when it can be spoken**: the greeting is the thread on screen
  (the switch's "nothing would be lost" gate already decided that), the run has
  finished, it said something at all, the browser supports a session, no call is
  open, and the switch is on.
- **Heard is read, cleared on the press rather than the connect.** A failed
  session consumes the greeting — acceptable only because it is the thread
  already on screen and the failure is the caption a moment later; a card
  surviving its own press reads as a button that did nothing.
- **The card names the automation**, not "greeting": *Morning greeting* is a row
  in a table and could as easily be an evening wrap-up.
- An override handed a gesture event would be an object, so `start` guards on
  `typeof === "string"`; a blank string is dropped, since that is the agent's own
  "wait for the user" and sending it looks like a greeting that failed to arrive.

- **`@elevenlabs/client`, not `@elevenlabs/react`**: the React hook needs a
  `ConversationProvider` at the root of `App` for one button. `useAgentSession`
  wraps the class the way `useCamera` wraps `getUserMedia`.
- **`elevenlabsSdk.ts` is a one-function module for Jest**: the SDK is loaded by
  dynamic import, which Jest's CommonJS VM refuses, and the Babel fix cannot
  reach the `native` project. Tests mock that module, never the package, and
  `RTCPeerConnection` is faked in `jest.browser-apis.ts`.
- **`OrbState` has `speaking`, and `asking` outranks it**: while a spoken
  question is in our loop the agent is often saying its filler, and the loop
  running is the fact worth drawing — only the hook knows it.

## The frontend and the HUD

### Theme tokens are CSS variables, not a React context

Every screen builds its styles with `StyleSheet.create` at module scope, so
`colors` is read once at import and can never change. Rather than rewrite ~240
call sites into render-time lookups, `app/src/theme.ts` exports CSS custom
properties (`var(--c-bg)`) — RN-Web passes any string starting with `var(`
straight through to CSS (`isWebColor`). `ThemeProvider` flips `data-accent` on
`<html>` and every mounted screen recolours at once, with no re-render. The hex
palette is only the values the stylesheet is built from.

`var()` also works in an SVG **presentation attribute** (`stroke={colors.accent}`)
— checked in Chromium, against the received wisdom — which is what lets drawings
take the same tokens and re-theme for free.

### There is one palette, and it is the HUD's

Cyan on deep navy, declared on `:root` by `themeStylesheet()`. The app had a
light and a dark palette beside it, with the HUD's scoped to a `[data-hud]`
subtree, until Phase 11.2 made the HUD the only screen: Fitness and Settings
open over it on glass, nothing was left drawn outside its colours but a modal or
two, and the Light/Dark setting went at the owner's call. A `projectmc.appearance` key
left in someone's `localStorage` is read by nothing.

- **`hudPalette` kept its name** and is typed `Palette`, so it owes every token.
- **Neutrals were picked for navy, not inverted from a light theme**: `surface`
  sits above `bg` so panels read as raised, and the semantic accents are the
  bright 400 steps.
- **A filled accent button writes `colors.bg`, not white** — white on cyan fails;
  `theme.test` requires 4.5:1.
- **Tokens only the instrument chrome draws** (graticule, panel brackets, the
  core menu's narrow scrim) are `--h-*`, so `Palette` stays the list of roles
  every surface has. `--h-voice` is the voice ring's level (below).
- **`HUD_SCOPE` (`data-hud`) now carries motion only**: the subtree
  `prefers-reduced-motion` stops, and where `--h-voice` is pinned.
- **The same mechanism carries CSS that React Native cannot express.**
  `backdrop-filter` (`GLASS_SCOPE`, `[data-glass]`), `writing-mode`
  (`VERTICAL_SCOPE`, `[data-vertical]`) and a native picker's `accent-color` and
  calendar indicator (`pickerScope`, `[data-picker]` — a pseudo-element a style
  prop cannot reach at all) are not RN style properties, so they ride a
  data attribute and a rule in `themeStylesheet`. The `web` Jest project asserts
  that join.

### The theme colour is one attribute on `<html>`

Settings → Appearance → **Theme color** picks the accent (`accent.ts`):
**Classic** (the palette's cyan), **Mint**, **Azure** and **Violet**, the
variants of the owner's segment core design. `ThemeProvider` stamps `data-accent` on
`<html>` and keeps the choice in `localStorage` — it is how this browser looks,
not something the worker needs.

- **Only the five accent tokens move**, plus the accent-coloured extras
  (graticule, brackets, heatmap ramp). The override is `:root[data-accent="x"]`,
  one attribute more specific than `:root`, so it needs no ordering trick; the
  test still pins that it follows the palette.
- **Classic publishes no rule**, so the default is the palette byte for byte.
- **Each colour is one hex** (`ACCENT_SPECS`), and `hudAccent()` derives the rest.
  Run over the classic cyan it lands within eight units a channel of every
  hand-tuned value (asserted), which is what licenses deriving the others.
- **No orange or red**, though the design offers orange: amber is the core
  waiting for you or switched off and red is failure, and an orange idle core
  would be indistinguishable from `off`.
- It is stamped in a **layout effect**, so the first paint is already in it.

**`type` in `theme.ts` is the typography scale**: nine steps named for the job
rather than the size, each with its own `lineHeight` (RN derives none). It exists
because the same eyebrow label had drifted to 10, 11 and 12px on three screens,
which a HUD — header, unit suffix and readout within 30px — cannot survive.
`readout` alone names a family: telemetry is digits replaced in place, and a
proportional font makes them jump.

### The HUD is the only screen, and everything else opens over it

`App` mounts the chrome bar and `Hud`, and nothing else. There used to be five
screens switched from a menu row in the bar; Phase 11 (the owner's `Core HUD.html`)
turned the core into the menu and everything it opens into something over the
HUD, so there is nothing left to navigate.

- **The bar (`HudChrome`) is one row**: the orb, LIFE OS, the clock, the `AI OFF`
  chip and the status pill (ONLINE / DEGRADED / OFFLINE). The menu row and the
  subtitle that said where you were went with the other screens. Below 768px it
  drops the clock. It sits above the HUD's layers (`zIndex` 3), so the overlays
  stop at it — the one thing never covered.
- **Nine glass overlays** — the Assistant, Settings, Fitness, Stats, Profile,
  Facts, Automations, Records and News —
  share one frame (`components/GlassOverlay.tsx`: glass, corner brackets, a vertical spine,
  ✕). `overlay` is a single value, because each covers the others' way in.
- **Stats, Profile, Facts and Automations are overlays with no tabs**, each one
  page of `StatParts` cards — see *Stats is the vitals and the diagnosis*,
  *Profile is the account, its sessions, and who tried*, *The assistant knows
  the owner* and *Automations are rows, delivered on the HUD's first load*.
- **The Assistant is an overlay with five tabs** (`AssistantView`: Chat, which is
  `AssistantFull` unchanged, Activity — see *Assistant → Activity is the
  assistant's own record* — Agents — see *Agents are rows over code-supplied
  capability groups* — Instructions — see *The instructions are the owner's to
  reword* — and Settings, last — see *Assistant settings are split by
  who reads them*), on `FitnessView`'s rules: mounted on first visit, then
  hidden. `assistantTab` survives a close, so the menu title reopens where you
  were; **⌘K and a camera capture name Chat**, because both are about typing.
- **Fitness is an overlay with five tabs** (`FitnessView`: Home, Workouts,
  Exercises, Equipment over the old screens, unchanged, and Settings — see
  *Fitness settings are split by who reads them*). It inherited `App`'s
  rules: a tab mounts on first visit and is then hidden rather than unmounted
  (a half-filled workout form survives a tab switch), nothing mounts until the
  overlay first opens, each screen's `active` is "the overlay is open and this is
  its tab" (what `useRefreshOnActivate` keys off — a screen added there must take
  it), and `openAllSignal` is a counter so Home can ask Workouts for its full list
  twice. `fitnessTab` survives a close, so ✕ and reopening land where you were.
  The overlay body has `minHeight: 0`, or the screens do not scroll.
- **Records is an overlay with two tabs** (`RecordsView`: Documents and
  Deadlines), on the same rules — see *Records*.
- **News is an overlay with chips, not tabs** (`NewsView`): one list under a row
  of beats, so nothing is mounted and hidden — see *News*. `newsBeat` survives a
  close the way a tab does.
- **The corners hold what is worth one press**: the agenda top right and the
  weather bottom left. Bottom right is empty since 13.0 — the chat button went,
  and the microphone sits under the core beside the camera's button. Each corner is a `PopoutTrack` a fixed `CORNER_INSET`
  (28px) from its edges, and each card uses one frame (`components/Popout.tsx`).
- **At most one thing floats over the HUD**: an overlay, the core menu, or one
  corner card. Opening any puts the others away. Layers stack popouts and
  launchers (5) over the menu (4), under the overlays (6).
- **The accepted costs**: Settings is reachable only from the core menu, the
  typed conversation only from the menu or ⌘K, and the
  sphere keeps animating under an open overlay (see *The holographic core*).

### The core is the menu

Click the sphere and nine numbered panels slide in, four down the left and five
down the right; click it again and they go (`components/CoreMenu.tsx`). A port of the "system
index" in the owner's `Core HUD.html`. It replaced the two rails, which were always open
and so cost the core its width all day for numbers nobody read most of it.

- **`CoreMenu` draws; `Hud` decides.** A panel is data — a title, rows, a note —
  built by `menuPanels()` in `Hud.tsx` beside the state it reads. A row is an
  `action` (a button, which puts the menu away before acting), a `readout` or a
  `gauge`. The design drew every row as selectable; a row that selects without
  doing anything is a control that lies, so readouts have no button edge.
- **A panel's title can be its action** (`MenuPanel.onPress`): the head becomes a
  button with the action rows' hover, and a panel with no rows draws none.
  Fitness and Assistant use it — a row per tab was a second copy of the tab bar
  the overlay already has (the owner's call) — and each opens on the tab last shown.
  System stats uses it too, opening Stats. The head keeps its `right` slot,
  which is where Assistant says **new reply** and System stats names the host.
- **The owner's order**: 01 Fitness, 02 Assistant, 03 System stats (each title opens
  its overlay; no rows — Talk and Camera are the two buttons under the core, and
  the machine's numbers are in Stats) and 04 Core (its title opens Settings — its
  Calendars and Appearance rows both did, so they went at the owner's call), down the
  left; 05 Facts (opening the Facts overlay, its head saying **N to review**
  when the extractor has proposed something), 06 Automations (opening the
  Automations overlay; no rows — a scheduled conversation is a card's worth of
  settings), 07 Records (opening Records on the tab last shown; no rows), 08
  News (opening News on the chip last picked, its head saying **N unread
  pinned**; no rows) and 09 Profile (its head the owner's photo and name,
  opening Profile; rows: the address and Sign out), down the right. Every head
  on the menu is a button.
- **Four and five, since News** (19.3). Each column spreads its panels over the
  same height, so an even count puts every left panel level with one on the
  right — the owner's call when Records made eight, and why Core moved to the left
  column. News made nine and undid the level rows: the right column is one
  longer over the same height. That follows from the owner choosing a panel and an
  overlay for the news rather than a corner card. A menu with no signed-in
  owner, and so no Profile, is level again.
- **The News panel is always there**, whether or not an agent that owns the news
  exists or is on: agents decide what the *model* is offered, not what the owner
  may read.
- **Profile is always the last panel** (the owner's call): `menuPanels()` pushes it
  after everything else, so whatever is added later goes above it.
- **An odd panel goes right.** `CoreMenu` puts `floor(n/2)` panels on the left
  and the rest on the right — which is where the ninth goes. Profile was once planned top centre, above
  the sphere; the split rule is all that ever changed — there is no per-panel
  placement field. `MenuPanel` gained only `avatar`.
- **System stats' note is an exception report.** With no rows, an age is a
  caption for a reading nobody can see, so it says nothing while the sample is
  fresh and warns once it is stale — a climbing age is the second sign the worker
  is dead, and the menu is where you are before opening anything. It guards on
  `age_seconds !== null`, because `isStale(null)` is true and the age is null
  before the first sample, which would flash "stale — never" on every open.
- **Opening the menu puts every corner card away, which turns the camera off.**
  Escape takes away one layer per press: overlay, then menu, then card.
- **Wide, the panels keep to the window's edges** (`spread`), each column
  spread down its side, each reaching the core with a hairline that runs
  level, turns for the centre and ends on a diamond at 1.5R, clear of the ring (the owner found 1.2R too near) — the owner's reference
  image. They hugged the core until the owner saw them cover it. `spread` computes the
  core from the layer's size (measured by `onLayout`) rather than measuring it;
  the hairlines are one SVG over the layer. The layer is `box-none`
  (in `StyleSheet.create`, where RN-Web polyfills it) so the sphere between them
  still takes the closing click. **Under 1100px** (`MENU_BREAKPOINT`) two columns
  beside a sphere do not fit: the panels become one scrolling column over a scrim
  (`hud.veil`), and tapping the scrim closes it. The in-app browser cannot reach
  the API, so the narrow layout is covered in Jest only.
- **The core says it can be clicked** (`coreRing()`): a faint ring beckons at
  rest, closes in brightly on hover, the sphere lifts, presses to 0.97, pings
  after a click and dims while the menu is out. The ring is `coreTint(state)`, so
  it is the core's colour, keyed per mode so each restarts its animation. While
  open the caption reads "Core menu". **RN-Web's `StyleSheet.create` drops
  `animation`**, so those are set inline.
- **Mounted open and shut**, because the stagger is a CSS transition with a
  per-panel delay: shut, each column is `reachable(false)`. A title's blinking
  square is `hud-blink` in `themeStylesheet`.

### Layers animate from CSS

A layer's open/shut state is already a function of state, so a transition needs
no animated value, driver or per-frame `setState`. RN-Web forwards
`transitionProperty` and friends into the generated CSS; `transition()` in
`theme.ts` is the one cast that hides them from RN's `ViewStyle`.

- **A shut layer stays mounted** (a transition needs both ends), so it is made
  unreachable, not merely invisible — `reachable(open)`, for the disabled-
  `Pressable` reason in *RN-Web traps*. RNTL's queries skip hidden subtrees, so a
  test can just ask whether a panel is findable.
- `prefers-reduced-motion` turns transitions off in the same rule as the
  keyframes.

### The holographic core is a CSS port of the owner's design, not the design file

The owner's "JARVIS Holographic Core" canvas — a wireframe sphere in orbit rings, a
particle swarm, a bloomed nucleus, a scan plane — fills the centre column. The
design is a six-scene demo reel that recomputes every node from a clock each
frame in React; on a screen left open all day that is ~110 SVG nodes at 60Hz
forever. So each part became something CSS holds on its own:

- **Meridians** are `scaleX` on a group: a meridian of a turning sphere is an
  ellipse whose width traces |sin(spin)|, and staggering the delay across eight
  of them *is* the rotation.
- **Rings and swarm** are groups under plain rotation; the 46 dots are bucketed
  into four groups — four animations, not 46.
- **The scan plane** needs the radius, so `HolographicCore` publishes its own
  stylesheet through `injectStylesheet` (a radius copied into the theme goes
  stale). Its stops are **derived from the circle** — nine of them — because CSS
  interpolates linearly and a circle does not (a quarter of the way down the
  true half-width is 0.866R; linear gave 0.52R). It scales **uniformly**, since a
  cross-section in this projection is an ellipse of fixed aspect; scaling X alone
  left it hanging out of the pole. The sweep is `linear`, because easing lingers
  exactly where the plane is smallest.
- **Its tints are `colors.*`**, so the theme colour recolours it with no code of
  its own.

The owner's "HUD Segment Core" (a notched steel housing of conic gradients) replaced
the sphere in PR #72 and was reverted at the owner's call; the theme colour it arrived
with stayed.

**The scenes are a vocabulary, not a sequence**: `idle`, `listening`, `working`,
`responding`, `speaking`, plus the two still states. **Amber (awaiting approval)
and red (failed) hold completely still**, because motion beside an approval card
says the work is still going on. **`off` is amber and turns** (the owner's call): the
Anthropic switch is a decision, not a fault, and there is no card for motion to
contradict. **A switched-on assistant that cannot answer is `failed` at rest** —
`whyUnavailable()` reads the health poll (API unreachable, database down, no key,
worker `down` but not `unknown`) and the caption says which. Both replace `idle`
only; anything actually happening outranks them. Wake and Settle were left out —
transitions between scenes have no frame to hang on. The caption tables use
`satisfies`, not `as`, so a new state is a compile error rather than `undefined`
under the sphere. The design's own frame chrome was left out — the HUD already
draws the real thing. (A preview row that walked every state lived under the
core until Phase 11; every state is now reachable for real.)

SVG geometry (`rx`, `cy`) is CSS-animatable in Chromium, which made this
possible. The radius is 285 of a 1000 box, so the ground shadow at 1.45R fits.

**What bounds its cost is a hidden tab**, which freezes the document timeline.
Other screens used to hide the HUD with `display: none`, which stopped it too;
now the overlays are glass over a live HUD, so the sphere turns under the blur
while Fitness or the Assistant is open. The frame rate while watched has not
been measured; if the HUD ever feels heavy, remove the bloom filter first, and
consider pausing the core while an overlay is up.

### The orb is SVG, animated from CSS, and takes the middle

`AssistantOrb` is the small state chip in the bar — arcs and a tick ring,
because a 110-element sphere at 28px is mush. Two drawings, one `OrbState`. It
turns while working, breathes while idle, goes red on failure, and goes amber
and still while a write awaits a decision.

- The tick ring is one `stroke-dasharray`, and rotation is CSS keyframes in
  `theme.ts` — a compositor transform instead of a `setState` per frame.
- **Dash patterns are derived** (`dashes()`, `arc()`): a hand-tuned pair is right
  at one radius and leaves a half-width gap at twelve o'clock at every other.
- **The centre column is not measured.** `fill` puts the SVG at 100% of a square
  box and the `viewBox` scales it — `aspectRatio: 1` on `flex: 1` turns leftover
  height into a square, `maxWidth: "100%"` stops it on a narrow column. No
  `onLayout` round trip, no frame at the wrong size.
- **The glow is a radial gradient tinted from the state**, and it needs an id.
  **Two orbs share the document**, and `url(#id)` resolves to the first match, so
  a fixed id hands the big orb the small one's colour — visible only when they
  disagree, which is when it matters. `useId()` per instance, with everything but
  letters and digits stripped, because React's punctuation changed between
  versions (colons in 18, guillemets in 19).

### Assistant → Activity is the assistant's own record

The Assistant overlay's middle tab (`components/AssistantActivity.tsx`): what the
assistant keeps (threads, messages, insights, frames, facts on file) and what it
did over the week — runs by status, tool calls and errors, the writes it asked
for, its most-used tools, tokens, and what extraction proposed and the owner
kept. It sat in Stats for a day; the owner moved it here, beside the chat and the
settings it describes.

- **`GET /api/assistant/activity`** (`Services\AssistantActivity`), polled every
  30s only while the tab is showing (`active && tab === "activity"`: the tab is
  mounted on first visit and kept, hidden). **Outside `throttle:agent`**, which
  is for requests that spend money (asserted).
- **Live, never cached** — a cached count is visibly wrong the moment a run
  finishes. Five statements (scalar-subquery records, runs by status, tool calls,
  top tools, one token sum), capped at six by a test. **The week's facts ride
  the records statement** rather than adding one — proposed by `learned_at`,
  kept by `decided_at`, and a kept fact later superseded still counts as kept.
- **Tokens and spend are read off a ledger, not off the turns**
  (`Services\AnthropicUsage`, table `anthropic_usage`). They were summed from
  `conversation_messages.usage` and `insights.usage`, and deleting a thread
  deletes its messages: the tab once showed about a third of the console's
  monthly figure, the difference being deleted threads. Spend
  is a fact about the account, so it has a table with **no foreign key** —
  pointing a row at a thread would be the cascade again.
  - **`ClaudeService` is the one writer**, after `billed()` returns in both
    `complete()` and `turn()` — the place every paid call passes through. So
    fact extraction and `facts:probe` are counted without a line of their own,
    and a test that mocks `ClaudeService` writes nothing.
  - **A row per paid call, and it never fails one**: the write is in a
    try/catch that reports. By then the answer is paid for and in hand, and
    losing it to a ledger row would charge twice for it. A response with no
    text block is recorded before it throws; a refused call and a response
    reporting no usage leave no row.
  - **The `usage` columns on turns and insights stay** — they say what *that*
    call cost — but nothing sums them any more. The migration backfilled the
    ledger from what still stood, so the month did not restart at zero.
  - Nothing prunes it. At one row a call that is a few hundred rows a year.
- **The week is `agent.timezone`'s**, midnight six days back, and the payload
  names it (`window`) so the tab never hardcodes "7 days". Tokens are only ever
  summed behind that ranged predicate, which is the ledger's one index;
  `conversation_messages`, `agent_runs` and `agent_actions` have a `created_at`
  index from when the sums ran over them.
- **Approvals count `requires_confirmation and status = …`**, because every read
  is born `approved` — `status` alone would call each lookup a write waved
  through.
- **Zero is a real answer**; only the two `last_*_at` fields are null. The tab
  draws `0` for zero and `—` for a value it does not have.
- **The week's spend is an estimate at list price** (`spend`): the token sums
  are read **per model** (still one statement — `group by model` adds
  rows, not queries) and priced by `Services\AnthropicPricing`, a table copied by
  hand from Anthropic's pricing page and dated (`AS_OF`). A dated snapshot id
  matches its model; nothing looser does, so `claude-opus-5-5` is never priced
  as `claude-opus-5`. **A model the table does not list is named, not
  guessed** (`unpriced_models`, `unpriced_tokens`), and `AnthropicPricingTest`
  fails when `AssistantSettings::MODELS` offers a model with no price.
  The tab says the console has the real figure.
- **Month to date rides the same statement** (`spend_month`, with its `since`):
  the query reads from whichever window starts first and splits the
  sums with `case when created_at >= ?`, because early in a month the week
  reaches back into the last one. So the endpoint stays at five statements. The
  month is the **user's calendar month** on `agent.timezone` (`since()`'s rule),
  not Anthropic's billing period, which the app cannot read.

### The machine is sampled on a queue worker, never in the request

CPU and memory are the one reading PHP cannot take for itself on Windows: no
`sys_getloadavg`, no `com_dotnet` in Herd, and FFI is CLI-only. A cold
`powershell.exe` costs ~500ms (`wmic` was 1.3s and deprecated), so the probe is
one invocation returning both numbers, and it **never runs in a request**:
`GET /api/system/stats` serves the last sample with `age_seconds` and queues
`SampleMachine` when it is older than `sample_ttl`.

- **Null before the first sample**, not a zeroed bar — a bar at zero is a reading.
- **A dead worker shows as a climbing age** (`Sample stale — 4m ago`), a second,
  independent signal that the queue is not draining.
- **The dispatch is claimed with `Cache::add`**, or a menu polling every 5s
  against a dead worker fills `jobs` with one job per poll.
- **Disk is not in the sample** — `disk_free_space()` is a free `stat()`, always
  current, and fills the panel on first load.
- The probe has a `/proc` branch because CI runs Linux, and parsing is pure
  static functions so it can be tested. It reads `MemAvailable`, not `MemFree`.

### The worker and the scheduler are made to prove they are alive

The failure mode of both is **silence**: a dead worker leaves runs `queued`, a
dead scheduler makes the proactive check never fire. So one `->everyMinute()`
entry stamps `hud.heartbeat.scheduler` inline (it runs inside `schedule:run`)
and queues `RecordQueueHeartbeat`, which only a worker can execute.
`/api/health` reports each stamp's age; older than `heartbeat_grace` is down.

- **Counting `jobs` rows answers a different question** — zero is what a healthy
  and a dead worker both show on an idle machine. The backlog is reported beside
  the heartbeat, because a fresh beat with work piling up is a stuck worker.
- **Never-seen is `unknown`, not `down`** — tasks never registered and tasks that
  stopped need different fixes.
- **The grace is 150s**, generous because the tick is once a minute and the
  worker sleeps between polls.
- **Nothing is behind a `when()`** — a heartbeat that can be switched off reports
  "down" as "off".
- **The assistant is reported configured, not reachable**: checking would be a
  paid call per poll, and a missing key is the failure that happens.

### The weather has three states and no default location

Open-Meteo, because it needs no key — a key would be a second secret to keep
out of the bundle for public information. Routed through Laravel for the cache.
**Unconfigured is not unavailable**: no location is guessed (an IP lookup is a
third-party request nobody asked for), and an unset card says which two `.env`
lines fill it. A failure is cached for a minute, so an outage is not a retry
loop against someone else's API.

- **One request is a forecast, not a reading**: now, every hour of the next
  week, and a row per day (`WeatherService`, cached ten minutes). Both
  questions the assistant failed before `get_weather` were about *tomorrow*.
- **It is asked on the user's clock.** Open-Meteo buckets its daily rows by the
  `timezone` it is sent, and a UTC day is 08:00 to 08:00 in Manila. So the
  request names `agent.timezone`, and the zone-less timestamps that come back
  are read *in* it: hours, sunrises and sunsets go out as wall clock, like the
  calendar's times; only `observed_at` becomes an instant.
- **The HUD and the assistant read the same cache**, so a button press and a
  question in the same ten minutes cannot disagree, and cost one upstream call.
- **`get_weather` can name another place**, through Open-Meteo's keyless
  geocoder. The lookup is made because the user named the place, which is what
  separates it from guessing where they are. It matches names only, so
  "Paris, Texas" sends "Paris" and the qualifier picks among the matches; no
  match is a `ValidationException` the model can correct, and it is not cached.
  A place is read on **its own** zone, under its own cache key — asking about
  Paris never moves the HUD.
- The result carries **`now`** (the time at the place), because the system
  prompt has today's date and nothing finer, and "this evening" depends on it.

**On the HUD it is a button, bottom left**, alone in its corner. The button is
**the weather icon and nothing else**, at the owner's call — the glyph says the
conditions, and the temperature is in its accessibility label and at the top of
the card. Pressing it pops a **glass** card out **to its right**, bottom edges
level (both the owner's calls), with the conditions, every third hour and the week
(`components/WeatherPopout.tsx`, rules in `weather.ts`). Escape, its ✕ and its
button close it, and so does opening anything else over the HUD.

### The HUD polls on a visibility-aware timer

The Fitness tabs fetch on arrival and re-entry (`useRefreshOnActivate`); a HUD's
claim is that its numbers are true *now*. `usePolled` stops when its `active` is
false and when **the tab is hidden** (browsers throttle background timers rather
than stopping them); becoming visible reads immediately. Each poll names its
interval from how fast its source changes: 5s the machine (only while the core
menu is out or Stats is open), 15s health (`App`'s, shared by the pill and the
core's caption), 30s the assistant's activity (only while its tab shows), 60s
the facts list and the pins (only while the core menu is out, and only to count
what waits on their two heads), 2 minutes the calendar, 10 the forecast and the
news (the news only while its overlay is open — an outlet's own cache is twenty
minutes). **A failed refresh keeps the last reading** and
adds a line under it. `latencyMs` is measured client-side, because it means the
round trip this client saw. `useNow` — the clock, in `polling.ts` — uses the
same guard.

### One conversation controller, shared by every surface

`useConversation` is the state — threads, transcript, run watching, the
confirmation gate, the re-read that resolves a failed send, and the voice session
— and `ConversationView` draws it. There is **one instance in a running app**,
owned by the HUD: `AssistantFull` takes `chat: ConversationController` as a
prop, which is what makes the full Assistant continue the thread you were in.
`Hud`'s `active` defaults to true and `App` passes none now; the hooks watch the
tab's visibility themselves. The HUD reports its orb state up to `App` through a
callback, so the bar's orb turns without lifting a run watcher and a voice
session into the shell.

`orbState` derives the state: `awaiting` wins over everything; the last live
item being text is `responding`; `asking` outranks `speaking` in voice.

### The transcript is flattened before it is drawn

**The tool loop writes `user` messages no user typed** — every tool round is
answered by a user message of `tool_result` blocks. `chat.ts` folds each result
into the call it answers (matched on `tool_use_id`, in a first pass because the
result arrives later) so no JSON is drawn on the user's side.

- **Runs are contiguous, not per message**: say, call two tools, say again is
  three items in that order, or the summary lands above the work.
- **A call with no result is *waiting***, not done — a tick beside a parked write
  contradicts the approval card under it.
- `inlineSpans` handles `**bold**` and `` `code` `` only: emphasis leaks from
  every model, and literal asterisks look broken; headers and tables do not leak.

### Optimistic about the message, pessimistic about everything else

The typed turn shows at once with a **negative id**, swapped for the server's
copy (returned on the 202) rather than deduplicated by text.

- **A failed send re-reads the thread** and puts the text back in the composer
  only if the server is not holding it — a dropped connection after the write
  and a 409 before it look the same.
- **The live view is a preview, never the record.** `run.ts` folds events into
  the same prose-tools-prose shape `chatItems` makes, and it is thrown away for
  the stored turns when the run ends; matching the layout is what makes the swap
  invisible.
- **Reasoning is shown only while it is the only thing happening.**
- **The thread `send` just created is not re-read** (`justCreated`): it is empty
  by construction and would land after the run, replacing the answer with nothing.
- **The composer is closed while a write is pending** — anything sent then is a 409.

### The assistant is a microphone under the core, and the menu's Assistant title

The **microphone** (`TalkButton` in `Hud.tsx`) only talks. It sits under the
core beside the camera's button, at that button's 40px, **accent-edged even at
rest** — it is the control on a screen you talk to across the room. The typed
conversation (`components/AssistantFull.tsx`, the Assistant overlay's Chat tab)
is the core menu's **Assistant title** or ⌘K. Speaking and typing land in one
thread. Until 13.0 the mic was 56px bottom right with a chat button over it; the
chat button went at the owner's call, and the mic came to the core whose state it
changes.

- **Absent, not disabled, where no session is supported** — a button that can
  never work is not a control; the caption says why.
- **A camera capture opens Chat**, since the composer is there, and never starts
  a new thread whatever the open-on preference says — the frame is the reason
  for opening.
- **"Opening the Assistant shows a new chat"** starts an empty thread on the way
  in, **unless that would take something away**: a call or a run going (their
  answers land in the thread being left), a write parked on an approval card, or
  a frame or text staged on the composer.
- **The words moved into two places**: the mic's accessibility label (also what
  tests find), and the caption under the core, which explains it and says **where the audio goes** — a button opening a line to a third party
  without saying so assumes consent.
- **The mic becomes a stop square on the press**, not on connect, and is **never
  disabled while the line is open** — the way out of a permission prompt must not
  be to answer it. There is no Mute; ending the call is how the room stops.
- **⌘K / Ctrl+K opens and closes the typed conversation, never the microphone** —
  a shortcut is pressed where nobody can see. It `preventDefault`s (browsers
  spend it on the address bar), and over Settings or Fitness it swaps rather than
  stacking. Over any other Assistant tab it switches to Chat rather than
  closing — the keystroke asked for the conversation. **One listener, in the capture phase** — see *RN-Web traps*. ⌘K is
  written down in one place: the idle caption.
- **Unread is "new reply" on the menu's Assistant title and a line under an idle
  core** (`UNREAD_HINT`); it was a dot on the chat button. It is **the key of the
  last thing the assistant said**, not a count — a count moves on thread switches and swapped
  optimistic turns. What is already in a thread is **adopted, not announced**
  (tricky: `loadingThread` goes false in the same commit as the loaded thread,
  so the previous value is remembered beside the key). A spoken answer is adopted
  too, while a session is open. **Only the Chat tab reads a reply** — the overlay
  open on Settings does not — and *announce new replies* switched off means it is
  never set. **A delivered automation lights the same signal** by its own route,
  because it arrives in a thread nobody is in (see *Automations are rows*).
- **A waiting greeting borrows the microphone**: the button keeps its 40px and
  its position but is labelled *Hear the greeting* and takes a beckoning ring,
  and the card sits **in the stage's flow** between sphere and buttons, so the
  sphere gives up height while one waits — unlike the camera's absolute card,
  because a card over the caption would be words over words.

**Settings' Preview is painted from hex**, `hudPalette` with the theme colour's
family (`accentFamily()`) on top, rather than from `colors.*`, so a test can read
the colours it was given; it previews units on a card of fixed canonical values.
The theme colour's chips follow the same rule.

### The voice ring reads a CSS variable

The 56 bars scale by `--h-voice`, written on `<html>` once per frame by
`useAgentSession`'s `requestAnimationFrame` loop; each bar is
`scaleY(calc(0.06 + var(--h-voice, 0) * <gain>))`. Passing the number through
React would re-render 56 SVG elements inside a bloom filter at 60Hz. **One writer,
one reader**: it reads `getInputVolume()` while the user talks and
`getOutputVolume()` while the agent does, so the ring moves with both voices.

- **The floor is a hard zero, and the bars rest at 6%** (`sessionLevel`,
  `agentSession.ts`): below the floor is 0, not a small number, but the ring does
  not vanish — "listening, hearing nothing" is different from "not listening".
- **Attack faster than release, and a square-root curve** — speech is mostly
  gaps, and loudness is perceived logarithmically.
- **A per-bar hash sets length and gain**, or one audio number moves all 56 in
  lockstep.
- **`SESSION_FLOOR` (0.03) and full scale (0.35) are a first calibration** for the
  SDK's mean 100–8000Hz magnitude — not 7.3's RMS. If the ring pins open or barely
  moves, they are the pair to change.
- **`prefers-reduced-motion` pins `[data-hud]{--h-voice:0}`** — the ring is
  neither animation nor transition, and a declaration on the HUD container is
  nearer the bars than the inline one on `<html>`.
- **`voiceDriven`** is always passed by the HUD. The prop survived the preview
  row because `HolographicCore`'s own tests draw the old CSS clock without it.

Rules about the microphone, which outlived the 7.3 dictation stack:

- **"Listening" waits for `onConnect`**, not the press, or the sphere claims to
  hear you during Chrome's permission prompt.
- **Leaving the tab ends the session, and coming back does not reopen it** — a
  microphone that reopened itself is one nobody pressed anything to start. The
  camera follows the same rule. The one exception is the calendar tab (see *The
  spoken assistant*).

## The calendar

### Calendars are read through their iCal addresses

"What's on my calendar?" is answered out loud from the user's own calendars, and
"show me my week" also puts Google Calendar on screen. The app has no calendar of
its own: the owner looks at Google, and events are made in each calendar's own app.

**Every calendar publishes an iCal address** — Google's "secret address", iCloud's
public link, Outlook's published ICS — a URL that serves the whole calendar to
whoever holds it. No OAuth client, consent callback or refresh-token store, which
would have been the first credential system in the codebase, built for one
panel. The Messages API's MCP connector, pointed at a Google Calendar server, was
rejected too: it still needs a Google OAuth token, and its calls run on
Anthropic's side, outside the confirmation gate, `agent_actions` and the voice
registry's read-only rule.

A calendar is **a row in `calendar_feeds`**, added in Settings → Calendars by
pasting its address. The name is read off the feed (`X-WR-CALNAME`); the colour is
the first of Google's eleven no other feed uses.

**The address is a bearer credential.** It is `encrypted` in the column and
`hidden` on the model; `url_hash` (sha256) carries the unique index, because the
same address encrypts differently every time. No route returns it, and **no
error message quotes it** — Guzzle's connection errors name the URL, so a failed
fetch is a sentence of our own and the exception is not logged. Changing it is
removing the calendar and adding it again.

**Two cache entries per feed.** `attempt` says when the feed was last asked and
how that went — five minutes after a success, one after a failure, so an open HUD
is not a retry loop against a provider. `reading` is the last successful parse
and **never expires**, so an outage shows as a calendar flagged unreachable with
its last events rather than a week that suddenly emptied — the two look identical
on the panel, and only one is true. Due feeds are fetched concurrently
(`Http::pool`) inside the request that asked. A feed's `status` never causes a
fetch on its own.

**The recurrence expansion is written out** (`IcsReader`, over sabre/vobject).
`VCalendar::expand()` counts every instance from `DTSTART`, fast-forwarded ones
included, and throws at 3,500 — so one daily reminder from ten years ago blanks
*every* event in the calendar. Each series is expanded on its own with the cap
raised; one that still overflows is skipped and counted (`skipped`), as is a
malformed one-off event.

**Memory sets the span.** Parsing costs ~40MB per MB of feed, against a 128MB
limit, so a year either side of today is read (`CALENDAR_PAST_DAYS`,
`CALENDAR_FUTURE_DAYS`), and one-off events wholly outside it are cut out of the
text before parsing — conservatively, since a wrong cut loses an event and a
wrong keep only costs memory. A date outside the span is *unknown*, never free.

**`list_events` is read-only**, and says so to the model. Because a feed can be
unreachable, an empty result no longer means an empty day: the result names the
calendars that could not be read, and the description says never to report their
days as free. It is told to re-read for every question, because a calendar can
be connected mid-conversation.

### Any iCal address is accepted, and `FeedAddress` decides where a fetch may go

A calendar subscribed to *inside* Google has no secret address in Google, and
calendars often live in iCloud, so they must be read from iCloud. Google stays the
view — `show_google_calendar`, the agenda's `↗` and the colour names.

The Google-only rule that 10.0 shipped had a second job: **keeping the server off
its own network.** Every stored address is fetched from this machine every few
minutes, so a shape-only check would let anyone who can paste an address make the
server ask `127.0.0.1`, a router or a metadata endpoint. So `FeedAddress` checks
**where an address lands**:

- **Resolved (every A *and* AAAA), and refused if any is not public**
  (`FILTER_FLAG_GLOBAL_RANGE` plus the private and reserved flags) — a host public
  over IPv4 and loopback over IPv6 is the trick a one-family check misses.
- **On the form and again before every fetch**, because a name can be repointed
  after it is saved. A refusal at fetch time is recorded like any failed fetch.
- **The fetch connects to the address that was checked** (`CURLOPT_RESOLVE`), so
  a name that answers differently on the second lookup cannot win.
- **Redirects are followed**, three at most, https only, each hop checked before
  it is requested (`on_redirect` throws `AddressRefused`). The documented gap: a
  hop's connection is not pinned.
- **`http` is refused** (the secret would cross the network in clear), and so is
  a username or password in the address (a login, not a feed). **`webcal://` is
  rewritten to `https://` before hashing**, so one calendar pasted both ways is
  one calendar.

`TestCase::fakeDns()` binds a fake resolver for every test, so no test touches
real DNS.

### Calendar times are wall clock, and the client says what day it is

**`app.timezone` is UTC and always will be**, and the user is eight hours ahead
of the server. A workout's `started_at` is an instant and survives a zone change;
"dentist at 15:00" means fifteen hundred on the wall and must never come back as
23:00. So every calendar time on the wire is **wall clock with no offset and no
`Z`** — `2026-09-10T15:00:00` (`IcsReader::WIRE_FORMAT`) — the one form
`new Date()` parses as local. Laravel's default (`…Z`) is the trap: the browser
reads it as UTC and draws the day eight hours out, silently.

- **`IcsReader` is the only conversion.** Instants, `TZID` times, floating times
  and bare dates are all moved onto `agent.timezone` there, once. A floating time
  and an all-day date are read *in* that zone rather than converted; an all-day
  date compared as an instant leaks into the previous day east of Greenwich.
- **All-day ends are exclusive**, as iCalendar has them, and each reader that
  shows a date to a person turns that back into an inclusive last day (`lastDate`
  in `calendar.ts`, `ListEvents::project()`), or a one-day holiday spans two.
- **`GET /api/calendar` has no default window.** A server-side "today" would roll
  over at 08:00 Manila time. The client passes local dates from the browser's
  clock; `list_events`, with no browser, uses `CalendarService::today()`.
  `calendar.ts` parses by reading the digits, so a stray `Z` cannot move anything.
- **The system prompt's "Today is …"** reads `config('agent.timezone')` (falling
  back to `PROACTIVE_TIMEZONE`), or the model resolves "tomorrow" against UTC for
  the first eight hours of every day.

The cost: the calendar shows this machine's local time, not a traveller's, until
`AGENT_TIMEZONE` changes — the right trade for one user in a zone without DST.

### The agenda is a button top right, and its card is today

It was the top panel of the right rail. Since Phase 11 it is a calendar button
in the HUD's top-right corner (its accessibility label says how many events are
left today), and its glass card opens below it, right edges level
(`components/AgendaPopout.tsx`). The owner asked for **today** in the card: "Thu ·
Flight" three days out is what Google Calendar is for, one `↗` away.

- **The window is still today plus seven days**, because `NEXT` has to see
  tomorrow (below). The server answers every poll from its cache, so the wider
  window costs nothing.
- **One list in time order, not a section per calendar** — a work meeting and a
  dentist are one day. The dot says whose, the legend which colour is which.
- **The legend is also the feeds' health**: an unreachable calendar turns amber
  and gets a line saying how old its events are. An afternoon that looks free
  because a calendar could not be read must never be drawn silently.
- **Today's all-day events are a band above everything, outside the six-row
  cap** (`+N more today` past it), so a busy day cannot push the holiday off. `NEXT · in 40m · Title` counts
  to the next thing that *starts*; late in the evening that is tomorrow's holiday,
  labelled "Tmrw", not a countdown to midnight.
- **Finished events are dropped**, not struck through. `↗` opens Google Calendar
  with `window.open` on a click — a user gesture, so no server tool and no voice
  exemption.
- **Three different empties**: nothing connected, everything switched off, and an
  empty day, each fixed somewhere different (or not at all).
- The countdown reads `useNow` (the minute); the calendar is polled every two
  minutes, which is cheap because the server fetches a feed only once its own
  five minutes are up.

**Google's colours are lifted where they vanish on navy.** Blueberry and Grape
sit near 2.5:1 on the HUD's surface and Graphite at 2.8, under the 3:1 a graphical
object needs. `calendarColors.ts` mixes each **toward white, just far enough**
(keeping the hue, as Google's dark theme does), derived against the HUD's `bg` and
`surface` rather than written out; the other eight are drawn as Google paints
them. The keys are a closed set on both sides, and an unknown one draws Graphite
rather than nothing.

## Records

Phase 15 gave the secretary the half that **knows** (facts, extraction,
automations). Phase 16 is the half that **keeps**: documents, and the dates
somebody must act on. They are the layer the future accountant, insurance and
migration agents all stand on — receipts and filing dates, policies and renewals,
checklists and visa dates — and **none of those needs the inbox**, which is why
mail is a designed seam (below) and not a feature.

**Not a second vault.** Permanent personal prose lives in Obsidian, and the facts
store already honoured that by holding only short claims. `documents` holds
**artifacts with dates somebody must act on** — a policy, a visa, a receipt, a
contract — and a document's notes are a line about the thing, not the thing.

### A document is a filed artifact the assistant can search, never read

The assistant sees a document's **metadata**: title, kind, dates, notes, and
whether a file is on it. Never the bytes. A PDF sent to the model is a paid call
per document and then a replay cost on every later turn — the trap
`AGENT_SNAPSHOT_REPLAY` exists for, and worse, because a policy is many pages.
`search_documents`' description says so in the model's terms: say what the
record says, and if the answer needs the contents, say it has to be opened.
Reading documents is the obvious next epic, and it would take `FactExtractor`'s
shape — propose, never save.

- **`Instructions::TOOLS` was not touched.** What is true of documents is said in
  the tool's own description, so the prefix MCP hosts also receive did not move.
- **Search is a `LIKE` over title, kind and notes** (`FiltersCatalog::searchColumns`,
  generalised from the catalog's `searchName`). Full text, tags and folders are
  out — "filing" is a phrase that grows.

### The file is the equipment photo again, with the bytes deciding the type

Private `local` disk (`storage/app/private/documents`, ULID names), streamed by
`GET /api/documents/{id}/file`, reached through a **signed URL** minted inside a
gated response — neither an `<a>` nor a new tab can send the bearer token.
`SignedUrl::file()` takes `picture()`'s end-of-next-UTC-day expiry for the same
reason (a moving expiry is a new download every read), and `?v={updated_at}` is
what lets the response be `immutable`. It is named for the document's title,
slugged for the `Content-Disposition` header.

- **`DocumentStore` is the one writer** of a document's bytes — upload, clear,
  and the model's `deleting` hook — `FactWriter`'s rule on a disk. The file
  columns are not fillable, so a JSON `PATCH` cannot point a row at a file
  nothing checked.
- **The bytes decide the type.** A PDF by its `%PDF-` magic, a picture by
  `getimagesize`; the browser's declared type is never read, because a file
  stored on its word would later be served under a type it does not have.
  Anything else is a 422.
- **Over `DOCUMENTS_MAX_KB` (20MB) is a 413, not a resize** — the owner chose
  this file. A stock Herd's PHP refuses far smaller files first; see
  *Platform traps*.
- **Fields and file travel separately**, so filing with a file is two requests
  and a failed upload leaves the record saved. The Documents tab says the failure
  on the new document's own card, where Upload is one press away.
- **Deleting a record deletes its file through the model**, since a database
  cascade fires no events (`Snapshot`'s precedent). **Clearing the file keeps the
  record.**

### A deadline is its own row, and completing one keeps it

A calendar event is read-only and lives in iCloud; a deadline is a thing this app
tracks, chases and is told is done. Neither belongs in the other.

- **`expires_on` does not make a deadline.** Deriving one from the column would
  make "file taxes by 15 April", which has no document, inexpressible. A deadline
  *may* point at a document (`document_id`, nullable, `nullOnDelete`), and
  **survives it** — losing the renewal date because the scan went is the worse
  failure, as deleting equipment leaves the label on an exercise.
- **Completion is a timestamp, not a delete**, because "when did I last renew
  this" is the question a tracker exists to answer. **Complete and reopen are
  their own routes**; `completed_at` is not fillable, so a `PATCH` can never tick
  one off, and completing twice keeps the first date.
- **No recurrence.** A yearly renewal is a new row each year; a recurrence
  language is how a small feature stops being small.
- **`inAgendaOrder`** — open by due date (overdue first), then completed most
  recent first — is the order of the list, the tab and `list_deadlines` alike,
  so the screen and the assistant cannot disagree about what comes next.
- **Every row answers with its `document` loaded**, so the tab can name and open
  the policy a renewal is about without a second request.

`list_deadlines` is **read-only**, like `list_events`: adding, completing and
editing are the Records overlay's, and the description says so, so the model does
not offer to set a reminder it cannot keep. It defaults to open, takes
`within_days` (overdue always included), and **does the arithmetic** — each row
carries `days_until` on `agent.timezone`, plus `today` — because a model counting
days will one day call yesterday tomorrow. A linked document is `{id, title,
kind}` only; `search_documents` has the rest.

**A deadline reaches the owner three ways, and none is the fitness nudge**:
`list_deadlines`, the Records overlay, and **`deadlines` in `Automation::CONTEXT`**
(see *Automations are rows*). `ProactiveTriggers` lives in `Services\Fitness`, is
a pure function of one fitness payload, and is configured from Fitness →
Settings; a deadline is none of those. If deadlines should ever speak on their
own, the honest move is an automation the owner switched on.

### `kind` is free text on both tables

`Document::KINDS` (passport, visa, policy, contract, receipt, …) and
`Deadline::KINDS` (renewal, filing, payment, application, submission, other) are
**a vocabulary the form suggests, not a constraint** — `equipment_type`'s rule,
because a closed set is wrong within a week and every addition would be a
migration. The cost is drift ("policy" beside "Insurance policy"), accepted; the
picker is `kindOptions(vocabulary, current)`, which appends the row's own value
so a kind outside the list still shows and can be changed.

### The Records overlay

The core menu's **07 Records** title opens it (`components/RecordsView.tsx`),
the owner's name — not *Secretary*, because the whole assistant is the secretary, and a
panel claiming the name would suggest the rest of it lives elsewhere. Two tabs on
`FitnessView`'s rules: mounted on first visit then hidden, `recordsTab` surviving
a close. A tab bar is drawn only from two tabs up — a bar with one tab selects
nothing.

Both tabs are cards of **drafts committed on blur**, resynced from the row's
values *and* a write counter (`AutomationsView`'s pair), **nothing optimistic**
and one write out at a time. `RecordsParts.tsx` holds what they share —
`DateField`, `SmallButton`, `kindOptions`, `localToday`, `openFile` and the
styles — so a date looks like one kind of date on both.

- **Documents** (`DocumentsView`): a card per document and an add card. A
  picture is drawn on its card; a PDF is named, not embedded — a page of
  `<embed>`s is a page of PDF viewers. The file opens in a tab through its signed
  URL. **Delete and Remove file both ask first**: a removed scan is gone from
  the disk as surely as a deleted record.
- **Deadlines** (`DeadlinesView`): open cards in `inAgendaOrder` with a countdown
  in the head and an amber **Overdue · since …** only once the date has passed;
  completed rows collapsed behind a toggle on one card, each with Reopen. **Overdue
  is the browser's date**, never sent by the API — the calendar's rule. **Done is
  a write like any other**, because a deadline drawn as done that was not is found
  out on the day it mattered. **A completed row is not edited in place** — it is
  history; changing one means reopening it. Only Delete asks first.
- The document picker on a deadline lists every document by title plus the one
  the row points at if the list lacks it, so a linked document is never shown as
  none.

The client type is `FiledDocument`, not `Document`, which would shadow the DOM
global.

### The inbox seam

Designed, not built. When mail comes:

- **An ingest produces candidates, never rows** — a parsed message proposes a
  document and a deadline, kept or rejected with a tombstone, `FactExtractor`
  exactly. That is why neither table has ingest columns; a `source` column is the
  only addition it would need.
- **The real cost is a credential.** `GoogleSignIn` keeps **no** Google token —
  scope `openid email profile`, no `access_type=offline`, the access token
  discarded once its claims are read. Mail on the worker needs `gmail.readonly`,
  offline consent and a stored refresh token: the first long-lived third-party
  credential this app would hold, which is exactly what the calendar epic avoided
  with iCal addresses. Email has no equivalent.
- **Two triage systems would be one too many.** the owner has a Claude-side
  `email-triage` skill with its own knowledge base; decide which owns triage
  before building.

## News

Until Phase 19, `SCOPE` told the assistant the news was out of reach. Now there
is a **news desk**: beats read from outlets' own feeds, the owner's interests, a
reading list, and a News overlay on the HUD. Everything the model can do with it
is three tools in one capability group, `news`, which an agent has to own for
them to be offered at all (see *Agents are rows over code-supplied capability
groups*).

### Every source is keyless, and Google is never a beat on its own

`config/news.php` is the whole list: outlets' RSS and Atom feeds, Google News'
RSS search, and Hacker News' front page. A key would be a second secret kept for
public information — the weather's argument.

- **Nothing in it is an `.env` setting**, the diagnostics rule: the TTLs, caps
  and feeds are judgements about this app, not knobs turned per machine.
- **Nine beats, and the config order is the only order**: `local` (Metro
  Manila), `national` (Philippines), `general` (World), then tech, gaming,
  travel, lifestyle, entertainment and science. `get_news`' enum, the API's
  `beats` and the overlay's chips are all read off it, so nothing keeps a copy.
  `national` was not in the plan: the outlets' Metro sections are Metro Manila
  and nothing else, which left the provinces, the Senate and the courts with
  nowhere to be.
- **Every beat has at least one outlet of its own** (`NewsConfigTest`). The one
  search source is a supplement — `local` alone names a `search` phrase, because
  Metro sections go days between stories — or the whole of a query or an
  interest. Its results drop social domains (a post's whole text arrives as the
  headline), its descriptions are not read as summaries (they are the headline
  again), and each item takes its outlet from `<source>`, with the " - Outlet"
  suffix taken off the title.
- **A feed that does not say what it means is corrected in config**: `zone`
  (Inquirer stamps Manila time `+0000`, which put every story eight hours in the
  future) and `summaries => false` (Hacker News' description is a "Comments"
  link).
- **Hacker News is its RSS, not the Firebase API**: one parser and one request
  instead of 1+N. The cost is no points and no comment counts.

**`php artisan news:probe [beat]`** asks every source now, past the cache, and
prints its status, item count, newest story and failure reason; it exits 1 if
any failed. Free, no model call. Every address in the config was proven there
before it was written down, and it is where a feed that has stopped answering
shows first.

### The service is the weather's cache and the calendar's fetch

`Services\News\NewsService` reads every outlet from one place, and
`FeedParser` — pure, static, tested off strings — turns a body into plain items.

- **The cache is per feed** (`news.feed.{sha1(url)}`, twenty minutes after a
  success, two after a failure), so one dead outlet costs that outlet and an
  open overlay is not a retry loop. A search is cached per normalised question
  for fifteen.
- **Every fetch goes through `FeedAddress`** — `check()` before each one, not
  trusted from config, and `options()` to pin the connection — because a feed is
  fetched from this machine as surely as a calendar is. It stays in
  `Services\Calendar`; the failure sentences are the news service's own, since
  Guzzle's quote the URL and `FeedAddress`'s talk about calendars.
- **Due feeds are fetched together** (`Http::pool`) inside the request that
  asked. A body over 2MB is a failure of that outlet: SimpleXML holds several
  times the body in memory.
- **The parser never throws.** A body that is not a feed is no items and a
  reason. `LIBXML_NONET` keeps it off the network.
- **A beat's answer is five items, at most two per outlet**: outlets first and
  the search last (so a story both carry is kept as the outlet's — its link is
  the article, not a redirect), deduped by headline, newest first with undated
  last. Five is a briefing, not a front page.
- **Age is settled on the way in.** A dated story over seven days old is never
  served, or newest-first would fill a quiet Metro day with last month's. A
  stamp more than an hour *ahead* is a feed lying about its offset, and is read
  as undated rather than pinned to the top of every list.
- **A `query` searches within the beat** (`flood` + the local beat's `Metro
  Manila`) and narrows the beat's own outlets to stories that mention every
  word.
- **Interests are one search each**, for the first five of at most ten, two
  stories apiece — one request per interest stands behind one question. A story
  that answers two interests is told once.
- **An unreachable outlet is named in every answer.** An empty beat beside a
  dead feed is not "no news": the tool's description says so, and the overlay
  says it in amber.
- **The service speaks UTC instants; the tools do the clock work**, as the
  calendar's and the deadlines' do. `get_news` hands the model the owner's wall
  clock (`IcsReader::WIRE_FORMAT`) and an `age_hours`, because a model working
  out a story's age from a `Z` timestamp will one day call yesterday's news
  this morning's. The HUD's route sends the instant and the browser says "2h
  ago".

### Nobody names a URL

Every item handed out gets a short **`id`** — the first twelve hex characters of
`sha1(link)` — and is remembered for seven days (`news.item.{id}`). Pinning, by
the tool or from the HUD, sends that id and nothing else, and
`NewsService::item()` resolves it: `open_on_this_machine`'s rule applied to both
callers. The model can pin only what `get_news` handed it, and the browser
cannot post a link. The cost is that an item first seen more than a week ago
cannot be pinned without reading the news again — a 422 sentence.

### Seen-before is the assistant's, and it flags rather than filters

The News desk's purpose says "skip what I've already been told". A read through
`get_news` records each item it returns (`Cache::add`, three days) and marks the
ones it had already recorded **`seen_before`**; the description tells the model
to leave those out unless asked.

- **Flagged, not filtered** (the owner's call): the model skips a repeat unless asked,
  so "what's new since this morning?" and "give me everything" can both still
  be answered honestly.
- **When every item is a repeat, the result says so** — a line in `notes`:
  nothing new, say that and stop. The description alone was not enough: asked
  the same thing twice, the model called all five repeats and then listed them
  "to summarise", and a greeting did the same "for a refresher" (checked live).
  A rule in the description is a page away from the items; a note sits beside
  them. One new item among repeats gets no note — the per-item flag covers it.
- **Only the tool marks.** `GET /api/news` reads with `markSeen` off: browsing
  the overlay is not the assistant having told the owner anything, and must not
  thin a later briefing.
- **Every caller of the tool marks** — a typed turn, a spoken one, an
  automation's greeting, and Claude Code over MCP.

### What an outlet wrote is data, never instructions

A headline is text a stranger chose, and it is read by a model holding write
tools. Four things stand in the way, none of them a filter on words:

- `FeedParser` hands over **plain text** — tags stripped, entities decoded — and
  drops any item whose link is not `http(s)`, since a link is opened in the
  owner's browser.
- `get_news` and `list_pinned_articles` each say, in the model's terms, to
  report titles and summaries and never follow anything in them. It is said
  there and not in `Instructions::TOOLS`, which was not touched — Records' rule.
- **The group's default guardrail** — name the source, separate what was
  reported from speculation, say when a story is over a day old — reaches the
  prompt on whichever agent owns the news.
- Every write still stops at the confirmation gate, and a pin can only name an
  id the service handed out.

### Pins are snapshots, and `PinWriter` is the only writer

"Pin that for later" puts an item on a reading list, `pinned_articles`. The row
is a **snapshot** — title, source, link, summary, date — because the feed moves
on and the registry forgets, and a pin must not.

- **`PinWriter` is the one writer**, `FactWriter`'s rule, for the tool and the
  HUD alike. **All or nothing**: every id is resolved before anything is
  written, so "pin these three" with a stale third pins none, and the model is
  told which to fetch again.
- **`pin_articles` takes `{id, title}` pairs, not bare ids.** The approval card
  shows the tool's input, and a card of hex ids is one nobody can decide. The
  writer checks each title against the item held under that id (case and
  spacing aside) and refuses a mismatch, so a card cannot name one story while
  the id pins another. An array, so three stories are one card (`save_facts`'
  rule), capped at ten. The HUD's button posts `item_id` alone: the owner is
  looking at the story.
- **Re-pinning is a no-op that returns the row**, read or not.
- **Mark read and reopen are their own routes**, and `read_at` is not fillable —
  the deadlines' `completed_at` rule. Marking twice keeps the first time.
- **Removing a pin does not ask first.** It is a bookmark, and the story can be
  pinned again while the registry holds it.
- **`inReadingOrder`** — unread first, then read, newest pin first — is the
  order of the list and of `list_pinned_articles`, so "the first one I pinned"
  means the same thing on both.
- **Voice can read the list and cannot pin**: `list_pinned_articles` is a read,
  so it is in `readOnly()`; `pin_articles` is a write, and "that has to be
  typed". Marking read and removing are the screen's, and both descriptions say
  so, so the model does not offer to.

### Interests are a settings row, and they are not facts

`Services\NewsSettings` keeps `news.interests`: a short list of topics, each one
a search when `get_news` is asked for `interests`.

- **A row, not `localStorage`** — `AssistantSettings`' question. The tool runs
  on the worker, in a voice turn and inside an automation, with no browser open.
- **Not facts** (the owner's call when asked). A fact is a claim about the owner read
  on every turn; an interest is only ever searched.
- **Stored clean, read defensively**: trimmed, blanks dropped, duplicates
  dropped whatever their case, capped at ten. An entry over sixty characters or
  an eleventh is a **422, never a cut**, so what is saved is what was typed. An
  empty list is a real answer.
- **With none set**, `get_news(interests)` searches nothing and says where they
  are set, and an automation skips the fetch.

### The News overlay

The core menu's **08 News** title opens it (`components/NewsView.tsx`). The
panel's head says **N unread pinned**, read from `/api/news/pins` while the menu
is out, as Facts counts its proposals.

- **One list under a row of chips**, not a tab per beat: eleven tab bodies would
  be eleven mounts and eleven pollers for a screen that shows one list. The
  chips come from the server's `beats`. The list is **keyed on the chip**, so an
  answer for the beat just left can never land over the one just picked.
- **Two chips are not beats.** **Interests** carries its editor above the
  stories it finds (`NewsInterests`, "Topics you follow": one per line, a draft
  committed on blur and resynced from the stored list *and* a write counter; a
  save re-reads the stories). **Pinned**, last, is the reading list
  (`NewsPinned`) and exists only in the browser — `PINNED` is never sent to the
  server.
- **They are here and not on the News desk's agent card**, where 19.4 first put
  them. The owner called them out of place there: topics and stories belong to the
  screen they are read on. It also suits the agent being deletable — they are
  the owner's, not the agent's, and deleting it keeps them.
- **Reading here marks nothing as told** (above).
- **Polled every 10 minutes while it is open**, and read at once on arrival and
  on a chip change. **Pinned is read on arrival and never polled**; each of its
  writes re-reads the list before the buttons come back.
- **Nothing is optimistic**, and one write is out at a time. A pin button is
  drawn from its answer; an item carries `pin_id` beside `pinned` because
  unpinning deletes the pin's row.
- **Open ↗ is `window.open` on a click** — a user gesture, the agenda's rule.
- **Three empties**, each fixed somewhere different: no interests set, nothing
  in the last week, and nothing could be read — which names the outlets.

Not built: **a Diagnostics check for the feeds.** A dead one is already named in
every answer and by `news:probe`; a check would earn its place the first time
one dies quietly for a week.

## Diagnostics

Every failure this machine actually has is **silent**: a dead queue worker
leaves runs `queued`, a stale `bootstrap/cache/config.php` hides `.env`, a reset
calendar address reads as a free afternoon, a voice run stuck `running` locks
its thread. Each had a known cause and a one-line fix that lived in this file
rather than in the app. Phase 18 put them in the app: **Diagnose** runs every
check and writes a report, **Troubleshoot** applies the fixes that need nobody's
judgement. Both are buttons on Stats and commands on the CLI.

### The report is deterministic, and the checks read, never repair

`Services\Diagnostics\Diagnoser` runs eleven check groups
(`Diagnoser::CHECKS`: database, queue, scheduler, machine, assistant, sign-in,
calendars, agent state, config, storage, frontend), **one class per group**,
each reading one thing and yielding a `Finding` per judgement — a calendar
group yields one per feed. Around forty findings on this machine.

- **No check calls a model.** A diagnosis has to work when the key is missing or
  the switch is off, which is exactly when someone is diagnosing —
  `ProactiveTriggers`' argument. Every check is free and read-only.
- **A group that throws becomes `{group}.unavailable`**, a problem of its own,
  and the other groups still run: a broken reading costs its own lines, never the
  report.
- **A `Finding` is `key`, `group`, `title`, `severity` (`ok|warn|problem`),
  `detail`, `evidence[]`, and a `fix` *xor* a `manual` sentence.** The
  constructor enforces the xor and that an `ok` offers neither. **An `ok` carries
  evidence too** (asserted non-empty): Stats' old readout cards are gone, and the
  numbers they held — journal mode, latency, sizes, each heartbeat's age, each
  feed — now live only as evidence.
- **Where a reading already existed it is read, not recomputed**: health's
  readings moved from `HealthController` into `Services\System\Health`, which
  `/api/health` and the checks both call.
- **Thresholds are in `config/diagnostics.php` with their reasons, and none is an
  `.env` setting** — they are judgements about this app, and a knob per line
  would be a dozen `.env.example` entries nobody changes.

### One structure, two renderings

A run produces a `Report`, drawn twice from the same findings: **`MarkdownReport`**
writes the `.md`, and Stats draws the JSON natively. The screen therefore has
**no markdown parser** — parsing back text we generated is work that can never be
removed, and it would let the file and the screen disagree. `MarkdownReportTest`
holds the two to the same keys in the same order.

- **`ReportStore` is the one writer** of a row and its file (`DocumentStore`'s
  rule): the row first, then `storage/app/private/diagnostics/{ulid}.md`. The
  markdown is also on the row, so the page never needs the file; the file is the
  copy handed to someone, written once and never edited.
- **Retention is 20**, pruned through the model's `deleting` hook so each file
  goes with its row (`Snapshot`'s pattern — a cascade fires no events).
- **The `.md` is a fifth signed read** (`GET /api/diagnostics/{report}/file`, on
  `RouteGateTest::PUBLIC`), because an `<a download>` cannot send the token. It is
  `immutable` with no `?v=`, since a report is never edited.
- **`source` is `ui` or `cli`**, so a report on the page can be accounted for.
  There is no `assistant` source — see below.
- **The newest report is the one on screen, whatever its kind.** So a troubleshoot
  report must carry a **full set of findings** — the state after its fixes — or
  pressing Troubleshoot would empty the list the owner was just reading.
- **Never run reads "not yet run"**: `latest` is null, never an empty report,
  which would read as a clean bill of health.

### Troubleshoot is a closed set of soft fixes, run in the request

`SoftFix` names nine fixes and `Troubleshooter::FIXES` lists their classes in run
order (a test holds the two one-for-one). **That list is the whole of the
feature's authority** — `open_on_this_machine`'s rule — and `SoftFix` is
append-only, because its keys are stored inside reports.

| Fix | What it does |
|---|---|
| `clear_config_cache` | `config:clear` + routes + events — the landmine that once pointed a `migrate` at the live database |
| `clear_stale_claims` | deletes **expired** cache rows and locks only; a live claim cannot be told from an abandoned one, and it expires on its own |
| `release_stuck_runs` | fails voice runs past `VOICE_MAX_SECONDS` + 30s and runs `queued` past `stuck_minutes`, through `RunDispatcher::finish()` so a watching page stops |
| `retry_failed_jobs` | `queue:retry all` — named in the dialog because some of it spends money |
| `checkpoint_wal` | `pragma wal_checkpoint(TRUNCATE)`; a reader holding a snapshot makes it stop short, which is reported as failed, not done |
| `prune_orphan_snapshots` | deletes frame **files** with no row, never rows, and none younger than 60s (a file is written a moment before its row) |
| `refresh_calendar_feeds` | forgets the failing feeds' `attempt` **and re-reads them** — forgetting alone made the next report call them fine, unread |
| `start_scheduler_task` | starts the scheduler task once, when it is registered but not ticking |
| `restart_queue_worker` | Stop then Start — the task is `IgnoreNew`, so Start alone does nothing to a stuck worker |

**The order is the point**: caches first, so what follows reads fresh
configuration; stuck runs released before the worker returns, so an hour-old
message is released rather than answered an hour late; the tasks last, so a
restarted worker starts on the jobs just re-queued.

**Never offered, and reported as *Needs you* with the command**: registering or
enabling the Windows tasks (elevation), any `.env` edit, `migrate`, restarting
Herd, starting Expo, re-pasting a calendar address. Nothing edits source or
server configuration.

- **Fixes run synchronously in the Herd request, never on the worker.** A job
  cannot restart the worker it runs on, and the worker is S4U in session 0 with no
  desktop (*The assistant reaches this machine*). So `/run` raises its own limit
  to 60s and `/troubleshoot` to 120s (`diagnostics.time_limit`,
  `troubleshoot_time_limit`) — Herd's 30s is wall clock (*Platform traps*).
- **A task fix waits for proof**: up to `fixes.wait_seconds` (15) for the
  heartbeat to move, since the report written straight after is judged on it. The
  worker restart queues a heartbeat job so the new worker's first job is the proof.
- **What runs is what was confirmed *and* is still needed.** `POST
  /troubleshoot` takes a **report id**, and the fixes are re-derived from that
  stored report — the one the dialog was drawn from — so the page cannot name a
  fix of its own. A fresh pass runs first and a confirmed fix it no longer wants
  is `skipped`. The reverse never happens: nothing runs that the owner was not
  shown. Then a second full pass becomes the report, with `outcomes` beside it.
- **One fix failing never stops the next** (`run()` throws to fail; the
  exception is the outcome's sentence).
- **One claim, `diagnostics.running`, for both buttons and `php artisan
  troubleshoot`**, so a press of either while the other runs is a 409 sentence. `throttle:diagnostics`
  (6/min) is its own limiter, not `throttle:agent`, which is for requests that
  spend money.

### The assistant does not diagnose the system it runs on

18.3 planned `diagnose_system` and `troubleshoot_system` as assistant tools, and
**The owner dropped it before it was built** (2026-09-29): diagnostics exist to fix the
core, so the core cannot be what is asked to fix itself. The failures these
fixes are for mostly take the assistant down with them — a dead worker means the
message asking "why?" is never answered, a missing key or the switch off means no
model call, a broken database means no thread to hold an approval card. What is
left would be the cases where the assistant already works.

So diagnostics are **outside every assistant path** — no tool, no `CapabilityGroup`,
no MCP, no automation context — and reachable only by the owner: the Stats
buttons, and the commands for when the HUD will not load. Re-proposing the tools
means answering that argument first.

### Stats is the vitals and the diagnosis

The core menu's System stats title opens **Stats** (`components/StatsView.tsx`).
It is about the machine; the assistant's records are Assistant → Activity (the owner's
call). Since 18.1 it is draft C of the owner's three: the four readout cards compressed
into a tile strip, and the rest of the page the latest report.

- **Vitals**: eight tiles — cpu, memory, disk, database, worker, scheduler,
  assistant, calendars. **Three are live and five are as of the report**, and the
  footnote says which: cpu, memory and disk read the HUD's `system` poll; the rest
  roll up a report group (worst severity) and take their value from a named
  evidence label (`reportTiles()` in `diagnostics.ts`). **Renaming an evidence
  label breaks a tile**, which `DiagnosticsTileEvidenceTest` pins.
- **Diagnosis**: the verdict ("2 problems, 1 warning · 38 checks"), **Diagnose**,
  and **Troubleshoot** only when `latest.fixes` is non-empty — absent, not
  disabled. One `ConfirmDialog` names every fix by its label before anything runs.
  Then the findings that need attention (`attention()` order), each a green *Soft
  fix* or an amber *Needs you* line, and on a troubleshoot report *What
  Troubleshoot did* above them.
- **All checks and Reports are two tabs of one card** (the owner's call): every check
  with its evidence, and the kept reports with **Open .md**. Only the showing tab
  mounts; the choice is local state.
- **The report is read on open and after a press, never polled** — Facts' and
  Profile's rule; a run starts a PowerShell and resolves every calendar's host.
  **Nothing is optimistic**: both buttons disable while either request is out
  (`useDiagnostics`), and a press's answer always lands while a read's lands only
  if nothing was asked after it.
- **It polls nothing of its own.** `system` is handed down from the HUD, whose
  gate is `menuOpen || overlay === "stats"` — opening Stats from the menu closes
  the menu in the same commit, so a gate on the menu alone froze the tiles
  (asserted). Two polls of one endpoint are two answers that disagree.
- **Buttons on a shut layer**: the overlay is mounted shut, so `reachable(open)`
  is what keeps them unclickable (*RN-Web traps*). `StatPage` keeps the
  `ScrollView` the root's direct child for the overlay's `minHeight: 0` chain;
  `StatParts` (tiles, finding rows, cards) is shared with Assistant → Activity.
- **`/api/system/summary` is gone** (18.1): Stats was its only reader, and every
  number it served is now a check's evidence.

```powershell
php artisan diagnose                  # prints and saves the report (source cli); exits 1 on any problem
php artisan diagnose --json --no-save # findings as JSON, nothing written
php artisan troubleshoot --dry-run    # what Troubleshoot would offer, and nothing run
php artisan troubleshoot              # asks first; --force answers yes (the only way without a terminal)
```

`troubleshoot` takes the page's claim, **unless the cache itself cannot be
reached** — that is the broken machine it exists for; `diagnose` only reads, so
it takes none. A database too broken to save into still gets its report printed.

## RN-Web traps

Found in a browser, not by the suite: `react-test-renderer` computes no
stacking, no CSS and no DOM propagation, so on each of these the tests could only
ever have agreed with the bug. Anything touching layering, keys or raw CSS gets
checked in Chrome.

- **`pointerEvents: "box-none"` in an inline style is invalid CSS.** An inline
  style object is written straight into `style`, the browser drops
  `pointer-events: box-none`, and the property falls back to `auto` — an
  invisible layer that eats every click under it while looking correct. Inside
  `StyleSheet.create` it works, because RN-Web's style compiler polyfills it
  (`none` on the element, `auto` on its children), and the core menu's wide
  layer relies on that. In an inline style use `none` or `auto`.
- **A disabled `Pressable` is `box-none`, so a shut layer's greyed-out buttons
  stay clickable.** The polyfill's rule re-enables `pointer-events` on the
  button's children, beating the `none` a shut overlay sets on its subtree. The
  closed Settings' "Add calendar" label sat invisibly over the Optics ✕ (only
  its rim worked) until Settings was opened once and its calendars moved it. A
  layer mounted shut for its transition therefore sets `reachable(open)`
  (`theme.ts`): `visibility: hidden` as well, which nothing below can undo,
  listed in its `transition()` so the fade still shows.
- **RN-Web stamps `z-index: 0` on every View**, so a positioned element with a
  numeric `zIndex` creates a stacking context and its children compete only
  inside it. A menu with its own `zIndex` rendered behind the next sibling on DOM
  order; the fix is to raise the *parent*.
- **`TextInput` calls `e.stopPropagation()` on every keydown**, so a `window`
  keydown listener is deaf while an input has focus. Bind it in the **capture
  phase** (`addEventListener("keydown", fn, true)`), which runs before the target.
- **Press handling is bound to `mousedown`, not `pointerdown`.** A synthetic
  `pointerdown` on a `Pressable` does nothing; anything that watches for a release
  has to listen to both families.
- **CSS properties React Native has no style for** — `backdrop-filter`,
  `writing-mode` — ride a data attribute and a `themeStylesheet` rule (see *The
  HUD carries its own palette*). `title` is not forwarded either, so there are no
  tooltips.
- **A `TextInput` cannot be told what kind of `input` it is, and saying it once
  is not enough.** RN-Web derives the DOM `type` from `inputMode`,
  `keyboardType` and `secureTextEntry` and then assigns it over whatever was
  passed (`supportedProps.type = multiline ? undefined : type`), so
  `type="date"` handed in as a prop renders a plain text box. Writing it on the
  host node is the answer — and React's own `updateInput` runs on **every**
  commit to an input and calls `removeAttribute("type")` for a null type, so a
  field set once at mount turns back into a text box the first time anything
  above it re-renders. `DateTimeInput` therefore re-asserts it from a layout
  effect with no dependency array. Both halves were found in Chrome: jsdom
  showed a correct mount and said nothing, and the Automations card, which
  re-renders on a timer, lost its picker within seconds. The `web` project now
  carries the re-render case.
- **On glass, the blur radius is the knob, not the fill.** Behind a glass surface
  the HUD is near-black navy, and blurring it gives back near-black navy — fill
  alpha went 82% → 62% → 20% with barely any change. So `glass` is `rgba(…, 0)` in
  every palette and `[data-glass]` is `blur(20px) saturate(140%)`: 40px is
  effectively opaque, 10px lets the HUD's own text compete.
- **`injectStylesheet` replaces what it finds**, comparing first. It used to
  return early if its element existed, which is right in production and wrong
  under Expo's hot reload: every `--c-*` edit appeared to do nothing until a hard
  refresh.
- **CSS animations do not run on a `display: none` subtree**, and a background
  tab freezes its timeline — which is what bounds the core's cost, and why the
  HUD's pollers do not run in a backgrounded verification tab until
  `document.visibilityState` is overridden in-page.

## Tests

### The suite runs the native preset in jsdom, not `jest-expo/web`

Switching to the web preset measured as a rewrite: 180 of 405 tests failed on
the query layer alone, because RNTL matches React Native host components and
under the web preset `react-native` is `react-native-web` rendering DOM
primitives — the fix is migrating ~5,000 lines to `@testing-library/react`. So
the `native` project is `preset: "jest-expo"` with `testEnvironment: "jsdom"`,
which gives DOM code (the CSV import and photo picker's `<input type="file">`,
driven by `src/testing/filePicker.ts`) a `document` to run in, keeps every test,
and runs in ~15s against the web preset's 160s.

Setup files run in order — `jest.polyfills.ts`, `jest.browser-apis.ts`,
`jest.setup.ts`:

- **`setImmediate` must exist before RNTL is imported** — jsdom lacks it, and
  RNTL's cleanup hook otherwise binds a `setTimeout` fallback that fake timers
  never advance, surfacing as 30s hook timeouts blamed on the setup file.
- **`localStorage` is cleared between tests**, or the theme and unit preferences
  leak from one test into the next.
- **`jest.browser-apis.ts` holds the shared browser fakes** — `enumerateDevices`,
  a canvas 2D context (jsdom ships none), `RTCPeerConnection` (or
  `sessionSupported` hides the Talk button everywhere) — so suites do not invent
  their own.
- A `<video>` ref needs RNTL's `createNodeMock`: under `react-test-renderer` a
  host ref is null unless one is supplied.

### A second Jest project, `web`, holds the few tests that need RN-Web itself

The HUD's whole mechanism is RN-Web translating `dataSet` into `data-*`
attributes, which never happens under `react-test-renderer`. So
`app/package.json` runs two projects: `native` (everything but
`src/__tests__/web/`) and `web` (`jest-expo/web`, that folder only).

The web preset needs **`babel.config.js`**: the platform presets rebuild the
`babel-jest` transform and drop the root preset's `configFile`, so without a
project config there is no TypeScript preset and every suite fails to parse. The
`native` project is unaffected because its explicit `configFile` wins.

**It asserts the join, not the cascade.** jsdom rejects `var()` on assignment and
does not inherit custom properties, so no Node test can show `var(--c-bg)`
resolving to the HUD navy. It asserts that the attribute is written and that the
stylesheet carries a rule selecting on it; the cascade itself was checked in
Chrome.

### Both test timeouts are raised

A cold Jest transform cache — which CI always has — makes a screen suite's
*first* test pay for transforming most of React Native (measured 415ms warm,
3.3s cold), and a second suite on the next core pushes it past 5s. So
`testTimeout` is 30s. RNTL's `asyncUtilTimeout` is a separate 1s ceiling that the
catalog search's 250ms debounce overruns under load, so `jest.setup.ts` raises it
to 5s. Neither slows a passing run. Both live in the Jest config, which covers
`npx jest` and CI alike. `npx jest --maxWorkers=2` is worth typing on a busy
machine, but it does not belong in the config: CI failed on two workers anyway,
because the constraint is the cold cache, not contention.

### The PHP suite runs at 512MB

`phpunit.xml` sets `memory_limit=512M`. The suite holds on to a little per test
and crossed 128MB at around 680 of them — bisected, and **no single test is at
fault**; it lands wherever the CSV import happens to run. It is raised for the
run, not the app: Herd keeps its own limit, and a real request that needed 512MB
would be a bug.

`FactsView` and `ProfileView` flake under the full parallel Jest run and pass on
their own (`FitnessSettings` has once, too). Known since 15.2, and not diagnosed.

### CI installs from `composer.lock`; a local `vendor/` can fall behind it

CI runs `composer install`, so it is always on the locked versions. A checkout's
`vendor/` is on whatever was last installed there, and nothing says when the two
part. Through Phase 19 this machine sat at Laravel 13.6 against a lock at 13.32,
and **a suite green here was fatal there**: in 19.1 a test's own static helper
named `query()` collided with a non-static `TestCase::query()` that only the
newer framework has — a fatal before any test ran, in CI only, fixed by renaming
the helper. `composer install` closed the gap (2026-09-30; the suite passes on
13.32). A CI-only fatal in a test that passes locally is this before it is
anything else: compare `php artisan --version` with the lock, and **restart the
queue worker after an install**, which otherwise keeps running the old copy.

## Anthropic / Claude API

- Key in `backend/.env` as `ANTHROPIC_API_KEY`, **never exposed to the frontend** — every Claude call goes through Laravel.
- Two models, because the two workloads price out differently. `.env` holds the defaults; Assistant → Settings overrides them with rows (`AssistantSettings`):
  - `ANTHROPIC_MODEL` = `claude-opus-5` — the weekly insight and the morning nudge. Rare calls; depth matters.
  - `ANTHROPIC_AGENT_MODEL` = `claude-sonnet-5` — the tool loop, where every turn is a round trip.
- `ANTHROPIC_AGENT_MAX_TOKENS` (8192) must never inherit `ANTHROPIC_MAX_TOKENS` (1024). A turn that emits thinking *and* a tool call needs room for both; 1024 truncates it mid-JSON, which looks like random tool-call corruption rather than a limit.
- Adaptive thinking + effort:high (`ANTHROPIC_EFFORT`, or the row). The agent path sets `thinking.display` (`ANTHROPIC_THINKING_DISPLAY`, default `summarized`) because it streams and has somewhere to show reasoning.
- `$response->stopReason` **throws** ("the property is overridden, use array access"), and array access yields a `StopReason` enum, not a string. Use `ClaudeService::stopReason()`.
- Console / billing: https://console.anthropic.com/settings/billing

## API reference

Everything below needs `Authorization: Bearer <token>` except what *Sign-in*
lists as public: the two sign-in routes, `/api/health`, `/api/mcp` (its own
token) and the five signed reads. Without one, a route answers **401** `{
"message": "Sign in first." }`. For scripts, mint a token from `backend/`:

```powershell
$env:PMC_TOKEN = php artisan auth:token "Smoke tests"   # a session like any other — revoke it in Profile
```

### Sign-in and the account — `/api/auth/*`

```
POST   /api/auth/google/start              → { url }                        public, throttle:10,1
POST   /api/auth/google/callback           { code, state } → { token, user } public, throttle:10,1
GET    /api/auth/me                        name, email, avatar_url, linked_at, last_login_at, timezone, mcp_token_configured
GET    /api/auth/sessions                  every token, with current: true on the caller's
DELETE /api/auth/sessions/{id}             revoke one
DELETE /api/auth/sessions?others=1         revoke all but the caller's
POST   /api/auth/logout                    revoke the caller's
GET    /api/auth/sign-ins                  the last 20 attempts, refusals included
```

- A refused callback is a sentence: **403** not the owner, a different Google
  account, or unverified; **400** an expired or reused state, or a code Google
  would not take; **502** Google unreachable; **503** unconfigured. Every one is
  also a `sign_ins` row.

### The agent — `POST /api/mcp`, `/api/agent/*`, `/api/voice/*`

The tools are reachable three ways, over three rate-limited route groups:

- **`POST /api/mcp`** — an external host (Claude Code) with its own prompting and confirmations. **Token-gated.**
- **`/api/agent/*`** — this app's loop, driven by the full Assistant, with our confirmation gate. **The owner's sign-in.**
- **`/api/voice/*`** — the same loop over the read-only registry (plus `show_google_calendar` where local actions are on), called by the ElevenLabs agent's client tool from the page. **The owner's sign-in.**

```
GET    /api/agent/conversations                     list threads, most recent first
POST   /api/agent/conversations                     create one (title optional)
GET    /api/agent/conversations/{id}                transcript + pending actions + live run
DELETE /api/agent/conversations/{id}                delete (leaves what was written)
POST   /api/agent/conversations/{id}/messages       { message, image? } → 202 + a run to watch
POST   /api/agent/actions/{id}                      { decision: approve|reject }
GET    /api/agent/runs/{run}?after=N                the tail of a run's event log
GET    /api/agent/runs/{run}/stream                 the same log, as server-sent events — signed; use the run's stream_url
GET    /api/agent/snapshots/{id}                    a camera frame attached to a turn — signed; use the URL in the transcript
GET    /api/voice/token                             → { token }, or 503 { reason, message }
GET    /api/voice/credits                           → { state, used, limit, remaining, resets_at, tier, message } — always 200
POST   /api/voice/turn                              { message, conversation_id? } → { text, conversation_id }
```

- A message returns **202** with `{ run, conversation, message }`; `run.stream_url` is absolute, signed for 30 minutes, and takes `&after=N`. `run.status` walks `queued` → `running` → `completed`, `awaiting_confirmation` (a write is parked; sending anything else is a 409), `max_iterations` or `failed`; `run.finished` says when to stop watching, and `run.error` is the only place a failed call's reason exists. Deciding the last pending action runs the write inside the decision request and queues the continuation (202 with its run).
- `image: { data, media_type }` is one camera frame, bare base64, JPEG/PNG/WebP: **413** over `AGENT_SNAPSHOT_MAX_KB`, **429** past `AGENT_SNAPSHOTS_PER_DAY`, **422** for bytes that are not the claimed image. All three write nothing.
- The two run routes sit outside `throttle:agent`, so a reconnecting stream does not eat the allowance meant for the endpoint that spends money. `voice` has its own limiter.
- `voice/token` answers 503 for `disabled` (the switch), `unconfigured`, `no_agent` and `upstream`, each with a sentence. `voice/turn` refuses with sentences too: **503** switched off or out of Anthropic credit, **409** busy or a write parked, **502** a failed Claude call.

**A queued run needs the queue worker** — without it the run sits at `queued` forever. `https://projectmc.test` is Herd-only DNS, so the whole surface is reachable from this machine and nowhere else.

Register the MCP server with Claude Code (once, from anywhere):

```bash
claude mcp add --transport http projectmc https://projectmc.test/api/mcp --header "Authorization: Bearer $AGENT_API_TOKEN"
```

Smoke tests. The MCP one is free; the chat and voice ones cost a real model call. `curl.exe -N` is the honest way to watch a stream.

```powershell
$h = @{ Authorization = "Bearer $env:AGENT_API_TOKEN"; 'Content-Type' = 'application/json' }
Invoke-RestMethod https://projectmc.test/api/mcp -Method Post -Headers $h -Body '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

$h = @{ Authorization = "Bearer $env:PMC_TOKEN"; 'Content-Type' = 'application/json' }   # from auth:token, above
$c = Invoke-RestMethod https://projectmc.test/api/agent/conversations -Method Post -Headers $h -Body '{}'
$r = Invoke-RestMethod "https://projectmc.test/api/agent/conversations/$($c.id)/messages" -Method Post -Headers $h `
  -Body '{"message":"How many workouts have I logged in the last 4 weeks? One sentence."}'
$t0 = Get-Date
curl.exe -skN --max-time 90 $r.run.stream_url |
  ForEach-Object { "{0,6:N2}s  {1}" -f ((Get-Date) - $t0).TotalSeconds, $_ }

Invoke-RestMethod https://projectmc.test/api/voice/token -Headers $h   # free; no minutes until a session opens
$v = Invoke-RestMethod https://projectmc.test/api/voice/turn -Method Post -Headers $h `
  -Body '{"message":"How many workouts have I logged in the last 4 weeks?"}'
$v.text; $v.conversation_id
```

### The calendar — `/api/calendar`

```
GET    /api/calendar?from=&to=          events across enabled calendars, and each feed's health
GET    /api/calendar/feeds              the connected calendars — never their addresses
POST   /api/calendar/feeds              { url, color? } → fetched once, then stored
PATCH  /api/calendar/feeds/{id}         { name?, color?, enabled? } — the address cannot change
DELETE /api/calendar/feeds/{id}
```

- Times are wall clock (`2026-09-10T15:00:00`), already on `AGENT_TIMEZONE`. All-day rows carry `all_day: true` and an exclusive end.
- `from` and `to` are required local dates, both inclusive, at most 92 days apart.
- Always 200: `configured: false` and a feed with `status: failed` (plus `message` and the `fetched_at` of what is still shown) are states of the panel.
- `POST /feeds` fetches before saving, so a bad or reset address is a **422 sentence**, and an `http`, userinfo or internal-network address is a 422 without any fetch.

```powershell
$today = Get-Date -Format yyyy-MM-dd
Invoke-RestMethod "https://projectmc.test/api/calendar?from=$today&to=$today" -Headers @{ Authorization = "Bearer $env:PMC_TOKEN" } | ConvertTo-Json -Depth 4
```

### Facts — `/api/facts`

Not polled; the Facts overlay reads it on arrival, and the core menu's panel
head reads the same route every 60s only while the menu is out. Nothing here
calls a model, so none of it is under `throttle:agent`.

```
GET    /api/facts              → { active: [...], proposed: [...] } — no filters, no pagination
POST   /api/facts              { category, key, value } → manual, stated, active at once
PATCH  /api/facts/{id}         { decision: keep|reject } — a proposal only
DELETE /api/facts/{id}         forget an active fact: a hard delete of the key and its history
```

- A proposal carries `replaces`: the active value for its key, or null.
- A `POST` restating what is already on file answers **200** with the existing
  row, not a second one. A new value for a key supersedes the old.
- A decision on a fact already decided — another tab — is a **409 sentence**, and
  so is forgetting one that is no longer active. Neither writes twice.
- Every write goes through `FactWriter`; nothing else may insert a fact.

### Automations — `/api/automations`

Not polled; the Automations overlay reads it on arrival, and `useDueAutomations`
re-reads while a claimed run is out. `run` and `due` can each queue a paid model
call, so those two carry `throttle:agent` and the rest do not.

```
GET    /api/automations                 every row, by time
POST   /api/automations                 { name, time, intent, context, enabled? } → created switched off by default
PATCH  /api/automations/{id}            any writable field
DELETE /api/automations/{id}
POST   /api/automations/{id}/run        202 — now, ignoring the once-a-day guard
POST   /api/automations/due             → { claimed: [id…] } — the HUD's own trigger, on load and on the tab returning
```

- `time` is 24-hour `HH:MM` on `AGENT_TIMEZONE`; `context` is a subset of
  `agenda`, `weather`, `training`, `deadlines`, `facts`, `news` (`deadlines` is
  the next 14 days plus anything overdue; `facts` fetches nothing — they are
  already in the prompt; `news` is the local beat, then the owner's interests
  when any are set). Anything else is a 422.
- Both queueing routes answer when the **job is queued**, not when it ran: what
  happened is on the row (`last_run_at`, `last_outcome` of `ok|failed|skipped`,
  `last_error`, `last_conversation_id`), which is what the overlay watches.
- `due` claims each eligible row with a conditional update before dispatching,
  so two tabs cannot both fire one automation and asking twice a minute is free.

### Agents — `/api/agents`

Not polled; Assistant → Agents reads it on arrival and after every write.
Nothing here calls a model, so none of it is under `throttle:agent`. A write
lands on the next turn: every model-facing caller loads the table afresh.

```
GET    /api/agents               → { data: [...], groups: [{ value, label, guardrail, tools }] } — every row, oldest first
POST   /api/agents               { name, purpose, capabilities, guardrail?, enabled? } → 201, switched ON by default
PATCH  /api/agents/{id}          any of those fields
DELETE /api/agents/{id}          a created agent only
```

- A row carries `capabilities` (group values), `enabled`, `seeded`,
  `guardrail` (what it is held to: the owner's rewording, else the default),
  `default_guardrail` (the rules of its groups, or null) and `withholds` — the
  groups this row being off takes away **right now**, empty when it is on or
  another enabled agent holds them.
- `groups` is every ownable group (never `core`), with its label, its default
  rule (null for `machine`) and the tools it holds on this machine.
- `capabilities` needs at least one group, each ownable, none twice; `core` or
  an unknown value is a 422. `name` is up to 120 characters, `purpose` and
  `guardrail` 2000. A blank or null `guardrail` is the default, never no rule.
- A seeded agent's `capabilities` in a `PATCH` is a **422 sentence** (they are
  fixed); deleting one is a **409 sentence** (switch it off instead). `seeded`
  is true for the Fitness coach and the Secretary only.
- Deleting the only owner of a group that carries a rule is allowed, and
  withholds that group until another agent owns it.
- `php artisan agents:probe --off=Secretary` shows what a state would offer,
  free and without writing it.

### News — `/api/news`, `/api/settings/news`

The News overlay polls `GET /api/news` every 10 minutes while it is open, and
the core menu reads `/pins` every 60s while it is out. Nothing here calls a
model, so none of it is under `throttle:agent`, and an outlet is asked only once
its own cache is due.

```
GET    /api/news?beat=&query=         a beat's latest (the first beat when none is named) or `interests` — marks nothing seen
GET    /api/news/pins                 → { data: [...], unread: N } — unread first, then read, each newest pin first
POST   /api/news/pins                 { item_id } → 201, or 200 with the row already there
DELETE /api/news/pins/{id}            204 — off the list
POST   /api/news/pins/{id}/read       stamps read_at; marking twice keeps the first
DELETE /api/news/pins/{id}/read       reopens it
GET    /api/settings/news             → { interests, max, max_chars }
PATCH  /api/settings/news             { interests: [...] } — the whole list, replaced; answers the state
```

- `GET /api/news` answers `{ beat, label, items, unreachable, beats }`, plus
  `query` on a beat and `searched` on `interests`. An item is `{ id, title,
  link, source, published_at, summary, pinned, pin_id }`, with `interest` on the
  interests beat. `published_at` is a **UTC instant** or null — unlike
  `get_news`, which hands the model wall clock. `beats` is `[{ key, label }]` in
  config order, then `interests`.
- An unknown `beat` is a 422; `query` is at most 100 characters.
  `beat=interests` with none set answers `searched: []` and `items: []`.
- `unreachable` is `[{ source, message }]`. An empty `items` beside it is not
  "no news".
- `item_id` is twelve hex characters the service handed out in the last seven
  days. Anything else — a URL included — is a **422 sentence**.
- A pin row is `{ id, item_id, title, source, link, summary, published_at,
  read_at, created_at, … }`; `read_at` moves only through the two `/read`
  routes.
- `interests` must be present and may be empty. More than ten entries, or one
  over sixty characters, is a 422; blank entries and repeats are dropped.

```powershell
php artisan news:probe local     # every source of one beat, asked now — free
```

### Documents — `/api/documents`

Not polled; the Documents tab reads it on arrival and after every write. Nothing
here calls a model, so none of it is under `throttle:agent`.

```
GET    /api/documents                  every document by kind then title; ?search= ?kind= ?per_page=
POST   /api/documents                  { title, kind, issued_on?, expires_on?, notes? } → 201
PATCH  /api/documents/{id}             any of those fields — never the file
DELETE /api/documents/{id}             the record and its file
POST   /api/documents/{id}/file        multipart `file` — uploads or replaces
DELETE /api/documents/{id}/file        the file goes, the record stays
GET    /api/documents/{id}/file        signed — use the row's file_url
```

- A row carries `file_url` (signed, with `?v=`), `mime` and `size_bytes`, or
  nulls; never the disk path.
- `kind` is free text up to 40 characters; `search` matches title, kind and
  notes; `kind=` matches exactly. Paged only when `per_page` is named.
- An upload is **422** for bytes that are neither a PDF nor a JPEG, PNG or WebP
  picture, and **413** over `DOCUMENTS_MAX_KB` — or over PHP's own limits, which
  on a stock Herd are far lower (see *Platform traps*). Either writes nothing.

### Deadlines — `/api/deadlines`

Not polled, likewise; nothing here calls a model.

```
GET    /api/deadlines                  every row, open by due date then completed; ?status=open|completed ?search= ?kind= ?per_page=
POST   /api/deadlines                  { title, due_on, kind, document_id?, notes? } → 201
PATCH  /api/deadlines/{id}             any of those fields — never completed_at
DELETE /api/deadlines/{id}
POST   /api/deadlines/{id}/complete    stamps completed_at; completing twice keeps the first
DELETE /api/deadlines/{id}/complete    reopens it
```

- Every row carries its `document` (the document's own projection) or null. The
  API sends no `overdue`: the client compares `due_on` with its own date.
- `due_on` is a bare `YYYY-MM-DD`, a wall-calendar date like the calendar's.

### The HUD's reads

All polled while the tab is visible (the machine sample only while the core menu
is out or Stats is open), so all cheap by construction: the sample is taken on a
worker, the forecast and the calendar are cached, and health is a few cache
reads and a `select 1`. `/api/assistant/activity` is polled the same way, only
while Assistant → Activity shows, and `/api/news` only while the News overlay is
open (see *News — `/api/news`*). Stats' diagnosis is not polled — see
*Diagnostics — `/api/diagnostics`*.

```
GET  /api/system/stats                           the last CPU/memory sample, its age, and live disk
GET  /api/assistant/activity                     what the assistant keeps, and its week — runs, tools, writes, tokens, estimated spend this week and month to date (only while its tab shows)
GET  /api/weather                                now, the next 24 hours and 7 days, or why there aren't any
GET  /api/health                                 database, queue worker, scheduler, assistant — public
GET  /api/calendar?from=&to=                     the agenda
GET  /api/facts                                  only to count the proposals on the menu's Facts head (60s, while the menu is out)
GET  /api/news/pins                              only to count the unread pins on the menu's News head (60s, while the menu is out)
POST /api/settings/anthropic   { "enabled": true|false } → the new assistant state
```

`POST /api/automations/due` is the one write on the HUD's own timer, and it is
not a poll: it is asked once on arrival and once each time the tab comes back.

`GET /api/insights?kind=` still filters by kind; nothing on the HUD asks for it
since the nudges panel went, and Fitness → Home lists nudges beside the weekly
assessments.

`health.assistant.state` is `up`, `down` (no key) or `off` (switched off), with
`enabled`, `configured`, `model` and `credit` (`exhausted`, `since`,
`last_refused_at`); neither `off` nor an exhausted credit spoils `ok`. The heartbeats
are only true if the Windows tasks are registered — without them both read
`unknown`, which is not `down`. Nothing here 404s or 503s when it has nothing to
say; an unset latitude is a state of the panel.

### Diagnostics — `/api/diagnostics`

Not polled; Stats reads it on arrival and redraws from every press. Nothing here
calls a model. The two presses are synchronous, share one claim, and carry
`throttle:diagnostics` (6/min).

```
GET    /api/diagnostics                     → { latest: report|null, reports: [summary…], groups: [{ key, title }] }
POST   /api/diagnostics/run                 201 — run every check, store the report, answer as GET does
POST   /api/diagnostics/troubleshoot        { report } → 201 — apply the fixes that report offers, check again, answer as GET does
GET    /api/diagnostics/{report}/file       signed — the `.md`; use the summary's file_url
```

- A summary is `id, kind (diagnose|troubleshoot), source (ui|cli), ran_at,
  verdict, counts { problems, warnings, passed, total }, fix_counts, file_url,
  bytes`; `fix_counts` is null on a diagnosis. `latest` adds `findings`, `fixes`
  (`{ key, label }` — the report's fixes that can run on this machine, what the
  confirm dialog lists) and `outcomes`.
- `latest` null means never run — "not yet run", not a clean report.
- **409** a sentence while either press is running; **422** an unknown report or
  one that offers no fix; **429** past the limiter.

```powershell
Invoke-RestMethod https://projectmc.test/api/diagnostics/run -Method Post -Headers @{ Authorization = "Bearer $env:PMC_TOKEN" } | ConvertTo-Json -Depth 6
```

### Fitness settings — `/api/settings/fitness`

Not polled; Fitness → Settings reads it on arrival.

```
GET    /api/settings/fitness     → { nudges: { enabled, time, triggers, timezone }, calculations: { e1rm_formula, week_start } }
PATCH  /api/settings/fitness     { nudges?: {…}, calculations?: {…} } — only what is sent is written; answers the whole state
```

- `time` is 24-hour `HH:MM` on `AGENT_TIMEZONE` (`timezone` is read-only, so the
  screen names the clock). `triggers` is a subset of `layoff`, `volume_drop`,
  `new_pr`, `muscle_gap`, and `[]` is allowed. `e1rm_formula` is `epley|brzycki`,
  `week_start` `monday|sunday`. Anything else is a 422.

### Assistant settings — `/api/settings/assistant`

Not polled; Assistant → Settings reads it on arrival.

```
GET    /api/settings/assistant   → { models: { chat, insight }, reasoning: { effort, thinking_display }, limits: { max_iterations, snapshot_replay }, voice: { configured, agent_configured, local_actions } }
PATCH  /api/settings/assistant   { models?: {…}, reasoning?: {…}, limits?: {…} } — only what is sent is written; answers the whole state
```

- Models are `claude-sonnet-5|claude-opus-5`, `effort` `low|medium|high`,
  `thinking_display` `summarized|omitted`, `max_iterations` `6|12|20` and
  `snapshot_replay` `1|3|5`, the last two as JSON integers. Anything else is a
  422. `voice` is read-only and ignored in a `PATCH`.

### Instructions — `/api/settings/instructions`

Not polled; Assistant → Instructions reads it on arrival. Nothing here calls a
model.

```
GET    /api/settings/instructions   → { data: [{ key, label, used_by, text, default, reworded }], max_chars }
PATCH  /api/settings/instructions   { persona?, scope?, spoken?, assessment?, nudge? } — each a rewording or null; answers the whole state
```

- `data` is in screen order: `persona`, `scope`, `spoken`, `assessment`,
  `nudge`. `text` is the rewording, or the default when there is none; both are
  the unwrapped display form.
- Null, blank or the default itself goes back to the default (the row is
  deleted). Over `max_chars` (4000), a non-string, an unknown key or an empty
  body is a 422, and nothing is written.

## Settings — `backend/.env`

Everything but the Anthropic key and the four sign-in settings is optional, and
`.env.example` carries each with its reason.

```
GOOGLE_CLIENT_ID=        # a Google Cloud OAuth client of type Web; consent screen in Testing, owner as the only test user
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:8082/auth/callback   # must match the client exactly; localhost because Google refuses .test
AUTH_OWNER_EMAIL=        # the one Google account allowed in — blank means nobody, not everybody
AUTH_TOKEN_DAYS=30       # how long a sign-in lasts, from when it was made

ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-opus-5           # the insight and the nudge — default only, as are the model, effort and display below
ANTHROPIC_AGENT_MODEL=claude-sonnet-5   # the tool loop
ANTHROPIC_EFFORT=high
ANTHROPIC_AGENT_MAX_TOKENS=8192
ANTHROPIC_THINKING_DISPLAY=summarized   # or `omitted` — cheaper, shows nothing

AGENT_API_TOKEN=<64 hex chars>   # /api/mcp only — it 503s without one; php -r "echo bin2hex(random_bytes(32));"
AGENT_RATE_LIMIT=30              # requests/min, on the mcp and agent groups
AGENT_MAX_ITERATIONS=12          # model calls per message — default only
AGENT_STREAM_POLL_MS=250         # how often the SSE route looks for new events
AGENT_STREAM_MAX_SECONDS=110     # a stream is capped and the browser reconnects
AGENT_STREAM_RETRY_MS=1500       # how long EventSource waits before it does
AGENT_TIMEZONE=Asia/Manila       # what "today" means; falls back to PROACTIVE_TIMEZONE

PROACTIVE_INSIGHTS_ENABLED=true  # default only — Fitness → Settings overrides once saved
PROACTIVE_TIME=07:00             # default only, likewise

AGENT_SNAPSHOTS_PER_DAY=25       # sized for a stuck loop, not a person
AGENT_SNAPSHOT_MAX_KB=1500       # a 413, not a resize
AGENT_SNAPSHOT_REPLAY=3          # frames still re-sent, the one that costs money — default only

LOCAL_ACTIONS_ENABLED=false                 # off = the openers are not registered at all
LOCAL_ACTIONS_EDITOR='C:\path\to\Code.exe'  # SINGLE quotes — see Platform traps
APP_WEB_URL=https://projectmc-app.test      # what `life_os` opens

ELEVENLABS_API_KEY=      # needs convai_write; blank is supported — Talk says what to set
ELEVENLABS_AGENT_ID=     # the Life OS agent, made in the ElevenLabs dashboard
VOICE_RATE_LIMIT=20      # requests/min on /api/voice/*

WEATHER_LATITUDE=        # unset ⇒ the panel says so; no location is guessed
WEATHER_LONGITUDE=
WEATHER_LABEL=           # what to call the place; nothing is geocoded
HUD_SAMPLE_TTL=10        # how long a machine sample counts as current
HUD_HEARTBEAT_GRACE=150  # how stale a heartbeat may be before "down"

CALENDAR_TTL=300         # seconds a successful fetch counts as current
CALENDAR_FAILURE_TTL=60  # seconds a failure is remembered before a retry
CALENDAR_TIMEOUT=8       # seconds one fetch may take
CALENDAR_PAST_DAYS=365   # the span read and cached — outside it is unknown, never free
CALENDAR_FUTURE_DAYS=365

DOCUMENTS_MAX_KB=20480   # a filed document's cap; over it is a 413 — and keep PHP's own upload limits above it
```

What `open_on_this_machine` may open is `config('agent.local.targets')` — add a
target there, not in `.env`. Everything about the ElevenLabs agent that is not a
secret (model, prompt, voice, the `ask_life_os` tool, the two hang-up settings)
lives in their dashboard.

## Status

On `main`: the Fitness slice (workouts with CSV import, exercises and equipment
catalogs, the weekly AI assessment), the agent (tools, MCP, the chat loop on a
queue, the proactive nudge, the local-machine tool), the HUD (Phase 7), the
summoned assistant (Phase 8), the spoken assistant (Phase 9), and the owner row.

**Phase 10, on `epic/google-calendar` (PR #67 to `main`)**: the user's calendars
through iCal on the HUD, `show_google_calendar` for voice, and the app's own
`events` table and calendar drawer deleted. 10.5 is this file's consolidation.
"Show me my week" was verified in a live Talk session.

**The weather, on `feat/weather-everywhere`**: the rail panel became a button
bottom left with a pop-out forecast card, `get_weather` joined the tools (voice
included), and `Instructions::SCOPE` stopped the assistant treating its tools as
its only subjects. "What's the weather looking like tomorrow?" was answered live
over `/api/voice/turn`. The ElevenLabs router's prompt and `ask_life_os`'s
description were changed through the API, and read back, to forward every
question rather than only the user's own business.

**The theme colour, on `feat/segment-core`**: Settings gained a theme colour
that recolours the HUD and the rest of the app. The segment core that shipped
beside it was reverted to the holographic sphere.

**Phase 11, merged to `main` from `epic/core-menu` (PR #78)**: the owner's `Core HUD.html`. The core became the
menu and the rails went (11.1, PR #75); Optics moved under the core, the agenda
became a button top right, and the preview row went (11.0, PR #74); Fitness
became an overlay, the menu bar went, and so did Light/Dark (11.2, PR #76);
11.3 is this file's consolidation. Facts and Automations were placeholders then,
each its own epic later — both are Phase 15. Nudges, training this week and
recent sessions were dropped from the HUD (nudges are still on Fitness → Home).

**Phase 12, on `epic/fitness-settings`**: Fitness owns its settings. The core
menu's Fitness title opens the overlay and its rows went, as did Core's Units
row; Fitness → Settings gained units and the default stats range (12.0, PR #79),
the morning nudge's switch, time and triggers as server rows (12.1, PR #80), and
the e1RM formula and week start, read by the stats service (12.2, PR #81). 12.3
is this file's consolidation.

**Phase 13, on `epic/assistant-settings`**: the Assistant works the way Fitness
does. The menu's Assistant title opens an overlay with Chat and Settings tabs,
the chat button went and the mic moved under the core beside the camera, and the
Anthropic switch moved to Assistant → Settings beside two browser chat
preferences (13.0, PR #84); models, effort, thinking display and the two limits
became server rows, with a read-only Voice card (13.1, PR #85). 13.2 is this
file's consolidation.

**Stats, on `feat/stats-overlay` (PR #88)**: the core menu's System stats title
opens a Stats overlay — the machine, the services, storage and every calendar —
and the Assistant overlay gained an Activity tab for the assistant's records and
its week (`/api/system/summary`, `/api/assistant/activity`). Stats became the
diagnosis page in Phase 18, and the summary route went with it.

**Phase 14, on `epic/google-login`**: the app has a login. Google sign-in for the
owner alone, the gate on every route but an enforced public list, signed URLs
for the photos, frames and stream, and throttled `last_used_at` (14.0, PR #90);
the login screen, the localhost bounce and `apiFetch` everywhere (14.1, PR #91);
the 07 Profile panel and overlay — account, sessions, sign-in history (14.2,
PR #92). 14.3 is this file's consolidation. A real sign-in, a forged state and a
signed stream were checked live; a second Google account being refused, the
Google avatar on the menu and revoking another browser have not been.

**Phase 15, on `epic/secretary`**: the assistant knows the owner, and opens
conversations on its own. The `facts` table, `FactWriter` and the prompt block,
with `facts:add` / `facts:probe` and the premise test that could have stopped
the epic (15.0, PR #96); the Facts overlay and `save_facts` (15.1, PR #97); the
extractor that reads a thread twenty minutes after it goes quiet and proposes
what it says about the owner (15.2, PR #98); the `automations` table, the
assembled first turn and the claim (15.3, PR #99); the Automations overlay and
delivery on the HUD's first load (15.4, PR #100); the delivered greeting spoken
through the agent's `firstMessage` override (15.5, PR #101). 15.6 is this file's
consolidation. The hosting checkpoint before 15.3 was resolved **desk-only** —
no budget, so delivery is the first HUD load rather than a push. A first-load
delivery, the "new reply" chip and a spoken greeting matching the thread word
for word were all checked live in Chrome.

**Phase 16, on `epic/secretary-records`**: the secretary's missing half — what
it keeps. Documents on the private disk behind signed URLs, with
`search_documents` (16.0, PR #106); the Records overlay and its Documents tab,
with the menu made even at four a side and Profile always last (16.1, PR #107);
deadlines, complete/reopen, `list_deadlines` and `deadlines` in an automation's
context (16.2, PR #108); the Deadlines tab and `RecordsParts` (16.3, PR #109).
16.4 is this file's consolidation, with documents joining Stats' storage card and
the Herd upload limits made to say what they are. The Deadlines tab was checked
live in Chrome (overdue, countdown, Done, Reopen) on throwaway rows. The inbox is
a designed seam, not built.

**Phase 17, on `epic/agents-module`**: agents — rows that each own some of the
tools, and a switch that takes them away. Every tool declares a
`CapabilityGroup` and `ToolRegistry::forGroups()` filters by them (17.0,
PR #113); the `agents` table with Fitness coach and Secretary seeded on,
`AgentScope`, the off-sentence in the prompt, scoping at the typed loop, voice
and MCP, and `agents:probe` (17.1, PR #114); `/api/agents` and Assistant →
Agents (17.2, PR #115). 17.3 is this file's consolidation. Switching the
Secretary off and on was checked live in Chrome, the card and `withheld()`
agreeing. `delegate()` is designed, not built.

**Phase 18, on `epic/diagnostics`**: the app diagnoses itself. The checks, the
report and its `.md`, `/api/diagnostics` and `php artisan diagnose` (18.0,
PR #118); Stats reworked as vitals plus the diagnosis, and `/api/system/summary`
deleted (18.1, PR #119); the nine soft fixes, Troubleshoot and `php artisan
troubleshoot`, and All checks / Reports as two tabs of one card (18.2, PR #120).
**18.3, the assistant's `diagnose_system` / `troubleshoot_system`, was dropped
at the owner's call** before it was built — see *The assistant does not diagnose the
system it runs on*. 18.4 is this file's consolidation, with the unused
`assistant` report source removed. Diagnose, a retry of failed jobs through
Troubleshoot, and the `.md` download were checked live in Chrome; the worker
restart was checked against real Task Scheduler from a shell.

**Phase 19, on `epic/news-desk`**: the news desk. The sources, `FeedParser`,
`NewsService` and `news:probe` (19.0, PR #124); the `news` group, `get_news`,
the News desk agent, news off `SCOPE`'s out-of-reach list and the interests row
(19.1, PR #125); `pinned_articles`, `PinWriter`, `pin_articles`,
`list_pinned_articles` and the `/api/news` routes (19.2, PR #126); the 08 News
panel and overlay, and the menu at nine panels (19.3, PR #127); interests and
pins on 08 News, **the News desk made the owner's own agent** with a guarded
group nobody owns withheld, and `news` in an automation's context (19.4,
PR #128). 19.5 is this file's consolidation, with two fixes its live checks
turned up: `get_news` says in its result when nothing is new, and an
automation's card reports a Run now on a row that is switched off (both
re-checked live after the fix). Checked live: `news:probe` with all
26 sources answering, `get_news` over MCP, and the pin round trip over the
routes; a typed "What's the local news?" (five items, each with its outlet and
age) and "pin the first one" through its approval card; the same question asked
twice, the second read carrying `seen_before` on all five; an automation's Run
now with `news` toggled on its card in Chrome, its assembled turn holding the
local beat and no interests section; and **the News desk deleted for real**
through its dialog — the three news tools withheld, a typed news question
answered with "no agent of yours covers news… Assistant → Agents" and no tool
call, 08 News still reading — then made again as it was. In Chrome, the 4/5 menu and its unread head, the beats, a pin and an
unpin, the Interests editor, Mark read and Reopen, and the agent Delete dialog
(cancelled).

**Configurable instructions, on `feat/configurable-instructions`**: Assistant →
Instructions rewords the persona, the scope, the spoken addendum and the two
unprompted writers' briefs, each a `settings` row whose blank is the default.
Checked live in Chrome: a reworded persona leading the real system prompt (read
back through tinker, no model call), Reset deleting the row and the default
going back byte for byte, and the five instructions as full-width rows (the owner's
call, over five columns).

Open, and each written down above:

- **`POST /api/insights/fitness` has no raised time limit.**
- **Reads are not scoped by owner.** With one owner and `EnsureOwner` on the
  gate it is invisible; a second user would need both — and `documents` is the
  first table where it would matter.
- **Not yet checked live for Records**: an automation run with `deadlines` in
  its context (a paid call — restart the queue worker first), a deadline's
  linked document opening, the Delete dialogs, and a signed document URL
  expiring.
- **Not yet checked live for Agents**: a real typed training question with the
  Fitness coach switched off — the model saying the coach is off rather than
  answering from nothing (a paid call; restart the queue worker first) — and an
  automation with `training` in its context still delivering while it is off.
- **Asked the same news question twice within seconds, the model may answer the
  second from the first result** rather than calling `get_news` again, though
  the description says to. Seen once, after the repeats fix; harmless there.
- **Not yet checked live for News**: an automation's greeting with interests
  set (the second section), and `news` still assembling while no agent owns it.
- **No Diagnostics check reads the news feeds.** A dead one is named in every
  answer and by `news:probe`, and nowhere on Stats.
- **A press straight after typing in a draft field is lost** where drafts commit
  on blur under one page lock — seen on Assistant → Agents: the blur's write
  takes the lock before the press lands. Not new, and only noticed in 19.4.
- **Not yet checked live**: a refused second Google account, the avatar on the
  core menu, and a revoke from another browser dropping this one to Login.
- **Not yet checked live for Diagnostics**: Stop/Start of the worker's task from
  inside a Herd request (php-cgi) rather than a shell, a worker deliberately
  stopped and brought back by the Troubleshoot button, and Stats at phone width.
- **Not yet checked live for credits**: a real Anthropic billing refusal (the
  402 `billing_error` shape comes from the API's error reference and is
  scripted in tests). `/v1/user/subscription` was checked against the real
  ElevenLabs key on 2026-09-30: the refusal named `user_read`, which the
  dashboard calls **User → Access** on the key, and with it the card read the
  credits and the reset date.
- **Voice writes** — the change is known and small; it was declined, not blocked.
- **Contact birthdays are parked** (no iCal address exists for them), and an
  iCloud feed's own colour is not mapped onto a Google one.
- **The tools have never been driven from Claude Code for a week**, which was the
  reason MCP came second.
- **Escape closes the Fitness overlay even while a Workouts modal is open** (the
  HUD's capture-phase listener hears it first), taking the modal with it.
- **The sphere keeps animating under an open overlay**; nothing pauses it.
- **The usage ledger does not say who spent what**: extraction, a greeting and
  a typed turn are all rows with a model and four counts. A `source` column, if
  the split ever matters.
- **Not yet checked live for the usage ledger**: a real paid call leaving its
  row, and a real thread deleted with the month's figure unmoved — both are
  tests over a scripted transport. Spend from before 2026-09-08 was already
  deleted and is only in the console.
- **Extraction has not been watched end to end on a real thread** left idle
  twenty minutes, nor `save_facts` driven from a typed chat through its approval
  card. Both were exercised by `facts:extract` and by tests instead.
- **The first week of proposals is the evidence** for whether extraction is
  noisy enough to make the review queue a chore. Nothing has been kept or
  rejected in anger yet.
- **The spoken greeting depends on a flag outside this repository** — the
  agent's `first_message` override permission. If 15.5 is ever reverted, set it
  back to `false` in the ElevenLabs dashboard.
