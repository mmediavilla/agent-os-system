import { Exercise, WorkoutSet } from "../api";
import {
  clearUnusedMetrics,
  displayMetric,
  emptySet,
  exerciseInputsFrom,
  METRICS_FOR_TYPE,
  metricLabel,
  metricsForTitle,
  metricsPresentIn,
  num,
  setInputFrom,
  setPayload,
} from "../setMetrics";
import { UnitPrefs } from "../units";

const exercise = (name: string, exercise_type: Exercise["exercise_type"]): Exercise => ({
  id: 1, name, primary_muscle: "Chest", equipment: null, exercise_type,
  notes: null, created_at: "", updated_at: "",
});

const storedSet = (over: Partial<WorkoutSet> = {}): WorkoutSet => ({
  id: 1, workout_id: 1, exercise_title: "X", superset_id: null, exercise_notes: null,
  set_index: 0, set_type: "normal",
  weight_kg: null, reps: null, distance_km: null, duration_seconds: null, rpe: null,
  created_at: "", updated_at: "", ...over,
});

describe("METRICS_FOR_TYPE", () => {
  it("collects weight and reps only for weight_reps", () => {
    expect(METRICS_FOR_TYPE.weight_reps).toEqual(["weight_kg", "reps", "rpe"]);
  });

  it("omits weight for reps_only", () => {
    expect(METRICS_FOR_TYPE.reps_only).not.toContain("weight_kg");
  });

  it("asks for neither weight nor reps on a duration exercise", () => {
    expect(METRICS_FOR_TYPE.duration).toEqual(["duration_seconds", "rpe"]);
  });

  it("pairs distance with duration", () => {
    expect(METRICS_FOR_TYPE.distance_duration).toEqual(["distance_km", "duration_seconds", "rpe"]);
  });
});

describe("metricsForTitle", () => {
  const all = [exercise("Plank", "duration"), exercise("Bench Press", "weight_reps")];

  it("resolves an exercise by name", () => {
    expect(metricsForTitle(all, "Plank")).toEqual(["duration_seconds", "rpe"]);
  });

  it("falls back to weight+reps for titles with no matching record", () => {
    // CSV-imported history predates the exercises table.
    expect(metricsForTitle(all, "Some Legacy Import")).toEqual(["weight_kg", "reps", "rpe"]);
  });

  it("falls back when the exercise list has not loaded", () => {
    expect(metricsForTitle([], "Plank")).toEqual(["weight_kg", "reps", "rpe"]);
  });
});

describe("metricsPresentIn", () => {
  it("returns only the metrics that carry data", () => {
    const sets = [storedSet({ duration_seconds: 60, rpe: 7 })];
    expect(metricsPresentIn(sets)).toEqual(["duration_seconds", "rpe"]);
  });

  it("keeps canonical display order regardless of which are present", () => {
    const sets = [storedSet({ rpe: 8, distance_km: 5 })];
    expect(metricsPresentIn(sets)).toEqual(["distance_km", "rpe"]);
  });

  it("unions across sets so a partially filled column still shows", () => {
    const sets = [storedSet({ reps: 10 }), storedSet({ weight_kg: 60 })];
    expect(metricsPresentIn(sets)).toEqual(["weight_kg", "reps"]);
  });

  it("falls back to weight+reps when no set carries anything", () => {
    expect(metricsPresentIn([storedSet()])).toEqual(["weight_kg", "reps", "rpe"]);
  });
});

