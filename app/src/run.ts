import { RunEvent, RunStatus } from "./api";

/**
 * A run in progress, folded out of the events it has emitted.
 *
 * The transcript is the truth and this is not: everything here is a duplicate
 * of something the server is writing to `conversation_messages` as it goes, and
 * when the run finishes the screen throws all of it away and re-reads the
 * thread. What it buys is the fifteen seconds in between, which used to be a
 * spinner.
 *
 * So the shape deliberately **mirrors `chatItems`**. A live run draws the same
 * way a finished one does — prose, then the tools it called, then more prose —
 * which is what stops the answer from jumping around the screen at the moment
 * the real transcript replaces the preview.
 *
 * Pure, and separate from the watcher that feeds it, because the interesting
 * part is the folding and the interesting part must be testable without a
 * server, a socket or a timer.
 */

/** How a call is going. A parked write is `waiting`, not `running`. */
export type LiveToolState = "running" | "waiting" | "done" | "failed";

export type LiveTool = {
  useId: string;
  name: string;
  input: Record<string, unknown>;
  state: LiveToolState;
};

export type LiveItem =
  | { kind: "said"; text: string }
  | { kind: "tools"; calls: LiveTool[] };

export type LiveRun = {
  status: RunStatus;
  /** What the run has produced so far, oldest first. */
  items: LiveItem[];
  /**
   * The model's summarised reasoning for the turn it is on.
   *
   * Cleared the moment that turn starts answering: reasoning is worth reading
   * while it is the only thing happening and is noise beside the answer it
   * produced. A later turn thinking again refills it.
   */
  thinking: string;
  error: string | null;
  /** The highest `seq` folded in — where a reconnecting watcher resumes from. */
  seq: number;
};

export function emptyRun(status: RunStatus = "queued"): LiveRun {
  return { status, items: [], thinking: "", error: null, seq: 0 };
}

/** Whether anything is still expected to happen. */
export function isRunning(status: RunStatus): boolean {
  return status === "queued" || status === "running";
}

/**
 * Fold a batch of events onto a run.
 *
 * Returns a new object every time — the caller is React state — and ignores
 * anything at or below the sequence already folded in, so a reconnect that
 * replays an event does not print it twice.
 */
export function applyRunEvents(state: LiveRun, events: RunEvent[]): LiveRun {
  let next = state;

  for (const event of events) {
    if (event.seq <= next.seq) continue;
    next = apply(next, event);
  }

  return next;
}

function apply(state: LiveRun, event: RunEvent): LiveRun {
  const seq = event.seq;
  const data = event.data ?? {};

  switch (event.type) {
    case "run.started":
      // A fresh page for the run, not for each turn. Anything already here
      // belongs to a previous run in the same thread and is now in the
      // transcript proper.
      return { ...emptyRun("running"), seq };

    case "thinking":
      return { ...state, seq, status: "running", thinking: state.thinking + text(data.delta) };

    case "text":
      return {
        ...state,
        seq,
        status: "running",
        thinking: "",
        items: appendText(state.items, text(data.delta)),
      };

    case "tool.started":
      return {
        ...state,
        seq,
        status: "running",
        thinking: "",
        items: appendTool(state.items, {
          useId: text(data.tool_use_id),
          name: text(data.tool),
          input: (data.input ?? {}) as Record<string, unknown>,
          // A write is not running, it is about to be asked about. Showing it
          // as in-flight beside its own approval card says the opposite of
          // what the card is asking.
          state: data.requires_confirmation === true ? "waiting" : "running",
        }),
      };

    case "tool.finished":
      return {
        ...state,
        seq,
        items: settleTool(state.items, text(data.tool_use_id), data.is_error === true ? "failed" : "done"),
      };

    case "awaiting":
      return { ...state, seq, status: "awaiting_confirmation", thinking: "" };

    case "run.finished":
      return {
        ...state,
        seq,
        thinking: "",
        status: (text(data.status) || "completed") as RunStatus,
        error: typeof data.error === "string" ? data.error : null,
      };

    default:
      // An event type added to the server after this was written. Its `seq` is
      // still consumed, so a resume does not ask for it again.
      return { ...state, seq };
  }
}

/** Text runs are contiguous: a delta extends the last one unless a tool broke it. */
function appendText(items: LiveItem[], delta: string): LiveItem[] {
  if (delta === "") return items;

  const last = items[items.length - 1];

  if (last && last.kind === "said") {
    return [...items.slice(0, -1), { kind: "said", text: last.text + delta }];
  }

  return [...items, { kind: "said", text: delta }];
}

/** So do tool runs: two calls in one turn are one row of chips, not two. */
function appendTool(items: LiveItem[], call: LiveTool): LiveItem[] {
  const last = items[items.length - 1];

  if (last && last.kind === "tools") {
    return [...items.slice(0, -1), { kind: "tools", calls: [...last.calls, call] }];
  }

  return [...items, { kind: "tools", calls: [call] }];
}

function settleTool(items: LiveItem[], useId: string, state: LiveToolState): LiveItem[] {
  return items.map((item) =>
    item.kind === "tools"
      ? { kind: "tools", calls: item.calls.map((c) => (c.useId === useId ? { ...c, state } : c)) }
      : item,
  );
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
