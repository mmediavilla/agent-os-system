import { RunEvent, api } from "./api";

/**
 * Following a queued run until it stops.
 *
 * Two transports for one event log, and the choice between them is not a
 * quality setting. A browser has `EventSource` and gets events as they happen;
 * React Native has no `EventSource` and cannot read a streaming fetch body at
 * all, so it asks for the tail of the same log on a timer. The server serves
 * both from the same indexed table, so polling is the *baseline* here rather
 * than a degraded mode — which is what keeps it working.
 *
 * Everything this delivers is a duplicate of something already in the
 * transcript, so every failure here degrades to "the screen is quiet until the
 * run finishes and the thread is re-read". That is why a dropped stream falls
 * back rather than surfacing, and why an unreadable event is skipped rather
 * than thrown.
 */

/** Named so a browser can attach one listener per kind, as SSE intends. */
const EVENT_TYPES = [
  "run.started",
  "thinking",
  "text",
  "tool.started",
  "tool.finished",
  "awaiting",
  "run.finished",
];

/** How often a polling client asks for the tail of the log. */
const POLL_MS = 700;

/**
 * Consecutive stream errors tolerated before giving up on it.
 *
 * A single one is normal and expected: the server caps the response and the
 * browser reconnects by itself, carrying `Last-Event-ID`. Several in a row with
 * no event between them means the stream is not arriving — buffered by a proxy,
 * or blocked — and polling is the thing that will work.
 */
const STREAM_ERRORS_BEFORE_POLLING = 3;

export type RunWatch = { stop: () => void };

export type WatchOptions = {
  /** The highest `seq` already folded in, so a re-attached watcher does not replay. */
  after?: number;
  /**
   * The run's signed `stream_url`, as the server gave it.
   *
   * `EventSource` cannot send the bearer token, so the stream is reached only
   * through the URL the server signed; without one the watcher polls, which
   * goes through `apiFetch` like everything else.
   */
  streamUrl?: string | null;
  onEvents: (events: RunEvent[]) => void;
  /** The run reached a terminal state, or watching it became impossible. */
  onDone: () => void;
};

export function watchRun(runId: string, options: WatchOptions): RunWatch {
  let stopped = false;
  let after = options.after ?? 0;
  let source: any = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const stop = () => {
    stopped = true;
    source?.close?.();
    source = null;
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const finish = () => {
    if (stopped) return;
    stop();
    options.onDone();
  };

  const take = (events: RunEvent[]) => {
    if (stopped || events.length === 0) return;

    for (const event of events) {
      if (event.seq > after) after = event.seq;
    }

    options.onEvents(events);

    if (events.some((e) => e.type === "run.finished")) finish();
  };

  // ── polling ────────────────────────────────────────────────────────────────

  const poll = async () => {
    if (stopped) return;

    try {
      const update = await api.getRun(runId, after);
      if (stopped) return;

      take(update.events);
      if (stopped) return;

      // A run that has finished without a closing event — a worker killed
      // mid-loop — would otherwise be polled forever.
      if (update.run.finished) {
        finish();

        return;
      }
    } catch {
      // The run is gone, or the server is. Either way there is nothing further
      // to watch, and the screen re-reads the thread on the way out.
      finish();

      return;
    }

    timer = setTimeout(poll, POLL_MS);
  };

  const startPolling = () => {
    if (stopped) return;
    source?.close?.();
    source = null;
    poll();
  };

  // ── streaming ──────────────────────────────────────────────────────────────

  const startStreaming = (Source: any, url: string) => {
    let errors = 0;

    // The signature covers everything but `after` (`signed:after` on the
    // server), so resuming is an appended parameter; reconnects resume by
    // `Last-Event-ID` on their own.
    source = new Source(after ? `${url}${url.includes("?") ? "&" : "?"}after=${after}` : url);

    const onMessage = (message: any) => {
      errors = 0;

      let event: RunEvent | null = null;

      try {
        event = JSON.parse(message.data);
      } catch {
        // A half-written frame. The next one carries a higher `seq`, and a
        // reconnect would ask for this one again anyway.
        return;
      }

      if (event && typeof event.seq === "number") take([event]);
    };

    for (const type of EVENT_TYPES) source.addEventListener(type, onMessage);

    source.onerror = () => {
      if (stopped) return;

      errors += 1;

      // `CLOSED` means the browser has given up reconnecting; anything else is
      // the ordinary end of a capped response, which it retries by itself.
      const closed = source?.readyState === 2;

      if (closed || errors >= STREAM_ERRORS_BEFORE_POLLING) startPolling();
    };
  };

  const Source = (globalThis as any).EventSource;

  if (typeof Source === "function" && options.streamUrl) startStreaming(Source, options.streamUrl);
  else startPolling();

  return { stop };
}
