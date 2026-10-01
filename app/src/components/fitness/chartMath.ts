/**
 * Pure helpers behind the Fitness dashboard charts.
 *
 * Everything here is deliberately free of React and of `Intl`, so the panels can
 * be tested without a renderer and render identically regardless of the viewer's
 * locale and timezone.
 */

import { WeightUnit, fromCanonical } from "../../units";

export const DAY_MS = 86_400_000;

const MONTH_ABBR = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

const MONTH_FULL = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

const WEEKDAY_ABBR = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/**
 * "2026-01-02" → an integer day number.
 *
 * All grid arithmetic goes through this rather than `new Date(iso)` plus local
 * getters: an ISO date string parses as UTC midnight, and reading it back with
 * local accessors shifts the day backwards anywhere west of Greenwich. That bug
 * shows up as an entire heatmap column being off by one, intermittently, by
 * viewer timezone.
 */
export function toDayNum(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / DAY_MS;
}

export function fromDayNum(n: number): {
  y: number;
  m: number;
  d: number;
  iso: string;
  /** 0 = Sunday … 6 = Saturday. */
  dow: number;
} {
  const dt = new Date(n * DAY_MS);
  const y = dt.getUTCFullYear();
  const m = dt.getUTCMonth() + 1;
  const d = dt.getUTCDate();
  return {
    y,
    m,
    d,
    iso: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
    dow: dt.getUTCDay(),
  };
}

/** "Mon 2 January 2026" — for heatmap cell screen-reader labels. */
export function longDate(iso: string): string {
  const { y, m, d, dow } = fromDayNum(toDayNum(iso));
  return `${WEEKDAY_ABBR[dow]} ${d} ${MONTH_FULL[m - 1]} ${y}`;
}

/** "2 Jan" — for compact axis labels. */
export function shortDate(iso: string): string {
  const { m, d } = fromDayNum(toDayNum(iso));
  return `${d} ${MONTH_ABBR[m - 1]}`;
}

/**
 * Month labels for the heatmap's header strip, as column indices.
 *
 * A label is emitted at the first column of a new month that also clears
 * `minGap` columns of the last label placed — at a 14px pitch "Jan" is wider
 * than one column, so unspaced labels smear into each other.
 *
 * A month that starts too close to the previous label is *deferred*, not
 * dropped: the comparison is against the last month actually labelled, so the
 * label reappears a column or two later rather than the month vanishing from
 * the axis entirely.
 */
export function monthTicks(
  startDayNum: number,
  cols: number,
  minGap = 3,
): { col: number; label: string }[] {
  const out: { col: number; label: string }[] = [];
  let labelledMonth = -1;
  let lastCol = -Infinity;

  for (let col = 0; col < cols; col++) {
    const { m } = fromDayNum(startDayNum + col * 7);
    if (m !== labelledMonth && col - lastCol >= minGap) {
      out.push({ col, label: MONTH_ABBR[m - 1] });
      lastCol = col;
      labelledMonth = m;
    }
  }
  return out;
}

/**
 * Heatmap intensity thresholds, in hard sets per day.
 *
 * Fixed steps rather than quantiles of the visible window: quantiles would
 * recolour the *same session* when you switched from 4w to 1y, which reads as a
 * bug rather than as information. Calibrated so a typical ~20-set session lands
 * at level 3.
 */
export const HEATMAP_STEPS = [1, 10, 18, 26] as const;

export type HeatLevel = 0 | 1 | 2 | 3 | 4;

export function heatLevel(hardSets: number): HeatLevel {
  if (hardSets < HEATMAP_STEPS[0]) return 0;
  if (hardSets < HEATMAP_STEPS[1]) return 1;
  if (hardSets < HEATMAP_STEPS[2]) return 2;
  if (hardSets < HEATMAP_STEPS[3]) return 3;
  return 4;
}

/**
 * A bar's height as a percentage of its track.
 *
 * `minVisible` keeps a small-but-nonzero value from rendering as a hairline the
 * eye reads as nothing; a genuine zero still renders as nothing, which is how
 * an untrained week stays visibly empty.
 */
export function barPct(value: number, max: number, minVisible = 2): number {
  if (max <= 0 || value <= 0) return 0;
  return Math.max((value / max) * 100, minVisible);
}

/**
 * Padded bounds for a suppressed-zero axis.
 *
 * A 120 → 145kg strength trend plotted from zero looks flat, so the strength
 * panel scales to the data instead. Because that is a truncated axis, the panel
 * has to label the endpoints numerically — see StrengthProgression.
 */
export function baselineRange(values: number[]): { lo: number; hi: number } {
  if (values.length === 0) return { lo: 0, hi: 1 };
  return { lo: Math.min(...values) * 0.92, hi: Math.max(...values) * 1.02 };
}

/** Position within a suppressed-zero range, as a percentage height. */
export function scaledPct(value: number, lo: number, hi: number, minVisible = 6): number {
  // A lift with an identical estimate every session has no range to scale
  // against; sitting it mid-track beats dividing by zero.
  if (hi <= lo) return 50;
  return Math.max(((value - lo) / (hi - lo)) * 100, minVisible);
}

/** Tonnage runs to six figures fast, so large numbers switch to tonnes. */
export function fmtKg(kg: number): string {
  if (kg >= 10000) return `${(kg / 1000).toFixed(1)}t`;
  if (kg >= 1000) return `${Math.round(kg).toLocaleString("en-US")}kg`;
  return `${Math.round(kg)}kg`;
}

/** The same, in pounds. Split out so `fmtWeight` stays a one-line dispatch. */
function fmtLb(lb: number): string {
  // No customary unit between the pound and the ton is worth reaching for, so
  // big numbers compact with an SI prefix instead of changing unit as kg does.
  // A year of lifting clears a million pounds, and "1525.7klb" is unreadable.
  if (lb >= 1_000_000) return `${(lb / 1_000_000).toFixed(1)}Mlb`;
  if (lb >= 10_000) return `${(lb / 1000).toFixed(1)}klb`;
  if (lb >= 1000) return `${Math.round(lb).toLocaleString("en-US")}lb`;
  return `${Math.round(lb)}lb`;
}

/** A stored (kilogram) load, formatted in whichever weight unit is in use. */
export function fmtWeight(kg: number, unit: WeightUnit = "kg"): string {
  return unit === "kg" ? fmtKg(kg) : fmtLb(fromCanonical(kg, "lb"));
}

export function fmtCount(n: number): string {
  return n.toLocaleString("en-US");
}
