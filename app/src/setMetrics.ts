import { Exercise, ExerciseType, SetType, WorkoutSet } from "./api";
import { DEFAULT_UNITS, UnitPrefs, displayValue, storedValue } from "./units";

/**
 * Which metrics a set collects depends on the exercise's type — a Duration
 * exercise shouldn't ask for kilos and reps. `workout_sets` carries every
 * column; the ones an exercise doesn't use are simply left null.
 */
export type MetricField = "weight_kg" | "reps" | "distance_km" | "duration_seconds" | "rpe";

/** Canonical display order, used whenever metrics are listed. */
export const METRIC_ORDER: MetricField[] = [
  "weight_kg", "reps", "distance_km", "duration_seconds", "rpe",
];

export const METRICS_FOR_TYPE: Record<ExerciseType, MetricField[]> = {
  weight_reps:       ["weight_kg", "reps", "rpe"],
  reps_only:         ["reps", "rpe"],
  duration:          ["duration_seconds", "rpe"],
  distance_duration: ["distance_km", "duration_seconds", "rpe"],
};

/** Headers for the metrics that never change name, whatever the units are. */
const FIXED_METRIC_LABEL: Record<Exclude<MetricField, "weight_kg" | "distance_km">, string> = {
  reps:             "REPS",
  duration_seconds: "SECS",
  rpe:              "RPE",
};

/**
 * A metric's column header.
 *
 * Weight and distance are named after the unit they're being shown in, so the
 * numbers under them are never ambiguous; the field names stay canonical
 * because that is what the API stores.
 */
export function metricLabel(field: MetricField, units: UnitPrefs = DEFAULT_UNITS): string {
  if (field === "weight_kg") return units.weight.toUpperCase();
  if (field === "distance_km") return units.distance.toUpperCase();
  return FIXED_METRIC_LABEL[field];
}

/** A stored set's metric as it should read on screen, or "—" when it has none. */
export function displayMetric(
  set: WorkoutSet,
  field: MetricField,
  units: UnitPrefs = DEFAULT_UNITS,
): string {
  const value = set[field];
  if (value == null) return "—";
  if (field === "weight_kg") return displayValue(value, units.weight);
  if (field === "distance_km") return displayValue(value, units.distance);
  return String(value);
}

export const METRIC_KEYBOARD: Record<MetricField, "decimal-pad" | "number-pad"> = {
  weight_kg:        "decimal-pad",
  reps:             "number-pad",
  distance_km:      "decimal-pad",
  duration_seconds: "number-pad",
  rpe:              "decimal-pad",
};

export const SET_TYPE_LABEL: Record<SetType, string> = {
  normal:  "Normal",
  warmup:  "Warmup",
  failure: "Failure",
  dropset: "Dropset",
};

export type SetInput = Record<MetricField, string> & { set_type: SetType };

export const emptySet = (): SetInput => ({
  set_type: "normal",
  weight_kg: "", reps: "", distance_km: "", duration_seconds: "", rpe: "",
});

export type ExerciseInput = {
  exercise_title: string;
  exercise_notes: string;
  sets: SetInput[];
};

export const emptyExercise = (): ExerciseInput => ({
  exercise_title: "",
  exercise_notes: "",
  sets: [emptySet()],
});

/**
 * Metrics for an exercise, resolved by name against the exercise database.
 * Titles with no matching record — CSV imports predate the exercises table —
 * fall back to weight + reps.
 */
export function metricsForTitle(exercises: Exercise[], title: string): MetricField[] {
  const match = exercises.find((e) => e.name === title);
  return METRICS_FOR_TYPE[match?.exercise_type ?? "weight_reps"];
}

/** Metrics carrying a value in at least one of these sets, in display order. */
export function metricsPresentIn(sets: WorkoutSet[]): MetricField[] {
  const present = METRIC_ORDER.filter((m) => sets.some((s) => s[m] != null));
  // Sets with no metrics at all still need column headers.
  return present.length ? present : METRICS_FOR_TYPE.weight_reps;
}

/** Blank or unparseable input is omitted rather than sent as NaN. */
export function num(value: string, integer = false): number | undefined {
  if (value.trim() === "") return undefined;
  const n = integer ? parseInt(value, 10) : parseFloat(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Form set → API payload, converted back to the canonical units.
 *
 * This and `setInputFrom` are the only two points where a set crosses between
 * what is stored and what is shown, which is why the conversion lives here
 * rather than in the form: everything between them is in the user's units.
 */
export const setPayload = (s: SetInput, units: UnitPrefs = DEFAULT_UNITS) => ({
  set_type:         s.set_type,
  weight_kg:        storedValue(num(s.weight_kg), units.weight),
  reps:             num(s.reps, true),
  distance_km:      storedValue(num(s.distance_km), units.distance),
  duration_seconds: num(s.duration_seconds, true),
  rpe:              num(s.rpe),
});

/**
 * Flat stored sets → grouped form exercises, ordered by set_index.
 *
 * Sets sharing an exercise_title collapse into one block. Two genuinely
 * different exercises logged under the same name in one workout therefore
 * merge — a limitation of the schema, which keys sets by title alone.
 */
export function exerciseInputsFrom(
  sets: WorkoutSet[],
  units: UnitPrefs = DEFAULT_UNITS,
): ExerciseInput[] {
  const grouped = new Map<string, ExerciseInput>();
  [...sets]
    .sort((a, b) => a.set_index - b.set_index)
    .forEach((s) => {
      if (!grouped.has(s.exercise_title)) {
        grouped.set(s.exercise_title, {
          exercise_title: s.exercise_title,
          exercise_notes: s.exercise_notes ?? "",
          sets: [],
        });
      }
      grouped.get(s.exercise_title)!.sets.push(setInputFrom(s, units));
    });
  // An empty workout still needs one blank row to edit into.
  return grouped.size > 0 ? Array.from(grouped.values()) : [emptyExercise()];
}

/** Stored set → form set, converted into the units being displayed. */
export const setInputFrom = (s: WorkoutSet, units: UnitPrefs = DEFAULT_UNITS): SetInput => {
  const str = (v: number | null) => (v != null ? String(v) : "");
  return {
    set_type:         s.set_type,
    weight_kg:        displayValue(s.weight_kg, units.weight),
    reps:             str(s.reps),
    distance_km:      displayValue(s.distance_km, units.distance),
    duration_seconds: str(s.duration_seconds),
    rpe:              str(s.rpe),
  };
};

/**
 * Blank out metrics the given type doesn't use.
 *
 * Applied when the user picks a different exercise for a row: the inputs for
 * the previous type stop rendering, but their values would otherwise stay in
 * state and get saved invisibly — e.g. switching a 100kg × 8 bench press to a
 * plank would store 100kg against the plank, and the detail view (which infers
 * its columns from the data) would then display it.
 */
export function clearUnusedMetrics(set: SetInput, metrics: MetricField[]): SetInput {
  const keep = new Set(metrics);
  const next = { ...set };
  for (const m of METRIC_ORDER) {
    if (!keep.has(m)) next[m] = "";
  }
  return next;
}