describe("clearUnusedMetrics", () => {
  // Regression: switching a row from a weight exercise to a duration one used
  // to leave the old values in state, hidden but still saved — the workout
  // detail then showed a plank at 100kg for 8 reps.
  it("blanks metrics the new type does not use", () => {
    const filled = { ...emptySet(), weight_kg: "100", reps: "8", rpe: "9" };

    const cleared = clearUnusedMetrics(filled, METRICS_FOR_TYPE.duration);

    expect(cleared.weight_kg).toBe("");
    expect(cleared.reps).toBe("");
  });

  it("keeps metrics the new type shares with the old", () => {
    const filled = { ...emptySet(), weight_kg: "100", reps: "8", rpe: "9" };

    expect(clearUnusedMetrics(filled, METRICS_FOR_TYPE.duration).rpe).toBe("9");
    expect(clearUnusedMetrics(filled, METRICS_FOR_TYPE.reps_only).reps).toBe("8");
  });

  it("preserves set_type", () => {
    const filled = { ...emptySet(), set_type: "warmup" as const, weight_kg: "60" };

    expect(clearUnusedMetrics(filled, METRICS_FOR_TYPE.duration).set_type).toBe("warmup");
  });

  it("does not mutate the input", () => {
    const filled = { ...emptySet(), weight_kg: "100" };

    clearUnusedMetrics(filled, METRICS_FOR_TYPE.duration);

    expect(filled.weight_kg).toBe("100");
  });
});

describe("num", () => {
  it("omits blank and whitespace-only input", () => {
    expect(num("")).toBeUndefined();
    expect(num("   ")).toBeUndefined();
  });

  it("omits unparseable input rather than sending NaN", () => {
    expect(num("abc")).toBeUndefined();
    expect(num("abc", true)).toBeUndefined();
  });

  it("parses decimals and integers", () => {
    expect(num("5.2")).toBe(5.2);
    expect(num("1800", true)).toBe(1800);
  });
});

describe("setPayload", () => {
  it("omits blank metrics instead of sending zero", () => {
    const payload = setPayload({ ...emptySet(), duration_seconds: "60" });

    expect(payload.duration_seconds).toBe(60);
    expect(payload.weight_kg).toBeUndefined();
    expect(payload.reps).toBeUndefined();
  });

  it("carries set_type through", () => {
    expect(setPayload({ ...emptySet(), set_type: "dropset" }).set_type).toBe("dropset");
  });
});

describe("setInputFrom", () => {
  it("renders nulls as blank strings so inputs stay controlled", () => {
    const input = setInputFrom(storedSet({ weight_kg: 60 }));

    expect(input.weight_kg).toBe("60");
    expect(input.reps).toBe("");
    expect(input.distance_km).toBe("");
  });

  it("round-trips through setPayload without inventing values", () => {
    const original = storedSet({ distance_km: 5.2, duration_seconds: 1800, rpe: 6 });

    const payload = setPayload(setInputFrom(original));

    expect(payload).toMatchObject({ distance_km: 5.2, duration_seconds: 1800, rpe: 6 });
    expect(payload.weight_kg).toBeUndefined();
    expect(payload.reps).toBeUndefined();
  });
});

describe("exerciseInputsFrom", () => {
  it("groups sets under their exercise, in set_index order", () => {
    const exercises = exerciseInputsFrom([
      storedSet({ exercise_title: "Squat", set_index: 2, weight_kg: 100 }),
      storedSet({ exercise_title: "Bench", set_index: 0, weight_kg: 60 }),
      storedSet({ exercise_title: "Squat", set_index: 1, weight_kg: 90 }),
    ]);

    expect(exercises.map((e) => e.exercise_title)).toEqual(["Bench", "Squat"]);
    expect(exercises[1].sets.map((s) => s.weight_kg)).toEqual(["90", "100"]);
  });

  it("carries exercise notes from the first set of each group", () => {
    const exercises = exerciseInputsFrom([
      storedSet({ exercise_title: "Squat", set_index: 0, exercise_notes: "belt on" }),
      storedSet({ exercise_title: "Squat", set_index: 1, exercise_notes: null }),
    ]);

    expect(exercises[0].exercise_notes).toBe("belt on");
  });

  it("renders missing notes as a blank string so the input stays controlled", () => {
    const exercises = exerciseInputsFrom([storedSet({ exercise_notes: null })]);

    expect(exercises[0].exercise_notes).toBe("");
  });

  it("gives a workout with no sets one blank exercise to edit into", () => {
    const exercises = exerciseInputsFrom([]);

    expect(exercises).toHaveLength(1);
    expect(exercises[0].exercise_title).toBe("");
    expect(exercises[0].sets).toHaveLength(1);
  });

  it("does not mutate the array it is given", () => {
    const sets = [
      storedSet({ exercise_title: "Squat", set_index: 1 }),
      storedSet({ exercise_title: "Bench", set_index: 0 }),
    ];

    exerciseInputsFrom(sets);

    expect(sets.map((s) => s.set_index)).toEqual([1, 0]);
  });
});

