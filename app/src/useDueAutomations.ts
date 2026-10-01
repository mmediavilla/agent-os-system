import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { visible } from "./polling";

/**
 * The HUD's half of an automation: asking for whatever is due, and noticing
 * when it arrives.
 *
 * **Delivery is the first load past the hour, not a cron tick.** A greeting
 * written at 06:30 by a worker and found at 09:00 is a message timestamped
 * before anyone sat down — so nothing is written until the HUD asks. It asks
 * on arrival and each time the tab comes back, because those are the two
 * moments somebody has just started looking at it.
 *
 * **The claim is the server's, not this hook's.** `POST /automations/due`
 * claims each due row with a conditional update before it dispatches anything,
 * so two tabs open at once cannot both fire one greeting, and asking twice in a
 * minute is free. What comes back is the ids it won.
 *
 * **A claim is not a delivery.** The run is assembled and queued on a worker —
 * the agenda and the weather are fetched there, which has no business happening
 * inside this request — so the conversation does not exist yet when the claim
 * answers. This watches the rows until their run lands, then hands the
 * conversation id up. Bounded both ways: it stops the moment every claim has
 * resolved, and gives up after `TRIES` polls, so a dead queue worker costs a
 * handful of cheap reads rather than a loop all day.
 *
 * **A failure here is silent.** A greeting nobody asked for that could not be
 * asked for is not something to put on the HUD; the row's own outcome is in the
 * Automations overlay, which is where the question "why didn't it run?" is
 * asked. What this must never do is invent a delivery.
 */
export function useDueAutomations({
  active,
  onDelivered,
}: {
  active: boolean;
  /**
   * A run has landed and opened this thread. Called once per delivery.
   *
   * The row's `name` comes with it because the HUD has nothing else to call the
   * delivery by: an automation is any scheduled conversation, so "Morning
   * greeting" is a value in the database rather than a word to hardcode on a card.
   */
  onDelivered: (conversationId: number, name: string) => void;
}) {
  // Each claimed row, with the instant its claim answered — the baseline that
  // tells this run's `last_run_at` from the one it did yesterday.
  const [claims, setClaims] = useState<{ id: number; from: number }[]>([]);
  // One ask at a time: the arrival and a visibility change can land together.
  const asking = useRef(false);

  // Read through a ref so a new callback each render does not restart the
  // watcher — the HUD rebuilds its handlers on every poll.
  const deliver = useRef(onDelivered);
  useEffect(() => {
    deliver.current = onDelivered;
  });

  const ask = useCallback(async () => {
    if (asking.current) return;
    asking.current = true;

    const from = Date.now();

    try {
      const { claimed } = await api.runDueAutomations();
      if (claimed.length > 0) {
        setClaims((prev) => [...prev, ...claimed.filter((id) => !prev.some((c) => c.id === id)).map((id) => ({ id, from }))]);
      }
    } catch {
      // See above: silence is the answer.
    } finally {
      asking.current = false;
    }
  }, []);

  useEffect(() => {
    if (!active) return;

    if (visible()) ask();

    const onVisible = () => {
      if (visible()) ask();
    };

    document.addEventListener?.("visibilitychange", onVisible);

    return () => document.removeEventListener?.("visibilitychange", onVisible);
  }, [active, ask]);

  useEffect(() => {
    if (claims.length === 0) return;

    let tries = 0;

    const collect = async () => {
      if (!visible()) return;

      if (++tries > TRIES) {
        setClaims([]);

        return;
      }

      let rows;
      try {
        rows = (await api.listAutomations()).data;
      } catch {
        return;
      }

      const waiting: { id: number; from: number }[] = [];

      for (const claim of claims) {
        const row = rows.find((r) => r.id === claim.id);

        // Deleted while we waited: there is nothing left to wait for.
        if (!row) continue;

        const ran = row.last_run_at === null ? null : Date.parse(row.last_run_at);

        if (ran === null || Number.isNaN(ran) || ran < claim.from - SKEW_MS) {
          waiting.push(claim);

          continue;
        }

        // Landed. Only `ok` opened a thread; `failed` and `skipped` say so on
        // the row, which is where that question belongs.
        if (row.last_outcome === "ok" && row.last_conversation_id !== null) {
          deliver.current(row.last_conversation_id, row.name);
        }
      }

      setClaims((prev) => (prev.length === waiting.length ? prev : waiting));
    };

    const timer = setInterval(collect, POLL_MS);

    return () => clearInterval(timer);
  }, [claims]);
}

/** How often a claimed row is re-read while its run is out, and how many times at most. */
const POLL_MS = 4_000;
const TRIES = 20;

/**
 * How far before the claim a `last_run_at` may sit and still count as this run.
 *
 * The server and the browser are the same machine (`projectmc.test` is Herd-only
 * DNS), so the two clocks are one clock; this is for the millisecond either way
 * that rounding and the round trip can produce, not for a real skew.
 */
const SKEW_MS = 2_000;
