import React from "react";
import { configure, render } from "@testing-library/react-native";
import { StyleSheet } from "react-native";
import { FitnessStats } from "../../../api";
import ConsistencyHeatmap, { dayLabels } from "../ConsistencyHeatmap";
import MuscleSplit from "../MuscleSplit";
import StrengthProgression from "../StrengthProgression";
import VolumeTrend from "../VolumeTrend";
import { chart } from "../../../theme";

/**
 * Empty heatmap cells are deliberately hidden from accessibility, and RNTL skips
 * hidden elements by default — but their placement in the grid is exactly what
 * these tests are checking.
 */
configure({ defaultIncludeHiddenElements: true });

/** Styles arrive as arrays wherever a base style is merged with a computed one. */
const styleOf = (el: { props: { style?: unknown } }): Record<string, unknown> =>
  StyleSheet.flatten(el.props.style as never) ?? {};

/** Drives the heatmap's cell sizing without needing a real viewport. */
let mockWinWidth = 1280;
jest.mock("react-native/Libraries/Utilities/useWindowDimensions", () => ({
  __esModule: true,
  default: () => ({ width: mockWinWidth, height: 900, scale: 1, fontScale: 1 }),
}));

beforeEach(() => {
  mockWinWidth = 1280;
});

// ── Consistency heatmap ───────────────────────────────────────────────────────

const heatmap: FitnessStats["heatmap"] = {
  from: "2026-01-05", // a Monday
  to: "2026-02-01",
  max_hard_sets: 21,
  days: [{ date: "2026-01-07", sessions: 1, hard_sets: 21, tonnage_kg: 9800, duration_min: 84 }],
};

describe("ConsistencyHeatmap", () => {
  it("lays out four Monday-aligned columns of seven days", () => {
    const { getByTestId } = render(
      <ConsistencyHeatmap data={heatmap} loading={false} rangeLabel="the last 4 weeks" />,
    );

    // 2026-01-05 is a Monday, so it must be the first cell of the first column,
    // and the grid must run to the last day of the window without a gap.
    expect(getByTestId("heat-2026-01-05")).toBeTruthy();
    expect(getByTestId("heat-2026-01-11")).toBeTruthy(); // Sunday, row 6
    expect(getByTestId("heat-2026-01-12")).toBeTruthy(); // Monday, next column
    expect(getByTestId("heat-2026-02-01")).toBeTruthy();
  });

  it("labels Monday, Wednesday and Friday on whichever rows they fall", () => {
    // 2026-01-05 is a Monday; 2026-01-04 a Sunday.
    expect(dayLabels("2026-01-05")).toEqual(["Mon", "", "Wed", "", "Fri", "", ""]);
    expect(dayLabels("2026-01-04")).toEqual(["", "Mon", "", "Wed", "", "Fri", ""]);
  });

  it("labels only the days that actually happened", () => {
    const { getByTestId } = render(
      <ConsistencyHeatmap data={heatmap} loading={false} rangeLabel="the last 4 weeks" />,
    );

    // Labelling all 366 cells would bury the panel under tab stops.
    expect(getByTestId("heat-2026-01-07").props.accessibilityLabel).toContain("21 hard sets");
    expect(getByTestId("heat-2026-01-08").props.accessibilityLabel).toBeUndefined();
  });

  it("shades a day by its hard sets, and a blank day by the ramp's floor", () => {
    const { getByTestId } = render(
      <ConsistencyHeatmap data={heatmap} loading={false} rangeLabel="the last 4 weeks" />,
    );

    // Against the ramp rather than a hex: which rung a day lands on is this
    // component's decision, and what colour that rung is is theme.ts's — which
    // since Phase 7.0 answers with `var(--ch-heat-3)` in both themes.
    expect(styleOf(getByTestId("heat-2026-01-07")).backgroundColor).toBe(chart.heatmap[3]);
    expect(styleOf(getByTestId("heat-2026-01-08")).backgroundColor).toBe(chart.heatmap[0]);
  });

  it("shrinks its cells on a narrow viewport", () => {
    mockWinWidth = 375;
    const { getByTestId } = render(
      <ConsistencyHeatmap data={heatmap} loading={false} rangeLabel="the last 4 weeks" />,
    );

    expect(styleOf(getByTestId("heat-2026-01-07")).width).toBe(9);
  });

  it("names the window when nothing was logged", () => {
    const { getByText } = render(
      <ConsistencyHeatmap
        data={{ ...heatmap, days: [], max_hard_sets: 0 }}
        loading={false}
        rangeLabel="the last 4 weeks"
      />,
    );

    expect(getByText("No sessions in the last 4 weeks.")).toBeTruthy();
  });
});

// ── Volume trend ──────────────────────────────────────────────────────────────

const volume: FitnessStats["volume"] = {
  weeks: [
    { week_start: "2026-01-05", sessions: 4, hard_sets: 40, tonnage_kg: 20000 },
    { week_start: "2026-01-12", sessions: 0, hard_sets: 0, tonnage_kg: 0 },
    { week_start: "2026-01-19", sessions: 2, hard_sets: 20, tonnage_kg: 10000 },
  ],
  max_tonnage_kg: 20000,
  max_hard_sets: 40,
};