// ── Units ─────────────────────────────────────────────────────────────────────

const IMPERIAL: UnitPrefs = { weight: "lb", distance: "mi", measurement: "in" };

describe("metricLabel", () => {
  it("names weight and distance after the unit in use", () => {
    expect(metricLabel("weight_kg")).toBe("KG");
    expect(metricLabel("distance_km")).toBe("KM");
    expect(metricLabel("weight_kg", IMPERIAL)).toBe("LB");
    expect(metricLabel("distance_km", IMPERIAL)).toBe("MI");
  });

  it("leaves the unit-free metrics alone", () => {
    expect(metricLabel("reps", IMPERIAL)).toBe("REPS");
    expect(metricLabel("duration_seconds", IMPERIAL)).toBe("SECS");
    expect(metricLabel("rpe", IMPERIAL)).toBe("RPE");
  });
});

describe("displayMetric", () => {
  it("dashes a metric the set doesn't carry", () => {
    expect(displayMetric(storedSet(), "weight_kg", IMPERIAL)).toBe("—");
  });

  it("converts weight and distance, and only those", () => {
    const set = storedSet({ weight_kg: 100, distance_km: 5, reps: 8, rpe: 9 });

    expect(displayMetric(set, "weight_kg", IMPERIAL)).toBe("220.5");
    expect(displayMetric(set, "distance_km", IMPERIAL)).toBe("3.1");
    expect(displayMetric(set, "reps", IMPERIAL)).toBe("8");
    expect(displayMetric(set, "rpe", IMPERIAL)).toBe("9");
  });
});

describe("unit conversion at the form boundary", () => {
  it("shows stored kilograms and kilometers in the chosen units", () => {
    const input = setInputFrom(storedSet({ weight_kg: 100, distance_km: 5 }), IMPERIAL);

    expect(input.weight_kg).toBe("220.5");
    expect(input.distance_km).toBe("3.1");
  });

  it("converts typed values back before they are saved", () => {
    const payload = setPayload({ ...emptySet(), weight_kg: "225", distance_km: "3.1" }, IMPERIAL);

    expect(payload.weight_kg).toBeCloseTo(102.06, 2);
    expect(payload.distance_km).toBeCloseTo(4.989, 3);
  });

  it("leaves reps and duration untouched — they have no unit", () => {
    const payload = setPayload({ ...emptySet(), reps: "8", duration_seconds: "90" }, IMPERIAL);

    expect(payload.reps).toBe(8);
    expect(payload.duration_seconds).toBe(90);
  });

  it("still omits blanks rather than converting them to zero", () => {
    const payload = setPayload(emptySet(), IMPERIAL);

    expect(payload.weight_kg).toBeUndefined();
    expect(payload.distance_km).toBeUndefined();
  });

  it("round-trips a stored set through the form to within a display decimal", () => {
    const original = storedSet({ weight_kg: 100, distance_km: 5 });

    const payload = setPayload(setInputFrom(original, IMPERIAL), IMPERIAL);

    expect(payload.weight_kg).toBeCloseTo(100, 1);
    expect(payload.distance_km).toBeCloseTo(5, 1);
  });

  it("is exact when the display units are the canonical ones", () => {
    const original = storedSet({ weight_kg: 102.5, distance_km: 5.2 });

    const payload = setPayload(setInputFrom(original));

    expect(payload.weight_kg).toBe(102.5);
    expect(payload.distance_km).toBe(5.2);
  });

  it("converts every set when grouping a whole workout", () => {
    const [ex] = exerciseInputsFrom([storedSet({ weight_kg: 100 })], IMPERIAL);

    expect(ex.sets[0].weight_kg).toBe("220.5");
  });
});
