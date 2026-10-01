import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "./api";

/**
 * Read something on a timer, and stop the moment nobody is looking.
 *
 * The HUD is the first screen in this app that keeps asking. Every other one
 * fetches on arrival and again on re-entry (`useRefreshOnActivate`), which needs
 * no timer at all — a catalog does not change while you read it. A heads-up
 * display is the opposite: its whole claim is that the numbers on it are true
 * *now*, and the premise of the phase is that it is left open all day.
 *
 * Two things therefore have to be true, and neither is optional.
 *
 * **It stops when the screen is not the active one.** Screens here are hidden,
 * not unmounted, so a poller that keyed off mounting would keep running against
 * a HUD nobody has looked at since breakfast.
 *
 * **It stops when the tab is hidden.** Browsers throttle background timers
 * rather than stopping them, so without this the app quietly issues requests
 * from every tab it was ever opened in. Coming back visible refetches
 * immediately instead of waiting out the rest of the interval, because the
 * first thing a returning eye lands on is the thing that is now stale.
 *
 * `latencyMs` is measured here rather than reported by the server, and that is
 * the honest place for it: what the services panel means by "the API is
 * answering in 42ms" is the round trip this client saw, which is the number
 * that includes everything actually between them.
 */
export type Polled<T> = {
  data: T | null;
  error: string | null;
  /** True until the first answer of any kind arrives. */
  loading: boolean;
  /** Round trip of the most recent successful read, in milliseconds. */
  latencyMs: number | null;
  /** Read again now, outside the schedule. */
  refresh: () => void;
};

export function usePolled<T>(
  fetcher: () => Promise<T>,
  { intervalMs, active = true }: { intervalMs: number; active?: boolean },
): Polled<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);

  // The fetcher is almost always an arrow written inline in the caller's
  // render, so it is a new function every time. Holding it in a ref is what
  // keeps that from restarting the timer sixty times a second.
  const call = useRef(fetcher);
  call.current = fetcher;

  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const read = useCallback(async () => {
    const started = Date.now();

    try {
      const next = await call.current();
      if (!live.current) return;
      setData(next);
      setLatencyMs(Date.now() - started);
      setError(null);
    } catch (e) {
      if (!live.current) return;
      // The last good reading is kept. A panel that blanks on one dropped
      // request flickers its way through a wifi hiccup; one that keeps the
      // number and says it could not refresh does not.
      setError(errorMessage(e));
    } finally {
      if (live.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!active) return;

    if (visible()) read();

    const timer = setInterval(() => {
      if (visible()) read();
    }, intervalMs);

    // Not "resume the schedule" — read now. The interval carries on from
    // wherever it was, and the point of the listener is the reading, not the
    // timing.
    const onVisible = () => {
      if (visible()) read();
    };
    document.addEventListener?.("visibilitychange", onVisible);

    return () => {
      clearInterval(timer);
      document.removeEventListener?.("visibilitychange", onVisible);
    };
  }, [active, intervalMs, read]);

  return { data, error, loading, latencyMs, refresh: read };
}

/**
 * Whether this tab is on screen.
 *
 * Anything other than an explicit "hidden" counts as visible, including a
 * document that has no `visibilityState` at all — a poller that decided it was
 * hidden because it could not tell would simply never run.
 */
export function visible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

/**
 * A clock that is actually a clock.
 *
 * The chrome bar's, first: it was rendered once per mount, on the grounds that
 * a ticking one needed a visibility-aware interval and the app did not have the
 * idea of one. `visible()` is that idea, so this ticks only while someone can
 * see it and catches up the moment they can again — a tab left open overnight
 * does not insist it is still yesterday evening.
 *
 * The agenda panel reads it too, and needs it more: "in 40m" and "has this
 * finished?" are both questions about *now*, and the calendar poll only comes
 * round every two minutes.
 *
 * Half a minute, for displays whose finest unit is the minute: a full minute
 * makes the change land up to 59 seconds late, and anything faster is a render
 * that changes nothing.
 */
export function useNow(intervalMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const tick = () => {
      if (visible()) setNow(new Date());
    };

    const timer = setInterval(tick, intervalMs);
    document.addEventListener?.("visibilitychange", tick);

    return () => {
      clearInterval(timer);
      document.removeEventListener?.("visibilitychange", tick);
    };
  }, [intervalMs]);

  return now;
}