describe("VolumeTrend", () => {
  it("scales each bar against the peak week", () => {
    const { getByTestId } = render(<VolumeTrend data={volume} loading={false} />);

    expect(styleOf(getByTestId("vol-ton-2026-01-05")).height).toBe("100%");
    expect(styleOf(getByTestId("vol-ton-2026-01-19")).height).toBe("50%");
    expect(styleOf(getByTestId("vol-sets-2026-01-19")).height).toBe("50%");
  });

  it("renders an untrained week as nothing, so the gap stays visible", () => {
    const { getByTestId } = render(<VolumeTrend data={volume} loading={false} />);

    expect(styleOf(getByTestId("vol-ton-2026-01-12")).height).toBe("0%");
  });

  it("counts only the weeks that had a session", () => {
    const { getByText } = render(<VolumeTrend data={volume} loading={false} />);

    expect(getByText("2 active weeks")).toBeTruthy();
  });

  it("says so when a zero-filled range has no volume at all", () => {
    const { getByText } = render(
      <VolumeTrend
        data={{ ...volume, weeks: volume.weeks.map((w) => ({ ...w, sessions: 0 })) }}
        loading={false}
      />,
    );

    expect(getByText("No volume logged in this range.")).toBeTruthy();
  });
});

// ── Muscle split ──────────────────────────────────────────────────────────────

describe("MuscleSplit", () => {
  const muscles: FitnessStats["muscles"] = {
    total_hard_sets: 150,
    unmatched_sets: 0,
    items: [
      { muscle: "Legs", hard_sets: 100, tonnage_kg: 50000, share: 0.6667 },
      { muscle: "Chest", hard_sets: 50, tonnage_kg: 25000, share: 0.3333 },
    ],
  };

  it("scales bars against the largest muscle, not the total", () => {
    const { getByTestId } = render(<MuscleSplit data={muscles} loading={false} />);

    expect(styleOf(getByTestId("muscle-bar-Legs")).width).toBe("100%");
    expect(styleOf(getByTestId("muscle-bar-Chest")).width).toBe("50%");
  });

  it("owns up to sets it could not map to the exercise library", () => {
    const { getByText } = render(
      <MuscleSplit
        data={{
          ...muscles,
          unmatched_sets: 12,
          items: [...muscles.items, { muscle: "Unknown", hard_sets: 12, tonnage_kg: 0, share: 0.08 }],
        }}
        loading={false}
      />,
    );

    expect(getByText(/12 sets from exercises not in your library/)).toBeTruthy();
  });
});

// ── Strength progression ──────────────────────────────────────────────────────

describe("StrengthProgression", () => {
  const strength: FitnessStats["strength"] = {
    lifts: [
      {
        exercise_title: "Leg Press (Machine)",
        primary_muscle: "Legs",
        points: [
          { date: "2026-01-05", e1rm_kg: 100, weight_kg: 80, reps: 8 },
          { date: "2026-02-05", e1rm_kg: 150, weight_kg: 120, reps: 8 },
          { date: "2026-03-05", e1rm_kg: 200, weight_kg: 160, reps: 8 },
        ],
        first_e1rm_kg: 100,
        latest_e1rm_kg: 200,
        best_e1rm_kg: 200,
        change_pct: 100,
      },
    ],
    recent_prs: [
      {
        exercise_title: "Leg Press (Machine)",
        date: "2026-03-05",
        e1rm_kg: 200,
        weight_kg: 160,
        reps: 8,
        previous_e1rm_kg: 150,
        gain_pct: 33.3,
      },
    ],
  };

  it("suppresses the zero baseline so a real climb is visible", () => {
    const { getByTestId } = render(<StrengthProgression data={strength} loading={false} />);

    // Scaled between 100×0.92 and 200×1.02 rather than from zero, which would
    // squash this 2× improvement into a nearly flat row: the first session sits
    // at (100−92)/(204−92) ≈ 7%. The best session stops just short of the
    // ceiling, because `hi` carries 2% headroom so the tallest bar has somewhere
    // to grow into rather than looking pinned.
    const first = styleOf(getByTestId("lift-Leg Press (Machine)-2026-01-05")).height as string;
    const last = styleOf(getByTestId("lift-Leg Press (Machine)-2026-03-05")).height as string;
    expect(parseFloat(first)).toBeCloseTo(7.14, 1);
    expect(parseFloat(last)).toBeCloseTo(96.43, 1);
  });

  it("labels the endpoints in kilos, since the axis is truncated", () => {
    const { getByText } = render(<StrengthProgression data={strength} loading={false} />);

    expect(getByText("100kg")).toBeTruthy();
    expect(getByText("200kg")).toBeTruthy();
    expect(getByText("scaled to range")).toBeTruthy();
  });

  it("lists a record with the set that set it", () => {
    const { getByText } = render(<StrengthProgression data={strength} loading={false} />);

    expect(getByText("160kg × 8")).toBeTruthy();
    expect(getByText("+33.3%")).toBeTruthy();
  });

  it("names the formula the server used", () => {
    const { getByText, rerender } = render(<StrengthProgression data={strength} loading={false} formula="brzycki" />);
    expect(getByText("Brzycki estimated 1RM")).toBeTruthy();

    rerender(<StrengthProgression data={strength} loading={false} />);
    expect(getByText("Estimated 1RM")).toBeTruthy();
  });

  it("explains itself when no lift has enough sessions", () => {
    const { getByText } = render(
      <StrengthProgression data={{ lifts: [], recent_prs: [] }} loading={false} />,
    );

    expect(
      getByText("Not enough data yet — a lift needs 3+ sessions with weight and reps to chart."),
    ).toBeTruthy();
  });
});
