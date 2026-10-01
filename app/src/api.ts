import { AuthUser, getToken, notifyUnauthorized } from "./auth";

export const API_BASE =
  process.env.EXPO_PUBLIC_API_BASE ?? "http://127.0.0.1:8001/api";

/**
 * Every request to the API, with the owner's token on it.
 *
 * One door rather than a header at each call site, so a new endpoint cannot be
 * written without the token — the frontend's half of the server's route-table
 * guard. A 401 anywhere means the token is no good any more (revoked from
 * another browser, expired), and `AuthProvider` hears about it here and puts
 * Login back up; the caller still gets its rejection as usual.
 *
 * `init` is passed through untouched when there is no token, and not at all
 * when there is none to pass, so a request made signed out is the request it
 * always was.
 */
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = getToken();
  const url = `${API_BASE}${path}`;

  const res = token
    ? await fetch(url, {
        ...init,
        headers: { ...(init?.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` },
      })
    : init === undefined
      ? await fetch(url)
      : await fetch(url, init);

  if (res.status === 401) notifyUnauthorized();

  return res;
}

export type SetType = "normal" | "warmup" | "failure" | "dropset";

/**
 * Where one catalog response sits inside the whole filtered set.
 *
 * The catalog endpoints paginate only when asked to: a request that names no
 * `per_page` gets every matching row, which is what the pickers that need a
 * complete vocabulary rely on. `per_page` is null in exactly that case — there
 * is no page size to report — and `from`/`to` are null when the page is empty.
 */
export type PageMeta = {
  page: number;
  per_page: number | null;
  total: number;
  last_page: number;
  from: number | null;
  to: number | null;
};

/** The `{ data, meta }` envelope both catalog index endpoints return. */
export type Page<T> = { data: T[]; meta: PageMeta };

/** Page controls a list screen sends alongside its filters. */
export type PageQuery = { page?: number; per_page?: number };

export type ExerciseType = "weight_reps" | "reps_only" | "duration" | "distance_duration";

export type Exercise = {
  id: number;
  name: string;
  primary_muscle: string;
  equipment: string | null;
  exercise_type: ExerciseType;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type CreateExerciseInput = {
  name: string;
  primary_muscle: string;
  equipment?: string;
  exercise_type: ExerciseType;
  notes?: string;
};

export type UpdateExerciseInput = CreateExerciseInput;

/**
 * Ways to narrow `GET /api/exercises`. Every filter matches exactly, so its
 * value has to be one an exercise could actually hold — the screens feed them
 * from the same option lists the form writes with.
 */
export type ExerciseQuery = PageQuery & {
  search?: string;
  primary_muscle?: string;
  equipment?: string;
  exercise_type?: ExerciseType;
};

export type EquipmentStatus = "active" | "broken" | "wishlist";

export type Equipment = {
  id: number;
  name: string;
  /** Free-form category — see EQUIPMENT_TYPES for the offered list. */
  equipment_type: string;
  status: EquipmentStatus;
  notes: string | null;
  /**
   * Which default illustration to show while there is no photo — an art key
   * from equipmentArt.ts, or null to let the name and category pick one. Never
   * a file: an item with a thumbnail still has no photo, so `image_url` stays
   * null until one is uploaded.
   */
  thumbnail: string | null;
  /**
   * Absolute URL of the photo, or null when there is none. Carries a `v` query
   * parameter derived from `updated_at`, so replacing a photo yields a new URL
   * rather than a cached copy of the old one.
   */
  image_url: string | null;
  created_at: string;
  updated_at: string;
};

export type CreateEquipmentInput = {
  name: string;
  equipment_type: string;
  status: EquipmentStatus;
  /** Null hands the pick back to the name and category; omitting it does the same. */
  thumbnail?: string | null;
  notes?: string;
};

export type UpdateEquipmentInput = CreateEquipmentInput;

/** Ways to narrow `GET /api/equipment`. Both filters match exactly. */
export type EquipmentQuery = PageQuery & {
  search?: string;
  equipment_type?: string;
  status?: EquipmentStatus;
};

export type WorkoutSet = {
  id: number;
  workout_id: number;
  exercise_title: string;
  superset_id: string | null;
  exercise_notes: string | null;
  set_index: number;
  set_type: SetType;
  weight_kg: number | null;
  reps: number | null;
  distance_km: number | null;
  duration_seconds: number | null;
  rpe: number | null;
  created_at: string;
  updated_at: string;
};

export type Workout = {
  id: number;
  user_id: number;
  title: string;
  started_at: string;
  ended_at: string | null;
  description: string | null;
  notes: string | null;
  sets?: WorkoutSet[];
  set_count?: number;
  exercise_count?: number;
  duration_minutes?: number | null;
  created_at: string;
  updated_at: string;
};

export type WorkoutsResponse = {
  data: Workout[];
  /**
   * Counts for the whole table, not this page — `data` is clamped to `limit`,
   * so `data.length` is only a total when `returned === total`. Optional so a
   * frontend built against an older API still typechecks; callers should fall
   * back to `data.length` rather than assume it is present.
   */
  meta?: {
    total: number;
    returned: number;
    limit: number;
  };
  summary: {
    week_count: number;
    week_goal: number;
    streak_days: number;
    last_session: Workout | null;
  };
};

export type Insight = {
  id: number;
  domain: string;
  kind: string;
  title: string;
  response: string;
  input_summary: Record<string, unknown> | null;
  usage: Record<string, unknown> | null;
  model: string | null;
  created_at: string;
  updated_at: string;
};

export type CreateWorkoutInput = {
  title: string;
  started_at: string;
  ended_at?: string;
  notes?: string;
  exercises: Array<{
    exercise_title: string;
    exercise_notes?: string;
    sets: Array<{
      set_type: SetType;
      weight_kg?: number;
      reps?: number;
      rpe?: number;
      distance_km?: number;
      duration_seconds?: number;
    }>;
  }>;
};

export type UpdateWorkoutInput = CreateWorkoutInput;

export type ImportResult = {
  imported_sessions: number;
  imported_sets: number;
  skipped_sessions: number;
  errors: unknown[];
};

/** An Error carrying the HTTP status and, for 422s, Laravel's per-field errors. */
export type ApiError = Error & {
  status: number;
  fieldErrors?: Record<string, string[]>;
};

/**
 * Turn a failed response into a readable Error. Laravel returns
 * `{ message, errors: { field: [msg, …] } }` for validation failures, so we
 * surface the first field message rather than dumping raw JSON at the user.
 */
async function throwHttpError(res: Response): Promise<never> {
  let raw = "";
  try { raw = await res.text(); } catch {}

  let message = "";
  let fieldErrors: Record<string, string[]> | undefined;

  try {
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object") {
      const errors = (parsed as any).errors;
      if (errors && typeof errors === "object") {
        fieldErrors = errors as Record<string, string[]>;
        const first = Object.values(fieldErrors)[0];
        if (Array.isArray(first) && typeof first[0] === "string") message = first[0];
      }
      if (!message && typeof (parsed as any).message === "string") {
        message = (parsed as any).message;
      }
    }
  } catch {
    // Not JSON (HTML error page, proxy error, …) — fall through to the raw body.
  }

  if (!message) {
    // Keep the status for debuggability, and cap the body so an HTML error
    // page doesn't fill the banner.
    const snippet = raw.trim().slice(0, 200);
    message = `HTTP ${res.status}: ${snippet || res.statusText}`;
  }

  const err = new Error(message) as ApiError;
  err.status = res.status;
  if (fieldErrors) err.fieldErrors = fieldErrors;
  throw err;
}

/** Readable text for a caught error, without the `Error:` prefix `String(e)` adds. */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) await throwHttpError(res);
  const data = await res.json();
  return data as T;
}

/**
 * Serialise list options into a query string, dropping anything unset.
 *
 * An empty string is dropped rather than sent: the API reads a blank parameter
 * as "no filter" anyway, and leaving it out keeps the request URL — which the
 * screens key their loads on — identical whether a filter was never touched or
 * was cleared again.
 */
function queryString(opts?: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(opts ?? {})) {
    if (v === undefined || v === "") continue;
    q.set(k, String(v));
  }
  const qs = q.toString();
  return qs ? `?${qs}` : "";
}

/** For endpoints that return 204 No Content. */
async function handleVoid(res: Response): Promise<void> {
  if (!res.ok) await throwHttpError(res);
}

// ── Fitness dashboard stats ───────────────────────────────────────────────────

/** Selectable dashboard windows. `auto` is a request, never a response. */
export type RangeKey = "4w" | "12w" | "1y" | "all";

/** One calendar day that had a session. Days without one are simply absent. */
export type HeatmapDay = {
  date: string; // YYYY-MM-DD
  sessions: number;
  hard_sets: number;
  tonnage_kg: number;
  duration_min: number;
};

export type VolumeWeek = {
  week_start: string; // YYYY-MM-DD, on the day `settings.week_start` names
  sessions: number;
  hard_sets: number;
  tonnage_kg: number;
};

export type MuscleSlice = {
  /** "Unknown" for sets whose exercise_title has no catalog entry. */
  muscle: string;
  hard_sets: number;
  tonnage_kg: number;
  /** Fraction of total hard sets, 0–1. */
  share: number;
};

/** Best estimated 1RM of one day, with the set that produced it. */
export type LiftPoint = {
  date: string;
  e1rm_kg: number;
  weight_kg: number;
  reps: number;
};

export type Lift = {
  exercise_title: string;
  primary_muscle: string | null;
  points: LiftPoint[];
  first_e1rm_kg: number;
  latest_e1rm_kg: number;
  best_e1rm_kg: number;
  change_pct: number;
};

export type PersonalRecord = {
  exercise_title: string;
  date: string;
  e1rm_kg: number;
  weight_kg: number;
  reps: number;
  previous_e1rm_kg: number;
  gain_pct: number;
};

export type FitnessStats = {
  range: {
    requested: RangeKey | "auto";
    /** What the server actually used — `auto` widens until it finds data. */
    resolved: RangeKey;
    from: string;
    to: string;
    options: RangeKey[];
    data_first: string | null;
    data_last: string | null;
  };
  kpis: {
    sessions: number;
    hard_sets: number;
    tonnage_kg: number;
    avg_duration_min: number;
    sessions_per_week: number;
  };
  heatmap: {
    /** The week's first day on or before `range.from` — the grid origin. */
    from: string;
    to: string;
    max_hard_sets: number;
    /** Sparse: only days with a session. The client zero-fills the grid. */
    days: HeatmapDay[];
  };
  volume: {
    /** Dense and zero-filled, so an untrained month renders as empty bars. */
    weeks: VolumeWeek[];
    max_tonnage_kg: number;
    max_hard_sets: number;
  };
  muscles: {
    total_hard_sets: number;
    unmatched_sets: number;
    items: MuscleSlice[];
  };
  strength: {
    lifts: Lift[];
    recent_prs: PersonalRecord[];
  };
  /** How these numbers were made — Fitness → Settings → Calculations. */
  settings: CalculationSettings;
};

// ── Assistant ────────────────────────────────────────────────────────────────
// The chat loop, one queued run per message. `sendMessage` stores the turn and
// returns immediately with a run id; the loop happens on the server's own time
// and is watched through `getRun` or the SSE stream. A run stops dead when the
// model proposes a write, which the user then approves or declines through
// `decideAction` — which queues the continuation the same way.

/**
 * One block of a stored turn, as the transcript endpoint returns them.
 *
 * Kept as blocks rather than flattened to a string because a single assistant
 * turn can say something, call a tool, and then say something else — a screen
 * that read only `text` would show the prose with the work between it missing.
 * Thinking blocks never arrive here; the server drops them from responses
 * (they carry no displayable text) and keeps them only for replay.
 */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }
  /**
   * A camera snapshot the user attached.
   *
   * A URL rather than the bytes, which is the opposite of what the model is
   * handed. The picture is on the server's private disk and streamed by
   * `/api/agent/snapshots/{id}`, so re-reading a thread costs a cached `<img>`
   * rather than a fresh hundred kilobytes of base64 — and the HUD re-reads its
   * thread at the end of every run.
   */
  | { type: "image"; snapshot_id: number; media_type: string; url: string }
  | { type: string; [key: string]: unknown };

/** A frame on its way up, as `sendMessage` takes it. */
export type OutgoingImage = { data: string; media_type: string };

export type ChatRole = "user" | "assistant";

export type ChatMessage = {
  id: number;
  role: ChatRole;
  content: ContentBlock[];
  /** Every text block of the turn, joined. Empty for a turn that only called tools. */
  text: string;
  stop_reason: string | null;
  created_at: string | null;
};

export type ActionStatus = "pending" | "approved" | "rejected";

/**
 * One tool call the assistant made or wants to make.
 *
 * Every call is recorded, not only the gated ones, so `requires_confirmation`
 * is what separates "this already ran" from "this is waiting on you". Reads are
 * born approved; writes start pending and stay there until decided.
 */
export type AgentAction = {
  id: number;
  tool: string;
  input: Record<string, unknown> | null;
  requires_confirmation: boolean;
  status: ActionStatus;
  result: string | null;
  is_error: boolean;
  decided_at: string | null;
  created_at: string | null;
};

export type Conversation = {
  id: number;
  /** Null only before the first message — the server names a thread from it. */
  title: string | null;
  last_message_at: string | null;
  created_at: string | null;
};

/**
 * Where a run is.
 *
 * The first two mean it is still going. Of the rest, `awaiting_confirmation` is
 * the one that changes what the screen may do next: the transcript now ends
 * with an unanswered tool call, and sending another message before deciding it
 * is a 409.
 */
export type RunStatus =
  | "queued"
  | "running"
  | "completed"
  | "awaiting_confirmation"
  | "max_iterations"
  | "failed";

/**
 * One queued trip through the tool loop.
 *
 * `finished` is given rather than derived, so a client never has to hold its
 * own copy of which statuses are terminal in order to answer the only question
 * it actually has: do I keep watching?
 */
export type AgentRun = {
  id: string;
  conversation_id: number;
  trigger: "message" | "resume";
  status: RunStatus;
  finished: boolean;
  /** Only ever set alongside `failed`, and it is what the user is shown. */
  error: string | null;
  /**
   * Where the run's event log is streamed from, signed for half an hour.
   *
   * Signed because `EventSource` cannot send the bearer token; absolute and
   * used as it is, with `&after=N` appended to resume. Past its expiry the
   * stream errors and the watcher polls, which carries the token.
   */
  stream_url?: string | null;
  created_at: string | null;
};

/**
 * One thing that happened during a run.
 *
 * These are a *view* of the run and never its record — each one duplicates
 * something the server is already writing to the transcript — so missing them
 * costs a live display and nothing else. `seq` is the resume token: ask for
 * everything after the highest one seen.
 */
export type RunEvent = {
  seq: number;
  type:
    | "run.started"
    | "thinking"
    | "text"
    | "tool.started"
    | "tool.finished"
    | "awaiting"
    | "run.finished"
    | string;
  data: Record<string, unknown>;
};

/** 202 from `sendMessage`: the turn is stored, the answer is not written yet. */
export type MessageAccepted = {
  run: AgentRun;
  /** Re-sent because the thread has just been named after this message. */
  conversation: Conversation;
  /** The stored user turn, so an optimistic bubble can be swapped immediately. */
  message: ChatMessage;
};

export type ConversationDetail = {
  conversation: Conversation;
  messages: ChatMessage[];
  pending_actions: AgentAction[];
  /** Set when a run is still going, so reopening a thread rejoins it. */
  run: AgentRun | null;
};

/**
 * What a decision comes back as.
 *
 * `run` is null while other writes in the same turn are still undecided —
 * there is nothing to resume yet, and the remaining cards stay up.
 */
export type ActionDecision = {
  action: AgentAction;
  conversation: Conversation;
  pending_actions: AgentAction[];
  run: AgentRun | null;
};

/** The tail of a run's event log, for a client that cannot hold a stream open. */
export type RunUpdate = { run: AgentRun; events: RunEvent[] };

/** One bar in the core menu's System stats: how much of something is in use. */
export type Gauge = { used_bytes: number; total_bytes: number; percent: number };

/**
 * What the machine serving this app is doing.
 *
 * Every field is nullable, and that is the contract rather than defensiveness.
 * CPU and memory come from a sample taken on a queue worker, so they are null
 * until the first one lands and stay at the last reading if the worker dies —
 * `age_seconds` is how the panel tells those apart. Disk is computed inline and
 * is the one thing that is current on the very first request.
 */
export type SystemStats = {
  host: string | null;
  platform: string;
  sampled_at: string | null;
  age_seconds: number | null;
  cpu: { percent: number } | null;
  memory: Gauge | null;
  disk: (Gauge & { path: string }) | null;
};

export type Severity = "ok" | "warn" | "problem";

/**
 * One thing a diagnosis found. `key` is `group.name`; `evidence` is a list of
 * `label: value` lines and is carried on a passing finding too, because the
 * Stats page's *All checks* is where the numbers its old cards held now live.
 * A finding offers a soft `fix` or a `manual` step, never both, and an `ok`
 * one offers neither.
 */
export type Finding = {
  key: string;
  group: string;
  title: string;
  severity: Severity;
  detail: string;
  evidence: string[];
  fix: { key: string; label: string } | null;
  manual: string | null;
};

/** A stored report as the list reads it — no findings. */
export type ReportSummary = {
  id: number;
  kind: "diagnose" | "troubleshoot";
  source: "ui" | "cli";
  ran_at: string;
  /** "2 problems, 1 warning · 37 checks", written by the server once. */
  verdict: string;
  counts: { problems: number; warnings: number; passed: number; total: number };
  /** What a troubleshoot's fixes did, counted; null on a diagnosis, which runs nothing. */
  fix_counts: { done: number; failed: number; skipped: number } | null;
  /** Signed; the `.md` as a download. Null if the file was never written. */
  file_url: string | null;
  bytes: number | null;
};

/** One fix a troubleshoot ran, or did not and why. */
export type FixOutcome = {
  key: string;
  label: string;
  status: "done" | "failed" | "skipped";
  detail: string;
};

/**
 * Not `Report`, which would shadow the DOM's Reporting API global.
 *
 * On a troubleshoot the findings are the state *after* its fixes. `fixes` is
 * what Troubleshoot would apply now, in the order it runs them — what the
 * confirm dialog lists — worked out by the server, which knows the run order
 * and what this machine can do.
 */
export type DiagnosticReport = ReportSummary & {
  findings: Finding[];
  outcomes: FixOutcome[];
  fixes: { key: string; label: string }[];
};

/**
 * `GET /api/diagnostics` and `POST /api/diagnostics/run` both answer this, so
 * the page redraws from either. `latest` is the newest report whatever its
 * kind, and **null on a checkout that has never diagnosed** — "not yet run",
 * never an empty report, which would read as a clean bill of health.
 */
export type Diagnostics = {
  latest: DiagnosticReport | null;
  reports: ReportSummary[];
  groups: { key: string; title: string }[];
};

/**
 * `GET /api/assistant/activity`: what Assistant → Activity shows — what the
 * assistant keeps, and what it did and spent over the window.
 *
 * **Zero is a real answer** throughout; only the two `last_*_at` instants are
 * ever null. The window is named rather than assumed, so the tab says "7 days"
 * because the server did.
 */
export type AssistantActivity = {
  generated_at: string;
  window: { days: number; since: string; timezone: string };
  records: {
    conversations: number;
    messages: number;
    insights: number;
    snapshots: number;
    /** Active facts — what the prompt carries. */
    facts: number;
    last_conversation_at: string | null;
    last_insight_at: string | null;
  };
  /** The extractor's week: proposed by when learned, kept by when decided. */
  facts: { proposed: number; kept: number };
  /** Every status is a key, zero where there were none. */
  runs: Record<RunStatus, number>;
  tool_calls: number;
  tool_errors: number;
  /** Only calls that needed an approval — reads are born approved and are not counted here. */
  gated: { approved: number; rejected: number; pending: number };
  tools: { tool: string; calls: number }[];
  /** Every paid call this week, off the server's ledger — so a deleted thread's tokens are still here. */
  tokens: { input: number; output: number; cache_read: number; cache_write: number };
  /**
   * Those tokens at list price: an estimate, never the bill. A model the
   * server has no price for is named and left out.
   */
  spend: Spend;
  /** The same, from midnight on the 1st of the user's calendar month — not Anthropic's billing period, which the app cannot read. */
  spend_month: Spend & { since: string };
};

/** Tokens at list price over one window. */
export type Spend = { usd: number; unpriced_models: string[]; unpriced_tokens: number; prices_as_of: string };

/**
 * The weather, or why there isn't any.
 *
 * Three states, not two: `configured` false means nobody has said where this
 * machine is, which is a different panel from a forecast that could not be
 * fetched.
 *
 * `observed_at` is an instant. Everything in `hourly` and `daily` is **wall
 * clock** on the user's zone, like the calendar's times — `"2026-09-11T15:00:00"`,
 * no offset — so it is read with `calendar.parse`, never `new Date()`.
 */
export type Weather = {
  configured: boolean;
  available: boolean;
  message?: string;
  label?: string | null;
  timezone?: string;
  observed_at?: string | null;
  condition?: string | null;
  weather_code?: number | null;
  is_day?: boolean | null;
  temperature_c?: number | null;
  apparent_c?: number | null;
  humidity?: number | null;
  precipitation_chance?: number | null;
  wind_kph?: number | null;
  wind_from?: string | null;
  /** The next 24 hours, from the one in progress when the server last read it. */
  hourly?: WeatherHour[];
  /** Today and the six days after it. */
  daily?: WeatherDay[];
};

export type WeatherHour = {
  time: string;
  condition: string | null;
  weather_code: number | null;
  is_day: boolean | null;
  temperature_c: number | null;
  precipitation_chance: number | null;
};

export type WeatherDay = {
  date: string;
  condition: string | null;
  weather_code: number | null;
  high_c: number | null;
  low_c: number | null;
  precipitation_chance: number | null;
  precipitation_mm: number | null;
  wind_max_kph: number | null;
  uv_index: number | null;
  sunrise: string | null;
  sunset: string | null;
};

/** Up, down, or never seen — the last of which is a different fix from the second. */
export type ServiceState = "up" | "down" | "unknown";

/**
 * The assistant has a fourth state, and it is not a failure.
 *
 * `down` is a machine with no `ANTHROPIC_API_KEY`, which is a setup nobody
 * finished; `off` is the switch on the Settings screen, which is a decision
 * somebody made. Kept out of `ServiceState` so the heartbeats cannot claim a
 * state they have no way of being in.
 */
export type AssistantState = ServiceState | "off";

/**
 * Whether Anthropic last refused a call for lack of credit.
 *
 * Not a balance — Anthropic has no API for one — but what a refused call
 * proves. It clears itself on the next call that goes through.
 */
export type AnthropicCredit = {
  exhausted: boolean;
  /** ISO instant of the first refusal, or null while clear. */
  since: string | null;
  last_refused_at: string | null;
};

/** The assistant as `/api/health` reports it, and as the switch writes it back. */
export type AssistantHealth = {
  state: AssistantState;
  /** The switch: whether this app is allowed to spend anything at Anthropic. */
  enabled: boolean;
  /** Whether there is a key to spend it with, which is a separate question. */
  configured: boolean;
  model: string | null;
  /** Optional so a reading from an older server still draws; absent is clear. */
  credit?: AnthropicCredit;
};

/**
 * `GET /api/voice/credits`: what is left of the ElevenLabs plan.
 *
 * `unconfigured` (no key) and `unavailable` (with a `message`) are states of
 * the Voice card, not errors — the numbers are null in both.
 */
export type VoiceCredits = {
  state: "available" | "unconfigured" | "unavailable";
  used: number | null;
  limit: number | null;
  remaining: number | null;
  /** ISO instant the allowance resets, when ElevenLabs says. */
  resets_at: string | null;
  tier: string | null;
  message: string | null;
  checked_at: string;
};

/** `AssistantSettings::MODELS` on the server. */
export const ASSISTANT_MODELS = ["claude-sonnet-5", "claude-opus-5"] as const;
export type AssistantModel = (typeof ASSISTANT_MODELS)[number];

export const EFFORTS = ["low", "medium", "high"] as const;
export type Effort = (typeof EFFORTS)[number];

export const THINKING_DISPLAYS = ["summarized", "omitted"] as const;
export type ThinkingDisplay = (typeof THINKING_DISPLAYS)[number];

/** Model calls one message may cost. */
export const MAX_ITERATIONS = [6, 12, 20] as const;

/** Camera frames still re-sent with a thread. Never 0 — see `AssistantSettings::REPLAYS`. */
export const SNAPSHOT_REPLAYS = [1, 3, 5] as const;

/**
 * Assistant → Settings' server half: read by the worker, the scheduler and
 * voice turns, none of which has a browser. A value from `.env` outside these
 * sets is reported as it is, so a model may be a string no option matches.
 */
export type AssistantServerSettings = {
  models: { chat: string; insight: string };
  reasoning: { effort: string; thinking_display: string };
  limits: { max_iterations: number; snapshot_replay: number };
  /** Read-only: whether each half of voice is set, never the key. */
  voice: { configured: boolean; agent_configured: boolean; local_actions: boolean };
};

/** Each group optional and partial; the server writes only what it is sent. */
export type AssistantSettingsPatch = {
  models?: Partial<{ chat: AssistantModel; insight: AssistantModel }>;
  reasoning?: Partial<{ effort: Effort; thinking_display: ThinkingDisplay }>;
  limits?: Partial<{ max_iterations: number; snapshot_replay: number }>;
};

/**
 * One instruction Claude is given that the owner may reword
 * (`AssistantInstructions`). `text` is what is sent: the rewording, or
 * `default` when there is none.
 */
export type AssistantInstruction = {
  key: string;
  label: string;
  /** Where it lands, in a sentence — the server's, so the screen keeps no list. */
  used_by: string;
  text: string;
  default: string;
  reworded: boolean;
};

export type AssistantInstructions = { data: AssistantInstruction[]; max_chars: number };

/** By key; `null` (or blank, or the default) goes back to the default. */
export type AssistantInstructionsPatch = Record<string, string | null>;

/** `ProactiveTriggers::KEYS`, in the same priority order. */
export const NUDGE_TRIGGERS = ["layoff", "volume_drop", "new_pr", "muscle_gap"] as const;
export type NudgeTrigger = (typeof NUDGE_TRIGGERS)[number];

/**
 * The morning nudge, as the scheduler and the worker read it. Rows on the
 * server rather than a browser preference, because neither has a browser.
 */
export type NudgeSettings = {
  enabled: boolean;
  /** 24-hour HH:MM on `timezone`. */
  time: string;
  /** The triggers allowed to speak; empty is every one switched off. */
  triggers: NudgeTrigger[];
  /** `AGENT_TIMEZONE` — read-only, so the screen can say whose 07:00 it is. */
  timezone: string;
};

export const E1RM_FORMULAS = ["epley", "brzycki"] as const;
export type E1rmFormula = (typeof E1RM_FORMULAS)[number];

export const WEEK_STARTS = ["monday", "sunday"] as const;
export type WeekStart = (typeof WEEK_STARTS)[number];

export type CalculationSettings = { e1rm_formula: E1rmFormula; week_start: WeekStart };

export type FitnessServerSettings = { nudges: NudgeSettings; calculations: CalculationSettings };

/** Each half is optional; the server writes only what it is sent. */
export type FitnessSettingsPatch = {
  nudges?: Partial<Omit<NudgeSettings, "timezone">>;
  calculations?: Partial<CalculationSettings>;
};

export type Health = {
  /** Every service collapsed to one boolean, for the pill in the chrome bar. */
  ok: boolean;
  checked_at: string;
  database: {
    state: ServiceState;
    driver?: string;
    latency_ms?: number;
    journal_mode?: string | null;
    size_bytes?: number | null;
    detail?: string;
  };
  queue: {
    state: ServiceState;
    last_beat_at: string | null;
    age_seconds: number | null;
    /** Null when the queue is one the server cannot look inside. */
    pending: number | null;
  };
  scheduler: { state: ServiceState; last_beat_at: string | null; age_seconds: number | null };
  assistant: AssistantHealth;
};

// ── Calendar ─────────────────────────────────────────────────────────────────

/**
 * One thing on one of the user's calendars — Google, iCloud or any other.
 *
 * **`starts_at` and `ends_at` are wall clock, not instants**, and they arrive
 * with no `Z` and no offset — `"2026-09-10T15:00:00"` — which is the one form
 * `new Date()` parses as *local* time. The server converts each feed into the
 * user's zone once, on the way in, and nothing on this side converts again.
 *
 * The consequence for every caller here is that **the client decides which day
 * is today**. The endpoint has no default window; the panel passes the local
 * dates it means.
 *
 * There is no `id`. An iCal instance has a UID shared by every occurrence of a
 * series, and nothing here ever addresses one event: this app reads the
 * calendar and Google Calendar is where it is changed.
 */
export type CalendarEvent = {
  /** Which `CalendarFeed` it came from — its colour and its name. */
  calendar_id: number;
  title: string;
  starts_at: string;
  /**
   * Exclusive, as iCalendar has it: an all-day event on the 12th ends at
   * `2026-09-13T00:00:00`. Null is a moment rather than a span.
   */
  ends_at: string | null;
  all_day: boolean;
  location: string | null;
};

/**
 * Google Calendar's own colour names, in the order its picker shows them.
 *
 * A closed set, mirrored from `CalendarFeed::COLORS` on the server: the feed
 * carries a calendar's name but not its colour, so the user picks one again
 * here, and a name they already know from Google is easier to match than a hex.
 */
export const CALENDAR_COLORS = [
  "tomato",
  "flamingo",
  "tangerine",
  "banana",
  "sage",
  "basil",
  "peacock",
  "blueberry",
  "lavender",
  "grape",
  "graphite",
] as const;

export type CalendarColor = (typeof CALENDAR_COLORS)[number];

/**
 * How a feed's last fetch went. `pending` is a calendar nobody has read yet;
 * `failed` keeps its last reading, so its events are still in the list.
 */
export type FeedStatus = "ok" | "failed" | "pending";

/**
 * One connected calendar, as Settings and the panel see it.
 *
 * **The address is not here and never will be.** It is a bearer credential for
 * the whole calendar, so it goes in once and no endpoint returns it.
 */
export type CalendarFeed = {
  id: number;
  /** Read off the feed's `X-WR-CALNAME`. Null when the feed does not say. */
  name: string | null;
  color: CalendarColor;
  enabled: boolean;
  status: FeedStatus;
  /** A sentence, for `failed` only — never the provider's own error, which quotes the address. */
  message: string | null;
  /** When the events being shown were read, which after a failure is how old they are. */
  fetched_at: string | null;
  /** Events the feed carried that could not be read. Rare, and said. */
  skipped: number;
};

/** `GET /api/calendar`: every enabled calendar's events in one list, and how each feed is. */
export type CalendarWindow = {
  /** Whether any calendar is connected at all, switched on or not. */
  configured: boolean;
  from: string;
  to: string;
  /** Soonest first across every calendar, all-day ahead of timed on the same start. */
  events: CalendarEvent[];
  /** The enabled feeds only — a switched-off calendar is not on the panel at all. */
  feeds: CalendarFeed[];
};

export type CalendarFeedPatch = Partial<Pick<CalendarFeed, "color" | "enabled">>;

export const api = {
  /** `limit` is clamped to 200 server-side; omitting it uses the backend default of 50. */
  listWorkouts: (opts?: { limit?: number }): Promise<WorkoutsResponse> => {
    const url = opts?.limit ? `/workouts?limit=${opts.limit}` : `/workouts`;
    return apiFetch(url).then<WorkoutsResponse>(handle);
  },

  createWorkout: (input: CreateWorkoutInput): Promise<Workout> =>
    apiFetch(`/workouts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(input),
    }).then<Workout>(handle),

  importWorkoutsCsv: async (file: File): Promise<ImportResult> => {
    const fd = new FormData();
    fd.append("file", file);
    const res = await apiFetch(`/workouts/import`, {
      method: "POST",
      headers: { Accept: "application/json" },
      body: fd,
    });
    return handle<ImportResult>(res);
  },

  generateFitnessInsight: (): Promise<Insight> =>
    apiFetch(`/insights/fitness`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
    }).then<Insight>(handle),


  /**
   * The whole Fitness → Home dashboard in one request.
   *
   * `range` defaults to "auto": the server resolves the narrowest window that
   * actually contains sessions, so the dashboard is never blank on stale data.
   */
  getFitnessStats: (opts?: { range?: RangeKey | "auto" }): Promise<FitnessStats> => {
    const q = opts?.range && opts.range !== "auto" ? `?range=${opts.range}` : "";
    return apiFetch(`/fitness/stats${q}`, {
      headers: { Accept: "application/json" },
    }).then<FitnessStats>(handle);
  },
  /**
   * `kind` narrows to one kind of insight. The proactive layer writes its
   * nudges into the same table as the weekly assessments, and Fitness → Home
   * shows both, marking a nudge UNPROMPTED.
   */
  listInsights: (opts?: { domain?: string; kind?: string; limit?: number }): Promise<{
    data: Insight[];
  }> => {
    const q = new URLSearchParams();
    if (opts?.domain) q.set("domain", opts.domain);
    if (opts?.kind) q.set("kind", opts.kind);
    if (opts?.limit) q.set("limit", String(opts.limit));

    const query = q.toString();
    return apiFetch(`/insights${query ? `?${query}` : ""}`).then<{ data: Insight[] }>(
      handle,
    );
  },

  /**
   * What this machine is doing. Answered from the last sample rather than
   * probed, so it is safe to poll — `age_seconds` says how stale it is, and a
   * climbing age is the queue worker being down.
   */
  getSystemStats: (): Promise<SystemStats> =>
    apiFetch(`/system/stats`, { headers: { Accept: "application/json" } }).then<SystemStats>(
      handle,
    ),

  /** The newest report and the list. Read when Stats opens, never polled. */
  getDiagnostics: (): Promise<Diagnostics> =>
    apiFetch(`/diagnostics`, { headers: { Accept: "application/json" } }).then<Diagnostics>(handle),

  /**
   * Run every check now and store the report. Synchronous — the answer is the
   * new state. A 409 means a run is already out; its sentence says so.
   */
  runDiagnostics: (): Promise<Diagnostics> =>
    apiFetch(`/diagnostics/run`, {
      method: "POST",
      headers: { Accept: "application/json" },
    }).then<Diagnostics>(handle),

  /**
   * Apply the soft fixes `report` offers, then check again. The server reads
   * the list off that stored report — the one the confirm dialog was drawn
   * from — so the page cannot name a fix of its own. Synchronous, like a run.
   */
  troubleshoot: (report: number): Promise<Diagnostics> =>
    apiFetch(`/diagnostics/troubleshoot`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ report }),
    }).then<Diagnostics>(handle),

  /** What the assistant keeps and did this week, read only while Assistant → Activity is showing. */
  getAssistantActivity: (): Promise<AssistantActivity> =>
    apiFetch(`/assistant/activity`, { headers: { Accept: "application/json" } }).then<AssistantActivity>(
      handle,
    ),

  getWeather: (): Promise<Weather> =>
    apiFetch(`/weather`, { headers: { Accept: "application/json" } }).then<Weather>(handle),

  getHealth: (): Promise<Health> =>
    apiFetch(`/health`, { headers: { Accept: "application/json" } }).then<Health>(handle),

  /**
   * Turn this app's Anthropic usage on or off, for the whole machine.
   *
   * There is no matching read: the switch is reported by `/api/health`, which
   * the shell already polls for the status pill, and a second endpoint would be
   * a second poller disagreeing with the first for fifteen seconds at a time.
   * The response is the new state so the screen can draw it immediately rather
   * than wait for that poll.
   */
  setAnthropicEnabled: (enabled: boolean): Promise<AssistantHealth> =>
    apiFetch(`/settings/anthropic`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ enabled }),
    }).then<AssistantHealth>(handle),

  /** Fitness → Settings' server half. Nothing polls it; the screen reads it on arrival. */
  getFitnessSettings: (): Promise<FitnessServerSettings> =>
    apiFetch(`/settings/fitness`, { headers: { Accept: "application/json" } }).then<FitnessServerSettings>(
      handle,
    ),

  /** Writes only what it is given, and answers the whole state. */
  patchFitnessSettings: (patch: FitnessSettingsPatch): Promise<FitnessServerSettings> =>
    apiFetch(`/settings/fitness`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(patch),
    }).then<FitnessServerSettings>(handle),

  /** Assistant → Settings' server half. Nothing polls it; the screen reads it on arrival. */
  getAssistantSettings: (): Promise<AssistantServerSettings> =>
    apiFetch(`/settings/assistant`, { headers: { Accept: "application/json" } }).then<AssistantServerSettings>(
      handle,
    ),

  /** What is left of the ElevenLabs plan. Always 200; read on arrival, never polled. */
  getVoiceCredits: (): Promise<VoiceCredits> =>
    apiFetch(`/voice/credits`, { headers: { Accept: "application/json" } }).then<VoiceCredits>(handle),

  /** Writes only what it is given, and answers the whole state. */
  patchAssistantSettings: (patch: AssistantSettingsPatch): Promise<AssistantServerSettings> =>
    apiFetch(`/settings/assistant`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(patch),
    }).then<AssistantServerSettings>(handle),

  /** Assistant → Instructions. Nothing polls it; the tab reads it on arrival. */
  getAssistantInstructions: (): Promise<AssistantInstructions> =>
    apiFetch(`/settings/instructions`, { headers: { Accept: "application/json" } }).then<AssistantInstructions>(
      handle,
    ),

  /** Rewords only what it is given, and answers every instruction. */
  patchAssistantInstructions: (patch: AssistantInstructionsPatch): Promise<AssistantInstructions> =>
    apiFetch(`/settings/instructions`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(patch),
    }).then<AssistantInstructions>(handle),

  /**
   * Permission to open a spoken session, in the form of a token.
   *
   * The page holds the conversation with ElevenLabs itself, over WebRTC — no
   * audio passes through Laravel in either direction. What Laravel is in the
   * middle of is exactly one thing: the API key, which cannot be an
   * `EXPO_PUBLIC_*` value because Expo inlines every one of those into this
   * bundle. So the server mints a token scoped to one session and hands that
   * over instead.
   *
   * A refusal is a refusal here: there is no other voice underneath it, so the
   * message is written to be read by the person who pressed Talk.
   */
  voiceToken: (): Promise<{ token: string }> =>
    apiFetch(`/voice/token`, {
      headers: { Accept: "application/json" },
    }).then<{ token: string }>(handle),

  /**
   * One spoken question, through the same tool loop a typed one goes through.
   *
   * Called from inside the client tool the ElevenLabs agent invokes, so the
   * thing waiting on this response is a tool call with a timeout on it rather
   * than a screen — which is why it is synchronous where `sendMessage` answers
   * 202 and hands back a run to watch.
   *
   * `conversation_id` is what puts a spoken turn in the same thread as a typed
   * one. Absent, the server makes a thread and returns its id; the caller keeps
   * it, so the second question of a session lands beside the first.
   */
  voiceTurn: (
    message: string,
    conversationId: number | null,
    signal?: AbortSignal,
  ): Promise<{ text: string; conversation_id: number }> =>
    apiFetch(`/voice/turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        message,
        ...(conversationId === null ? {} : { conversation_id: conversationId }),
      }),
      signal,
    }).then<{ text: string; conversation_id: number }>(handle),

  getWorkout: (id: number): Promise<Workout> =>
    apiFetch(`/workouts/${id}`, {
      headers: { Accept: "application/json" },
    }).then<Workout>(handle),

  updateWorkout: (id: number, input: UpdateWorkoutInput): Promise<Workout> =>
    apiFetch(`/workouts/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(input),
    }).then<Workout>(handle),

  deleteWorkout: (id: number): Promise<void> =>
    apiFetch(`/workouts/${id}`, {
      method: "DELETE",
      headers: { Accept: "application/json" },
    }).then(handleVoid),

  /**
   * Omit `per_page` to get the whole catalog — that is what the Workouts
   * screen's exercise picker needs. List screens pass a page instead.
   */
  listExercises: (opts?: ExerciseQuery): Promise<Page<Exercise>> =>
    apiFetch(`/exercises${queryString(opts)}`, {
      headers: { Accept: "application/json" },
    }).then<Page<Exercise>>(handle),

  createExercise: (input: CreateExerciseInput): Promise<Exercise> =>
    apiFetch(`/exercises`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(input),
    }).then<Exercise>(handle),

  updateExercise: (id: number, input: UpdateExerciseInput): Promise<Exercise> =>
    apiFetch(`/exercises/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(input),
    }).then<Exercise>(handle),

  deleteExercise: (id: number): Promise<void> =>
    apiFetch(`/exercises/${id}`, {
      method: "DELETE",
      headers: { Accept: "application/json" },
    }).then(handleVoid),

  // ── Equipment ───────────────────────────────────────────────────────────────
  // Fields travel as JSON and the photo has its own endpoints, so a record can
  // be saved without re-uploading its image and an upload never has to resend
  // the form. Creating an item with a photo is therefore two calls: create,
  // then upload against the new id.

  /**
   * Omit `per_page` to get the whole catalog — that is what the exercise
   * form's Equipment picker needs. The list screen passes a page instead.
   */
  listEquipment: (opts?: EquipmentQuery): Promise<Page<Equipment>> =>
    apiFetch(`/equipment${queryString(opts)}`, {
      headers: { Accept: "application/json" },
    }).then<Page<Equipment>>(handle),

  createEquipment: (input: CreateEquipmentInput): Promise<Equipment> =>
    apiFetch(`/equipment`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(input),
    }).then<Equipment>(handle),

  updateEquipment: (id: number, input: UpdateEquipmentInput): Promise<Equipment> =>
    apiFetch(`/equipment/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(input),
    }).then<Equipment>(handle),

  deleteEquipment: (id: number): Promise<void> =>
    apiFetch(`/equipment/${id}`, {
      method: "DELETE",
      headers: { Accept: "application/json" },
    }).then(handleVoid),

  /** Replaces any existing photo. Returns the record with its new `image_url`. */
  uploadEquipmentImage: async (id: number, file: File): Promise<Equipment> => {
    const fd = new FormData();
    fd.append("image", file);
    const res = await apiFetch(`/equipment/${id}/image`, {
      method: "POST",
      headers: { Accept: "application/json" },
      body: fd,
    });
    return handle<Equipment>(res);
  },

  deleteEquipmentImage: (id: number): Promise<Equipment> =>
    apiFetch(`/equipment/${id}/image`, {
      method: "DELETE",
      headers: { Accept: "application/json" },
    }).then<Equipment>(handle),

  // ── Calendar ────────────────────────────────────────────────────────────────
  // The user's calendars — Google, iCloud, any provider — read by the server
  // through their iCal addresses. Read-only from here: events are made in the
  // calendar's own app.

  /**
   * A window of the calendar. Both bounds are local dates and both are
   * required — see `CalendarEvent` for why "today" is the client's word. Always
   * a 200: no calendars, and a calendar that could not be read, are states
   * of the panel rather than failures of the request.
   */
  getCalendar: (window: { from: string; to: string }): Promise<CalendarWindow> =>
    apiFetch(`/calendar${queryString(window)}`, {
      headers: { Accept: "application/json" },
    }).then<CalendarWindow>(handle),

  listCalendarFeeds: (): Promise<{ data: CalendarFeed[] }> =>
    apiFetch(`/calendar/feeds`, {
      headers: { Accept: "application/json" },
    }).then<{ data: CalendarFeed[] }>(handle),

  /**
   * Connect a calendar by its secret address. The server fetches it once
   * before saving, so a wrong address is a 422 with a sentence rather than a
   * calendar that is unreachable forever — and the name comes off the feed.
   * The colour is the first one no other calendar is using.
   */
  addCalendarFeed: (url: string): Promise<CalendarFeed> =>
    apiFetch(`/calendar/feeds`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ url }),
    }).then<CalendarFeed>(handle),

  updateCalendarFeed: (id: number, patch: CalendarFeedPatch): Promise<CalendarFeed> =>
    apiFetch(`/calendar/feeds/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(patch),
    }).then<CalendarFeed>(handle),

  removeCalendarFeed: (id: number): Promise<void> =>
    apiFetch(`/calendar/feeds/${id}`, {
      method: "DELETE",
      headers: { Accept: "application/json" },
    }).then(handleVoid),

  // ── Assistant ───────────────────────────────────────────────────────────────

  listConversations: (): Promise<{ data: Conversation[] }> =>
    apiFetch(`/agent/conversations`, {
      headers: { Accept: "application/json" },
    }).then<{ data: Conversation[] }>(handle),

  /** Left untitled: the first message names the thread, server-side. */
  createConversation: (): Promise<Conversation> =>
    apiFetch(`/agent/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({}),
    }).then<Conversation>(handle),

  getConversation: (id: number): Promise<ConversationDetail> =>
    apiFetch(`/agent/conversations/${id}`, {
      headers: { Accept: "application/json" },
    }).then<ConversationDetail>(handle),

  /** Deletes the record of what the assistant did, never what it wrote. */
  deleteConversation: (id: number): Promise<void> =>
    apiFetch(`/agent/conversations/${id}`, {
      method: "DELETE",
      headers: { Accept: "application/json" },
    }).then(handleVoid),

  /**
   * Say something. Returns as soon as the turn is stored, not when it is
   * answered.
   *
   * 202 with a run id: the loop runs in a worker, and `watchRun` is how the
   * screen finds out what it did. A 409 comes back when the conversation is
   * already busy — either a run is still going, or a proposed write has not
   * been decided.
   *
   * `image` is a camera frame, and it is the only part of this request that can
   * be refused on its own terms: 413 for a frame bigger than the server's
   * ceiling and 429 once the day's snapshots are spent. Both leave the
   * conversation exactly as it was, so the draft goes back in the box.
   */
  sendMessage: (id: number, message: string, image?: OutgoingImage | null): Promise<MessageAccepted> =>
    apiFetch(`/agent/conversations/${id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      // Omitted rather than sent null: `required_without:image` on the server
      // reads a present key as an attachment, so a null one would make an empty
      // message look like it had a picture with it.
      body: JSON.stringify(image ? { message, image } : { message }),
    }).then<MessageAccepted>(handle),

  /**
   * Approve or decline one proposed write.
   *
   * The decision itself is made inside this request — an approved write runs
   * here, so the change has landed by the time this resolves. Only the
   * continuation is queued, and `run` is what to watch for it; it is null while
   * other writes from the same turn are still undecided.
   */
  decideAction: (id: number, decision: "approve" | "reject"): Promise<ActionDecision> =>
    apiFetch(`/agent/actions/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ decision }),
    }).then<ActionDecision>(handle),

  /** Everything a run has done since `after`, for a client that polls. */
  getRun: (runId: string, after = 0): Promise<RunUpdate> =>
    apiFetch(`/agent/runs/${runId}?after=${after}`, {
      headers: { Accept: "application/json" },
    }).then<RunUpdate>(handle),

  // ── Signing in ──────────────────────────────────────────────────────────────
  // The owner's Google account and nobody else's. Where the browser goes and
  // what comes back is `AuthProvider`'s business; these are the four calls.

  /** Where to send the browser: Google's consent page, with this sign-in's state and PKCE challenge. */
  startGoogleSignIn: (): Promise<{ url: string }> =>
    apiFetch(`/auth/google/start`, {
      method: "POST",
      headers: { Accept: "application/json" },
    }).then<{ url: string }>(handle),

  /**
   * Redeem the code Google sent back. A refusal — another Google account, an
   * expired state — is a 4xx whose `message` is the sentence Login shows.
   */
  completeGoogleSignIn: (code: string, state: string): Promise<{ token: string; user: AuthUser }> =>
    apiFetch(`/auth/google/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ code, state }),
    }).then<{ token: string; user: AuthUser }>(handle),

  me: (): Promise<AuthUser> =>
    apiFetch(`/auth/me`, { headers: { Accept: "application/json" } }).then<AuthUser>(handle),

  /** Ends this browser's session and no other. */
  logout: (): Promise<{ signed_out: boolean }> =>
    apiFetch(`/auth/logout`, {
      method: "POST",
      headers: { Accept: "application/json" },
    }).then<{ signed_out: boolean }>(handle),

  // ── Profile ─────────────────────────────────────────────────────────────────

  /** Every browser signed in as the owner, this one marked `current`. */
  listSessions: (): Promise<{ data: AuthSession[] }> =>
    apiFetch(`/auth/sessions`, { headers: { Accept: "application/json" } }).then<{ data: AuthSession[] }>(handle),

  /** Signs one other browser out. A 404 means it had already gone. */
  revokeSession: (id: number): Promise<{ revoked: number }> =>
    apiFetch(`/auth/sessions/${id}`, {
      method: "DELETE",
      headers: { Accept: "application/json" },
    }).then<{ revoked: number }>(handle),

  /**
   * Signs out every browser but this one. `others=1` is spelled out because the
   * server refuses a bare DELETE, so a dropped id can never mean "all of them".
   */
  revokeOtherSessions: (): Promise<{ revoked: number }> =>
    apiFetch(`/auth/sessions?others=1`, {
      method: "DELETE",
      headers: { Accept: "application/json" },
    }).then<{ revoked: number }>(handle),

  /** The latest sign-in attempts, refusals included, newest first. */
  listSignIns: (): Promise<{ data: SignInAttempt[] }> =>
    apiFetch(`/auth/sign-ins`, { headers: { Accept: "application/json" } }).then<{ data: SignInAttempt[] }>(handle),

  // ── Facts ───────────────────────────────────────────────────────────────────

  /** Everything on file, by subject, and every proposal waiting, newest first. */
  listFacts: (): Promise<FactList> =>
    apiFetch(`/facts`, { headers: { Accept: "application/json" } }).then<FactList>(handle),

  /** Put a fact on file as the owner's own word. Saying it again returns the existing row. */
  addFact: (input: { category: string; key: string; value: string }): Promise<Fact> =>
    apiFetch(`/facts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(input),
    }).then<Fact>(handle),

  /** Keep or reject a proposal. A 409 means another tab decided it first. */
  decideFact: (id: number, decision: "keep" | "reject"): Promise<Fact> =>
    apiFetch(`/facts/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ decision }),
    }).then<Fact>(handle),

  /** Forget an active fact, and its key's history with it. */
  forgetFact: (id: number): Promise<{ forgotten: number }> =>
    apiFetch(`/facts/${id}`, {
      method: "DELETE",
      headers: { Accept: "application/json" },
    }).then<{ forgotten: number }>(handle),

  // ── Automations ─────────────────────────────────────────────────────────────

  /** Every scheduled conversation, earliest in the day first. */
  listAutomations: (): Promise<{ data: Automation[] }> =>
    apiFetch(`/automations`, { headers: { Accept: "application/json" } }).then<{ data: Automation[] }>(handle),

  createAutomation: (input: AutomationInput): Promise<Automation> =>
    apiFetch(`/automations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(input),
    }).then<Automation>(handle),

  /** Any of the writable fields; the answer is the whole row. */
  updateAutomation: (id: number, patch: AutomationPatch): Promise<Automation> =>
    apiFetch(`/automations/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(patch),
    }).then<Automation>(handle),

  deleteAutomation: (id: number): Promise<void> =>
    apiFetch(`/automations/${id}`, { method: "DELETE", headers: { Accept: "application/json" } }).then<void>(handle),

  /**
   * Run one now, ignoring the once-a-day guard. It answers as soon as the job is
   * queued — the row only says what happened once a worker has run it.
   */
  runAutomation: (id: number): Promise<{ dispatched: boolean }> =>
    apiFetch(`/automations/${id}/run`, {
      method: "POST",
      headers: { Accept: "application/json" },
    }).then<{ dispatched: boolean }>(handle),

  /**
   * Whatever is due and has not run today, claimed and queued. The HUD's call on
   * load and on the tab coming back; `claimed` is the automation ids it won.
   */
  runDueAutomations: (): Promise<{ claimed: number[] }> =>
    apiFetch(`/automations/due`, {
      method: "POST",
      headers: { Accept: "application/json" },
    }).then<{ claimed: number[] }>(handle),

  // ── Agents ──────────────────────────────────────────────────────────────────

  /** Every agent, oldest first, and the closed set of groups one may own. */
  listAgents: (): Promise<AgentList> =>
    apiFetch(`/agents`, { headers: { Accept: "application/json" } }).then<AgentList>(handle),

  createAgent: (input: AgentInput): Promise<AssistantAgent> =>
    apiFetch(`/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(input),
    }).then<AssistantAgent>(handle),

  /** Any of the writable fields; a built-in agent's `capabilities` are a 422. */
  updateAgent: (id: number, patch: AgentPatch): Promise<AssistantAgent> =>
    apiFetch(`/agents/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(patch),
    }).then<AssistantAgent>(handle),

  /** A created agent only — a built-in one answers 409 with a sentence. */
  deleteAgent: (id: number): Promise<void> =>
    apiFetch(`/agents/${id}`, { method: "DELETE", headers: { Accept: "application/json" } }).then<void>(handle),

  // ── Documents ───────────────────────────────────────────────────────────────
  // Equipment's arrangement: fields as JSON, the file on its own endpoints, so
  // filing a document with a scan is two calls and a failed upload leaves the
  // record saved rather than losing the form.

  /** Every document, by kind and then title — no `per_page`, so the whole cabinet. */
  listDocuments: (): Promise<Page<FiledDocument>> =>
    apiFetch(`/documents`, { headers: { Accept: "application/json" } }).then<Page<FiledDocument>>(handle),

  createDocument: (input: DocumentInput): Promise<FiledDocument> =>
    apiFetch(`/documents`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(input),
    }).then<FiledDocument>(handle),

  /** Any of the writable fields; a date sent as null is cleared. */
  updateDocument: (id: number, patch: DocumentPatch): Promise<FiledDocument> =>
    apiFetch(`/documents/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(patch),
    }).then<FiledDocument>(handle),

  /** The row and its file together. */
  deleteDocument: (id: number): Promise<void> =>
    apiFetch(`/documents/${id}`, { method: "DELETE", headers: { Accept: "application/json" } }).then(handleVoid),

  /**
   * Replaces any file already filed. The server decides what it is from its
   * bytes — a 422 for anything but a PDF or a JPEG, PNG or WebP picture, a 413
   * over the size cap — and answers with the record and its new `file_url`.
   */
  uploadDocumentFile: async (id: number, file: File): Promise<FiledDocument> => {
    const fd = new FormData();
    fd.append("file", file);
    const res = await apiFetch(`/documents/${id}/file`, {
      method: "POST",
      headers: { Accept: "application/json" },
      body: fd,
    });
    return handle<FiledDocument>(res);
  },

  /** The file goes; the record stays. */
  deleteDocumentFile: (id: number): Promise<FiledDocument> =>
    apiFetch(`/documents/${id}/file`, {
      method: "DELETE",
      headers: { Accept: "application/json" },
    }).then<FiledDocument>(handle),

  // ── Deadlines ───────────────────────────────────────────────────────────────
  // Completing is its own route, and so is taking it back: a PATCH carries
  // fields and nothing else, so an edit can never tick a deadline off.

  /**
   * Every deadline, open and completed — no `status`, so the tab can show both
   * — open ones soonest first (overdue at the top), then completed ones most
   * recently done first. Each carries its `document`, or null.
   */
  listDeadlines: (): Promise<Page<Deadline>> =>
    apiFetch(`/deadlines`, { headers: { Accept: "application/json" } }).then<Page<Deadline>>(handle),

  createDeadline: (input: DeadlineInput): Promise<Deadline> =>
    apiFetch(`/deadlines`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(input),
    }).then<Deadline>(handle),

  /** Any of the writable fields; `document_id` or `notes` sent as null is cleared. */
  updateDeadline: (id: number, patch: DeadlinePatch): Promise<Deadline> =>
    apiFetch(`/deadlines/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(patch),
    }).then<Deadline>(handle),

  /** The row only — a linked document is untouched. */
  deleteDeadline: (id: number): Promise<void> =>
    apiFetch(`/deadlines/${id}`, { method: "DELETE", headers: { Accept: "application/json" } }).then(handleVoid),

  /** Stamps `completed_at`. Completing twice keeps the first date. */
  completeDeadline: (id: number): Promise<Deadline> =>
    apiFetch(`/deadlines/${id}/complete`, {
      method: "POST",
      headers: { Accept: "application/json" },
    }).then<Deadline>(handle),

  /** Open again — for a mis-click on Done. */
  reopenDeadline: (id: number): Promise<Deadline> =>
    apiFetch(`/deadlines/${id}/complete`, {
      method: "DELETE",
      headers: { Accept: "application/json" },
    }).then<Deadline>(handle),

  // ── News ────────────────────────────────────────────────────────────────────
  // The browser never sends a URL: a pin names an `item_id` the server handed
  // out, and the server resolves it.

  /**
   * A beat's latest, or the owner's interests (`"interests"`). No beat is the
   * server's first. Reading here marks nothing as told — that is `get_news`'s.
   */
  getNews: (beat?: string | null): Promise<NewsPage> =>
    apiFetch(`/news${beat ? `?beat=${encodeURIComponent(beat)}` : ""}`, {
      headers: { Accept: "application/json" },
    }).then<NewsPage>(handle),

  /** The reading list, unread first, and how many are unread. */
  listPins: (): Promise<PinList> =>
    apiFetch(`/news/pins`, { headers: { Accept: "application/json" } }).then<PinList>(handle),

  /** Pin a story the server is holding. Pinning twice returns the existing pin; a story held too long is a 422. */
  pinArticle: (itemId: string): Promise<PinnedArticle> =>
    apiFetch(`/news/pins`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ item_id: itemId }),
    }).then<PinnedArticle>(handle),

  /** Off the reading list, by the pin's own id. */
  unpinArticle: (pinId: number): Promise<void> =>
    apiFetch(`/news/pins/${pinId}`, { method: "DELETE", headers: { Accept: "application/json" } }).then(handleVoid),

  /** Stamps `read_at`; it moves to the read list. Marking twice keeps the first time. */
  markPinRead: (pinId: number): Promise<PinnedArticle> =>
    apiFetch(`/news/pins/${pinId}/read`, {
      method: "POST",
      headers: { Accept: "application/json" },
    }).then<PinnedArticle>(handle),

  /** Back on the unread list. */
  reopenPin: (pinId: number): Promise<PinnedArticle> =>
    apiFetch(`/news/pins/${pinId}/read`, {
      method: "DELETE",
      headers: { Accept: "application/json" },
    }).then<PinnedArticle>(handle),

  /** The topics `get_news` searches for "interests", and the limits a list is held to. */
  getNewsSettings: (): Promise<NewsSettings> =>
    apiFetch(`/settings/news`, { headers: { Accept: "application/json" } }).then<NewsSettings>(handle),

  /** The whole list, replaced — empty is allowed. Too many, or one too long, is a 422, never cut. */
  updateNewsSettings: (interests: string[]): Promise<NewsSettings> =>
    apiFetch(`/settings/news`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ interests }),
    }).then<NewsSettings>(handle),
};

/** `GET /api/settings/news`: the owner's interests, at most `max`, each at most `max_chars`. */
export type NewsSettings = { interests: string[]; max: number; max_chars: number };

/** One story as the server read it from an outlet or a search. */
export type NewsItem = {
  /** 12 hex characters — the only thing a pin may name. */
  id: string;
  title: string;
  link: string;
  source: string;
  /** An instant (ISO, UTC), or null when the outlet did not date it. */
  published_at: string | null;
  summary: string | null;
  pinned: boolean;
  /** The pin's own id, which unpinning deletes; null when not pinned. */
  pin_id: number | null;
  /** On the interests beat, which interest found it. */
  interest?: string;
};

/** What `GET /api/news` answers: one beat, and every beat there is to ask for. */
export type NewsPage = {
  beat: string;
  label: string;
  query?: string | null;
  /** On the interests beat, the interests searched — empty when none are set. */
  searched?: string[];
  items: NewsItem[];
  /** Outlets that could not be read — their stories are missing, not absent. */
  unreachable: { source: string; message: string }[];
  /** Config order, then `interests`. */
  beats: { key: string; label: string }[];
};

/** A story on the reading list — a snapshot, so it outlives the feed it came from. */
export type PinnedArticle = {
  id: number;
  item_id: string;
  title: string;
  source: string;
  link: string;
  summary: string | null;
  published_at: string | null;
  read_at: string | null;
  created_at: string | null;
  updated_at: string | null;
};

export type PinList = { data: PinnedArticle[]; unread: number };

/**
 * What the form offers for a document's `kind` — `Document::KINDS`. A
 * vocabulary, not a constraint: the column is free text, so a row may hold a
 * kind that is not here, and the picker appends it rather than losing it.
 */
export const DOCUMENT_KINDS = [
  "passport",
  "visa",
  "policy",
  "contract",
  "receipt",
  "invoice",
  "certificate",
  "licence",
  "statement",
  "form",
  "other",
] as const;

/** What the server accepts as a file — `DocumentStore::MEDIA_TYPES`. */
export const DOCUMENT_MEDIA_TYPES = ["application/pdf", "image/jpeg", "image/png", "image/webp"] as const;

/** One filed artifact — a passport, a policy, a receipt. */
export type FiledDocument = {
  id: number;
  title: string;
  kind: string;
  /** Bare local dates, `YYYY-MM-DD` — a passport expires on a day, not at an instant. */
  issued_on: string | null;
  expires_on: string | null;
  notes: string | null;
  /** Null until a file is uploaded, as are the two after it. */
  mime: string | null;
  size_bytes: number | null;
  /** Signed, so an `<a>` or a new tab can open it without the bearer token. */
  file_url: string | null;
  created_at: string;
  updated_at: string;
};

export type DocumentInput = {
  title: string;
  kind: string;
  issued_on?: string | null;
  expires_on?: string | null;
  notes?: string | null;
};

export type DocumentPatch = Partial<DocumentInput>;

/** What the form offers for a deadline's `kind` — `Deadline::KINDS`. A vocabulary, as `DOCUMENT_KINDS` is. */
export const DEADLINE_KINDS = ["renewal", "filing", "payment", "application", "submission", "other"] as const;

/** A date somebody must act on — renew the visa, file the return, pay the premium. */
export type Deadline = {
  id: number;
  title: string;
  /**
   * A bare local date, `YYYY-MM-DD`. The API sends no `overdue`: whether it has
   * passed is read off this browser's clock, the calendar's rule.
   */
  due_on: string;
  kind: string;
  document_id: number | null;
  /** The document it is about, loaded — null when there is none, or it was deleted. */
  document: FiledDocument | null;
  notes: string | null;
  /** An instant (ISO, UTC), null while open. */
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type DeadlineInput = {
  title: string;
  due_on: string;
  kind: string;
  document_id?: number | null;
  notes?: string | null;
};

export type DeadlinePatch = Partial<DeadlineInput>;

/** What `AutomationRunner` can fetch for the first turn — `Automation::CONTEXT`. */
export const AUTOMATION_CONTEXT = ["agenda", "weather", "training", "deadlines", "facts", "news"] as const;

export type AutomationContext = (typeof AUTOMATION_CONTEXT)[number];

/** A scheduled conversation — "Morning greeting", 06:30, agenda + weather + training. */
export type Automation = {
  id: number;
  name: string;
  /** 24-hour `HH:MM`, on the server's `AGENT_TIMEZONE`. */
  time: string;
  /** What it is for, in the owner's words. Never sent to the model raw. */
  intent: string;
  context: AutomationContext[];
  enabled: boolean;
  /** The day it last fired, on that same clock — the once-a-day guard. */
  last_run_on: string | null;
  last_run_at: string | null;
  last_outcome: "ok" | "failed" | "skipped" | null;
  last_error: string | null;
  /** The thread the last run opened, when it got that far. */
  last_conversation_id: number | null;
};

export type AutomationInput = {
  name: string;
  time: string;
  intent: string;
  context: AutomationContext[];
  enabled?: boolean;
};

export type AutomationPatch = Partial<AutomationInput>;

/**
 * A kind of work the assistant does — "Fitness coach", the training log.
 * `AssistantAgent` on this side, because the app already has an agent — the
 * ElevenLabs one behind `useAgentSession` — and a bare `Agent` would be read as it.
 */
export type AssistantAgent = {
  id: number;
  name: string;
  /** What it is for, in the owner's words. Goes into the prompt. */
  purpose: string;
  /** `CapabilityGroup` values, never `core`. */
  capabilities: string[];
  enabled: boolean;
  /** Built in: its groups are fixed and it cannot be deleted. */
  seeded: boolean;
  /** What it is held to: the owner's rewording, else `default_guardrail`. */
  guardrail: string | null;
  /** The rules of the groups it owns — what a blank guardrail comes back to. */
  default_guardrail: string | null;
  /** What it being off takes away right now; empty when on, or when another agent holds them. */
  withholds: string[];
  created_at: string | null;
};

/** One group an agent may own, as the server names it — `CapabilityGroup::label()`. */
export type CapabilityGroup = {
  value: string;
  label: string;
  /** The default rule for any agent that owns it; null where there is none. */
  guardrail: string | null;
  /** The tools it holds on this machine right now; empty when none are registered. */
  tools: string[];
};

export type AgentList = { data: AssistantAgent[]; groups: CapabilityGroup[] };

export type AgentInput = {
  name: string;
  purpose: string;
  capabilities: string[];
  /** Blank or null is the default for its groups — never "no rule". */
  guardrail?: string | null;
  enabled?: boolean;
};

export type AgentPatch = Partial<AgentInput>;

/** One claim about the owner — "food / coffee: Black, no sugar." */
export type Fact = {
  id: number;
  category: string;
  key: string;
  value: string;
  /** `stated` is the owner's word; `inferred` is the assistant's reading of it. */
  confidence: "stated" | "inferred";
  source: "chat" | "voice" | "manual" | "extracted";
  status: "proposed" | "active" | "superseded" | "rejected";
  conversation_id: number | null;
  learned_at: string | null;
  decided_at: string | null;
};

export type FactList = {
  active: Fact[];
  /** `replaces` is the value on file for the same key, when there is one. */
  proposed: (Fact & { replaces: string | null })[];
};

/** A browser holding one of the owner's tokens. */
export type AuthSession = {
  id: number;
  /** The device label read off the user agent when the token was minted. */
  name: string;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string | null;
  last_used_at: string | null;
  expires_at: string | null;
  current: boolean;
};

/** One try at signing in, whoever made it. */
export type SignInAttempt = {
  id: number;
  email: string | null;
  outcome: "ok" | "refused" | "failed";
  reason: string | null;
  ip: string | null;
  user_agent: string | null;
  created_at: string | null;
};
