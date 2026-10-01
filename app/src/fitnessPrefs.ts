/**
 * Fitness preferences that belong to this browser: how the Fitness screens
 * open, not what the server computes.
 *
 * Kept beside `units.ts` and built the same way — free of React, validated field
 * by field on the way out of storage — because they are the same kind of thing:
 * a choice about what this screen shows, which nothing without a browser needs
 * to see. A setting the worker must read (the morning nudge) is a database row
 * instead.
 */

import type { RangeKey } from "./api";

export type StatsRange = RangeKey | "auto";

/** In the order Fitness → Settings lists them. */
export const STATS_RANGES: readonly StatsRange[] = ["auto", "4w", "12w", "1y", "all"];

export const STATS_RANGE_LABELS: Record<StatsRange, string> = {
  auto: "Automatic",
  "4w": "4 weeks",
  "12w": "12 weeks",
  "1y": "1 year",
  all: "All time",
};

export const STATS_RANGE_DESCRIPTIONS: Record<StatsRange, string> = {
  auto: "The shortest window that has training in it.",
  "4w": "The last four weeks.",
  "12w": "The last twelve weeks.",
  "1y": "The last year.",
  all: "Everything ever logged.",
};

export type FitnessPrefs = {
  /** What Fitness → Home's analytics open on. */
  defaultRange: StatsRange;
};

/** `auto` because a database last trained in months ago still opens full. */
export const DEFAULT_FITNESS_PREFS: FitnessPrefs = { defaultRange: "auto" };

/** Namespaced — localStorage is per origin. */
export const FITNESS_PREFS_STORAGE_KEY = "projectmc.fitness";

export function isStatsRange(value: unknown): value is StatsRange {
  return typeof value === "string" && (STATS_RANGES as readonly string[]).includes(value);
}

/** The stored preferences, falling back per field for the reason `readStoredUnits` does. */
export function readStoredFitnessPrefs(
  storage: Pick<Storage, "getItem"> | null | undefined,
): FitnessPrefs {
  if (!storage) return DEFAULT_FITNESS_PREFS;
  try {
    const raw = storage.getItem(FITNESS_PREFS_STORAGE_KEY);
    if (!raw) return DEFAULT_FITNESS_PREFS;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return DEFAULT_FITNESS_PREFS;

    const record = parsed as Record<string, unknown>;
    return {
      defaultRange: isStatsRange(record.defaultRange)
        ? record.defaultRange
        : DEFAULT_FITNESS_PREFS.defaultRange,
    };
  } catch {
    return DEFAULT_FITNESS_PREFS;
  }
}

/** Persists the choices, ignoring storage failures — the choice just won't survive a reload. */
export function writeStoredFitnessPrefs(
  storage: Pick<Storage, "setItem"> | null | undefined,
  prefs: FitnessPrefs,
): void {
  if (!storage) return;
  try {
    storage.setItem(FITNESS_PREFS_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* not worth surfacing */
  }
}
