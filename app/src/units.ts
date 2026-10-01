/**
 * The unit preferences: which units values are entered and displayed in.
 *
 * Storage stays canonical — the API and the database always speak kilograms,
 * kilometers and centimeters. These preferences are a presentation layer over
 * that: values are converted on the way onto the screen and back again on the
 * way into a payload, so switching units never rewrites stored data.
 *
 * Kept free of React and the DOM, like `accent.ts` — the
 * rules are testable on their own, and `UnitsProvider` is only the wiring.
 */

export type WeightUnit = "kg" | "lb";
export type DistanceUnit = "km" | "mi";
/** Body measurements: girths, not bodyweight — that's a WeightUnit. */
export type MeasurementUnit = "cm" | "in";

export type Unit = WeightUnit | DistanceUnit | MeasurementUnit;

/** The three independent choices. Someone can want pounds but kilometers. */
export type UnitPrefs = {
  weight: WeightUnit;
  distance: DistanceUnit;
  measurement: MeasurementUnit;
};

/** The dimensions, in the order Settings lists them. */
export const UNIT_DIMENSIONS = ["weight", "distance", "measurement"] as const;
export type UnitDimension = (typeof UNIT_DIMENSIONS)[number];

/** The canonical units — what the API stores, and what nothing converts. */
export const DEFAULT_UNITS: UnitPrefs = { weight: "kg", distance: "km", measurement: "cm" };

export const UNIT_OPTIONS: { [D in UnitDimension]: readonly UnitPrefs[D][] } = {
  weight: ["kg", "lb"],
  distance: ["km", "mi"],
  measurement: ["cm", "in"],
};

export const DIMENSION_LABELS: Record<UnitDimension, string> = {
  weight: "Weight",
  distance: "Distance",
  measurement: "Body measurements",
};

/** Long names for Settings. The short form is the symbol itself. */
export const UNIT_LABELS: Record<Unit, string> = {
  kg: "Kilograms",
  lb: "Pounds",
  km: "Kilometers",
  mi: "Miles",
  cm: "Centimeters",
  in: "Inches",
};

/**
 * How each unit should be *said*, for screen-reader labels.
 *
 * "kg" is announced as two letters, which is not what a chart summary should
 * sound like; these are plural because they always follow a number.
 */
export const UNIT_SPOKEN: Record<Unit, string> = {
  kg: "kilos",
  lb: "pounds",
  km: "kilometers",
  mi: "miles",
  cm: "centimeters",
  in: "inches",
};

/** Where the choices are persisted. Namespaced — localStorage is per origin. */
export const UNITS_STORAGE_KEY = "projectmc.units";

/**
 * How much of the canonical unit one of each unit is worth.
 *
 * One table rather than six conversion functions: every dimension converts the
 * same way, and the canonical unit of each is by definition 1.
 */
const CANONICAL_PER_UNIT: Record<Unit, number> = {
  kg: 1,
  lb: 0.45359237,
  km: 1,
  mi: 1.609344,
  cm: 1,
  in: 2.54,
};

/** Display value → stored value (kg / km / cm). */
export function toCanonical(value: number, unit: Unit): number {
  return value * CANONICAL_PER_UNIT[unit];
}

/** Stored value (kg / km / cm) → display value. */
export function fromCanonical(value: number, unit: Unit): number {
  return value / CANONICAL_PER_UNIT[unit];
}

/**
 * A converted number, trimmed for display.
 *
 * One decimal is the right resolution for all three dimensions — plates come
 * in 1.25kg / 2.5lb steps, and nobody logs a waist to a hundredth of an inch —
 * and trailing ".0" is dropped so unconverted values look untouched.
 */
export function fmtUnitValue(value: number, decimals = 1): string {
  const rounded = Number(value.toFixed(decimals));
  return String(rounded);
}

/**
 * A stored value as a display string, or "" for a missing one.
 *
 * Round-tripping through a display unit is lossy: 100kg shows as 220.5lb,
 * which converts back to 100.02kg. Saving an unrelated edit in pounds
 * therefore nudges the stored kilos by up to ~0.03. That is the cost of
 * editing in a non-canonical unit at one decimal, and it is well under the
 * resolution anyone logs at.
 */
export function displayValue(canonical: number | null | undefined, unit: Unit): string {
  if (canonical == null) return "";
  return fmtUnitValue(fromCanonical(canonical, unit));
}

export function isUnitFor<D extends UnitDimension>(
  dimension: D,
  value: unknown,
): value is UnitPrefs[D] {
  return (
    typeof value === "string" &&
    (UNIT_OPTIONS[dimension] as readonly string[]).includes(value)
  );
}

/**
 * The stored preferences, falling back per dimension.
 *
 * Validated field by field rather than as a whole: a value written by an older
 * build that only knew about weight should keep its weight choice instead of
 * having all three thrown away.
 */
export function readStoredUnits(storage: Pick<Storage, "getItem"> | null | undefined): UnitPrefs {
  if (!storage) return DEFAULT_UNITS;
  try {
    const raw = storage.getItem(UNITS_STORAGE_KEY);
    if (!raw) return DEFAULT_UNITS;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return DEFAULT_UNITS;

    const record = parsed as Record<string, unknown>;
    return UNIT_DIMENSIONS.reduce(
      (acc, dimension) => ({
        ...acc,
        [dimension]: isUnitFor(dimension, record[dimension])
          ? record[dimension]
          : DEFAULT_UNITS[dimension],
      }),
      {} as UnitPrefs,
    );
  } catch {
    // Unparseable JSON, or Safari private mode throwing on access. A unit
    // preference is not worth failing to boot over.
    return DEFAULT_UNITS;
  }
}

/** Persists the choices, ignoring storage failures for the same reason. */
export function writeStoredUnits(
  storage: Pick<Storage, "setItem"> | null | undefined,
  units: UnitPrefs,
): void {
  if (!storage) return;
  try {
    storage.setItem(UNITS_STORAGE_KEY, JSON.stringify(units));
  } catch {
    /* not worth surfacing — the choice just won't survive a reload */
  }
}

/**
 * A display value as a stored one, or undefined for a missing one.
 *
 * Rounded to milli-units: 225lb is 102.05828325kg exactly, and carrying that
 * tail into the database makes every kilogram reader deal with noise no one
 * typed.
 */
export function storedValue(value: number | undefined, unit: Unit): number | undefined {
  if (value === undefined) return undefined;
  return Number(toCanonical(value, unit).toFixed(3));
}
