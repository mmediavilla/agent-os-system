import { Gauge } from "./api";

/**
 * Turning the telemetry into the short strings the HUD's panels have room for.
 *
 * Pure, and in their own file, because this is where a HUD actually goes wrong:
 * every one of these has a boundary that only shows up on a real machine at an
 * awkward moment — a 999-second sample age, a disk in terabytes, a heartbeat
 * that has never happened. None of them is worth discovering by looking at the
 * screen at the moment it matters.
 *
 * The size unit is decided **once per gauge**, from the total rather than from
 * each number, so "19.8 / 32 GB" reads as one measurement instead of two. That
 * is the whole reason `gauge()` exists rather than two calls to `bytes()`.
 */

const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

/** Which power of 1024 a number should be shown in. */
function scaleOf(bytes: number): number {
  if (bytes <= 0) return 0;
  return Math.min(UNITS.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
}

/**
 * A size, at a given power of 1024.
 *
 * Whole numbers past a hundred: "1023 MB" is easier to place at a glance than
 * "1023.4 MB", and the extra digit is never the thing being read.
 */
function sized(value: number, at: number): string {
  const size = value / 1024 ** at;

  return String(size >= 100 ? Math.round(size) : Number(size.toFixed(1)));
}

export function bytes(value: number | null | undefined, scale?: number): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";

  const at = scale ?? scaleOf(value);

  return `${sized(value, at)} ${UNITS[at]}`;
}

/** "19.8 / 32 GB" — both sides in the unit the total picked, and one unit shown. */
export function gauge(g: Gauge | null | undefined): string {
  if (!g) return "—";

  const at = scaleOf(g.total_bytes);

  return `${sized(g.used_bytes, at)} / ${sized(g.total_bytes, at)} ${UNITS[at]}`;
}

/**
 * How old a reading is, in the fewest characters that are still true.
 *
 * Null is "never", not "0s". The machine sample is taken on a queue worker, so
 * before the first one lands there is genuinely nothing to age — and reading
 * that as "just now" would be the one wrong answer.
 */
export function age(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "never";
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

/**
 * Whether a sample is old enough to say so on the panel.
 *
 * The endpoint asks for a new one every ten seconds, so anything past a minute
 * means nothing is servicing the queue — which is the signal, and the reason
 * the gauges keep their last value rather than blanking.
 */
export function isStale(seconds: number | null | undefined): boolean {
  return seconds === null || seconds === undefined || seconds > 60;
}

/** A count with thousands separators — "1,204,551" rather than a wall of digits. */
export function count(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value) ? "—" : value.toLocaleString("en-US");
}

/**
 * US dollars to the cent. A non-zero amount under half a cent reads "<$0.01"
 * rather than "$0.00", which would claim nothing was spent.
 */
export function usd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (value > 0 && value < 0.005) return "<$0.01";
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Degrees, with the degree sign and no decimal — a HUD has no room for 28.6°. */
export function degrees(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : `${Math.round(value)}°`;
}

export function percent(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : `${Math.round(value)}%`;
}
