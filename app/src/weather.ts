import { WeatherDay, WeatherHour } from "./api";
import * as cal from "./calendar";

/**
 * The weather card's rules, as pure functions — the same split `calendar.ts`
 * makes for the agenda.
 *
 * **The forecast's times are wall clock**, on the user's zone, exactly like the
 * calendar's: the server asks Open-Meteo for the day in Manila rather than in
 * UTC, because its daily rows are bucketed on the zone they are asked for. So
 * every time here goes through `calendar.parse`, which reads the digits.
 */

/** Which drawing a condition gets. Seven, because the icon is 18px. */
export type WeatherKind = "clear" | "partly" | "cloud" | "fog" | "rain" | "snow" | "storm";

/**
 * A WMO code as one of the seven drawings.
 *
 * Grouped the way the server groups the words, and for the same reason: at
 * this size "freezing drizzle" and "light rain" are the same picture. No code
 * is a cloud — the honest picture of not knowing, where a sun would be a claim.
 */
export function weatherKind(code: number | null | undefined): WeatherKind {
  if (code === null || code === undefined) return "cloud";
  if (code <= 1) return "clear";
  if (code === 2) return "partly";
  if (code === 3) return "cloud";
  if (code === 45 || code === 48) return "fog";
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return "rain";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  if (code >= 95) return "storm";

  return "cloud";
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The top of the hour in progress, as the wire writes it. */
function hourStart(now: Date): string {
  return `${cal.localDate(now)}T${pad(now.getHours())}:00`;
}

/**
 * The card's strip: every `step`th hour from the one in progress.
 *
 * Filtered here as well as on the server, because the server's list is as old
 * as its ten-minute cache and the card is polled every ten minutes on top of
 * that — without it, a strip read at 15:05 could open on 14:00.
 */
export function strip(hours: WeatherHour[], now: Date = new Date(), step = 3, count = 6): WeatherHour[] {
  const from = hourStart(now);

  return hours
    .filter((h) => h.time.slice(0, 16) >= from)
    .filter((_, i) => i % step === 0)
    .slice(0, count);
}

/** "15:00" from a wall-clock time, or "—". */
export function clock(time: string | null | undefined): string {
  const at = cal.parse(time);

  return at ? cal.localTime(at) : "—";
}

/** A day row's name: Today, Tmrw, then the weekday — a week needs no dates. */
export function dayName(date: string, now: Date = new Date()): string {
  const today = cal.localDate(now);

  if (date === today) return "Today";
  if (date === cal.shiftDate(today, 1)) return "Tmrw";

  const at = cal.parse(date);

  return at ? at.toLocaleDateString(undefined, { weekday: "short" }) : "—";
}

/** The week from today, dropping a day the server's cache still holds from yesterday. */
export function week(days: WeatherDay[], now: Date = new Date()): WeatherDay[] {
  const today = cal.localDate(now);

  return days.filter((d) => d.date >= today);
}
