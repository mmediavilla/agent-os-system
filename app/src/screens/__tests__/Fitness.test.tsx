import React from "react";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import Fitness from "../Fitness";
import { FitnessPrefsProvider, useFitnessPrefs } from "../../FitnessPrefsProvider";
import { FITNESS_PREFS_STORAGE_KEY } from "../../fitnessPrefs";
import { api, FitnessStats, Workout } from "../../api";

jest.mock("../../api", () => ({
  ...jest.requireActual("../../api"),
  api: {
    listWorkouts: jest.fn(),
    listInsights: jest.fn(),
    generateFitnessInsight: jest.fn(),
    getFitnessStats: jest.fn(),
  },
}));

const mockApi = api as jest.Mocked<typeof api>;

function workout(id: number): Workout {
  return {
    id,
    user_id: 1,
    title: `Session ${id}`,
    started_at: `2026-08-0${(id % 9) + 1}T09:00:00`,
    ended_at: null,
    description: null,
    notes: null,
    set_count: 3,
    exercise_count: 2,
    duration_minutes: 45,
    created_at: "",
    updated_at: "",
  };
}

const eight = Array.from({ length: 8 }, (_, i) => workout(i + 1));

/**
 * `total` stands in for a database bigger than the fetch cap. Omitting it also
 * omits `meta`, which is the older-API shape the screen must still cope with.
 */
function withWorkouts(data: Workout[], total?: number) {
  mockApi.listWorkouts.mockResolvedValue({
    data,
    ...(total === undefined
      ? {}
      : { meta: { total, returned: data.length, limit: 50 } }),
    summary: { week_count: 2, week_goal: 4, streak_days: 3, last_session: data[0] ?? null },
  });
}

/**
 * The default for every test that is not about the dashboard.
 *
 * With an empty payload all four panels render their own empty states, whose
 * wording is deliberately distinct from the recent card's — so the assertions
 * about recent workouts stay unambiguous.
 */
const EMPTY_STATS: FitnessStats = {
  range: {
    requested: "auto",
    resolved: "4w",
    from: "2026-07-20",
    to: "2026-08-16",
    options: ["4w", "12w", "1y", "all"],
    data_first: null,
    data_last: null,
  },
  kpis: {
    sessions: 0,
    hard_sets: 0,
    tonnage_kg: 0,
    avg_duration_min: 0,
    sessions_per_week: 0,
  },
  heatmap: { from: "2026-07-20", to: "2026-08-16", max_hard_sets: 0, days: [] },
  volume: { weeks: [], max_tonnage_kg: 0, max_hard_sets: 0 },
  muscles: { total_hard_sets: 0, unmatched_sets: 0, items: [] },
  strength: { lifts: [], recent_prs: [] },
  settings: { e1rm_formula: "epley", week_start: "monday" },
};

const FULL_STATS: FitnessStats = {
  range: {
    requested: "auto",
    resolved: "1y",
    from: "2025-08-17",
    to: "2026-08-16",
    options: ["4w", "12w", "1y", "all"],
    data_first: "2026-01-02",
    data_last: "2026-04-27",
  },
  kpis: {
    sessions: 72,
    hard_sets: 1443,
    tonnage_kg: 692064.5,
    avg_duration_min: 82.7,
    sessions_per_week: 1.4,
  },
  heatmap: {
    from: "2025-08-11",
    to: "2026-08-16",
    max_hard_sets: 30,
    days: [
      { date: "2026-01-02", sessions: 1, hard_sets: 21, tonnage_kg: 9800, duration_min: 84 },
    ],
  },
  volume: {
    weeks: [
      { week_start: "2025-12-29", sessions: 1, hard_sets: 21, tonnage_kg: 9800 },
      { week_start: "2026-01-05", sessions: 4, hard_sets: 62, tonnage_kg: 21400.5 },
    ],
    max_tonnage_kg: 21400.5,
    max_hard_sets: 62,
  },
  muscles: {
    total_hard_sets: 1443,
    unmatched_sets: 0,
    items: [
      { muscle: "Legs", hard_sets: 399, tonnage_kg: 289453, share: 0.2765 },
      { muscle: "Back", hard_sets: 328, tonnage_kg: 163717.5, share: 0.2273 },
    ],
  },
  strength: {
    lifts: [
      {
        exercise_title: "Leg Press (Machine)",
        primary_muscle: "Legs",
        points: [
          { date: "2026-01-05", e1rm_kg: 133.3, weight_kg: 100, reps: 10 },
          { date: "2026-02-05", e1rm_kg: 150, weight_kg: 120, reps: 8 },
          { date: "2026-03-05", e1rm_kg: 185, weight_kg: 150, reps: 7 },
        ],
        first_e1rm_kg: 133.3,
        latest_e1rm_kg: 185,
        best_e1rm_kg: 185,
        change_pct: 38.8,
      },
    ],
    recent_prs: [
      {
        exercise_title: "Leg Press (Machine)",
        date: "2026-03-05",
        e1rm_kg: 185,
        weight_kg: 150,
        reps: 7,
        previous_e1rm_kg: 150,
        gain_pct: 23.3,
      },
    ],
  },
  settings: { e1rm_formula: "brzycki", week_start: "monday" },
};

beforeEach(() => {
  jest.clearAllMocks();
  withWorkouts(eight);
  mockApi.listInsights.mockResolvedValue({ data: [] });
  mockApi.getFitnessStats.mockResolvedValue(EMPTY_STATS);
});

it("shows the five most recent workouts", async () => {
  const { findByText, queryByText } = render(<Fitness active onOpenAllWorkouts={() => {}} />);

  expect(await findByText("Session 1")).toBeTruthy();
  expect(queryByText("Session 5")).toBeTruthy();
  expect(queryByText("Session 6")).toBeNull();
});

it("summarises each session with its exercise and set counts", async () => {
  const { findAllByText } = render(<Fitness active onOpenAllWorkouts={() => {}} />);

  // One line per recent row — the fixtures all carry the same counts.
  expect(await findAllByText("2 exercises · 3 sets")).toHaveLength(5);
});

it("links to the full list on the Workouts screen", async () => {
  const onOpenAllWorkouts = jest.fn();
  const { findByText } = render(<Fitness active onOpenAllWorkouts={onOpenAllWorkouts} />);

  fireEvent.press(await findByText("View all Workouts (8) →"));

  expect(onOpenAllWorkouts).toHaveBeenCalledTimes(1);
});

it("counts the whole table in the link, not the rows it fetched", async () => {
  // 8 of 72 fetched — the link names the database, not this page.
  withWorkouts(eight, 72);
  const { findByText } = render(<Fitness active onOpenAllWorkouts={() => {}} />);

  expect(await findByText("View all Workouts (72) →")).toBeTruthy();
});

it("shows the empty state and no link when there are no workouts", async () => {
  withWorkouts([]);
  const { findByText, queryByText } = render(<Fitness active onOpenAllWorkouts={() => {}} />);

  expect(await findByText("No workouts yet. Log one under Fitness → Workouts.")).toBeTruthy();
  expect(queryByText(/^View all Workouts/)).toBeNull();
  expect(queryByText("View all Workouts →")).toBeNull();
});

// ── Dashboard ─────────────────────────────────────────────────────────────────

it("fills the analytics panels once the stats land", async () => {
  mockApi.getFitnessStats.mockResolvedValue(FULL_STATS);
  const { findByText, getByTestId, getByText } = render(
    <Fitness active onOpenAllWorkouts={() => {}} />,
  );

  // KPI row — tonnage switches to tonnes rather than printing six digits.
  expect(await findByText("692.1t")).toBeTruthy();
  expect(getByText("1,443")).toBeTruthy();
  expect(getByText("83m")).toBeTruthy();

  expect(getByTestId("muscle-bar-Legs")).toBeTruthy();
  expect(getByTestId("heat-2026-01-02")).toBeTruthy();
  expect(getByTestId("vol-ton-2026-01-05")).toBeTruthy();
  expect(getByText("+23.3%")).toBeTruthy();
});

it("lights the pill for the window the server actually chose", async () => {
  mockApi.getFitnessStats.mockResolvedValue(FULL_STATS);
  const { findByRole } = render(<Fitness active onOpenAllWorkouts={() => {}} />);

  // Asked for "auto" and got "1y" back, because 4w and 12w hold no sessions.
  expect(await findByRole("button", { name: "1y", selected: true })).toBeTruthy();
});

it("refetches when a different range is picked", async () => {
  mockApi.getFitnessStats.mockResolvedValue(FULL_STATS);
  const { findByText } = render(<Fitness active onOpenAllWorkouts={() => {}} />);

  fireEvent.press(await findByText("12w"));

  await waitFor(() =>
    expect(mockApi.getFitnessStats).toHaveBeenCalledWith({ range: "12w" }),
  );
});

it("opens on the default range chosen in Fitness → Settings", async () => {
  localStorage.setItem(FITNESS_PREFS_STORAGE_KEY, JSON.stringify({ defaultRange: "1y" }));
  mockApi.getFitnessStats.mockResolvedValue(FULL_STATS);
  render(
    <FitnessPrefsProvider>
      <Fitness active onOpenAllWorkouts={() => {}} />
    </FitnessPrefsProvider>,
  );

  await waitFor(() => expect(mockApi.getFitnessStats).toHaveBeenCalledWith({ range: "1y" }));
  expect(mockApi.getFitnessStats).not.toHaveBeenCalledWith({ range: "auto" });
});

it("moves to a new default when it is changed while Home stays mounted", async () => {
  mockApi.getFitnessStats.mockResolvedValue(FULL_STATS);
  let setPref: ReturnType<typeof useFitnessPrefs>["setPref"] = () => {};
  function Grab() {
    setPref = useFitnessPrefs().setPref;
    return null;
  }
  render(
    <FitnessPrefsProvider>
      <Grab />
      <Fitness active onOpenAllWorkouts={() => {}} />
    </FitnessPrefsProvider>,
  );
  await waitFor(() => expect(mockApi.getFitnessStats).toHaveBeenCalledWith({ range: "auto" }));

  act(() => setPref("defaultRange", "all"));

  await waitFor(() => expect(mockApi.getFitnessStats).toHaveBeenCalledWith({ range: "all" }));
});

it("keeps the recent workouts readable when the stats request fails", async () => {
  mockApi.getFitnessStats.mockRejectedValue(new Error("Server unavailable"));
  const { findByText, getByText } = render(<Fitness active onOpenAllWorkouts={() => {}} />);

  // The analytics section fails on its own; it must not take the rest of the
  // screen down with it.
  expect(await findByText("Server unavailable")).toBeTruthy();
  expect(getByText("Retry")).toBeTruthy();
  expect(getByText("Session 1")).toBeTruthy();
  expect(getByText("View all Workouts (8) →")).toBeTruthy();
});

it("names the window in the heatmap's empty state", async () => {
  const { findByText } = render(<Fitness active onOpenAllWorkouts={() => {}} />);

  // Distinct from the recent card's empty copy, so the two never blur together.
  expect(await findByText("No sessions in the last 4 weeks.")).toBeTruthy();
});

// ── Past insights ─────────────────────────────────────────────────────────────

/** A row of the history list. `kind` is what separates the two sorts. */
function insight(id: number, kind: string, title: string, response: string) {
  return {
    id,
    domain: "fitness",
    kind,
    title,
    response,
    input_summary: null,
    usage: null,
    model: null,
    created_at: "2026-09-03T07:00:00Z",
    updated_at: "2026-09-03T07:00:00Z",
  };
}

it("titles each past insight and marks the ones nobody asked for", async () => {
  mockApi.listInsights.mockResolvedValue({
    data: [
      insight(2, "proactive_nudge", "10 days since your last session", "Book one this week."),
      insight(1, "weekly_assessment", "Weekly fitness assessment", "Solid block."),
    ],
  });

  const { findByText, getByText } = render(<Fitness active onOpenAllWorkouts={() => {}} />);

  // The heading covers both kinds now that the assistant writes here unprompted.
  expect(await findByText("Past insights")).toBeTruthy();
  expect(getByText("10 days since your last session")).toBeTruthy();
  expect(getByText("Weekly fitness assessment")).toBeTruthy();

  // A nudge arrived on its own; an assessment was asked for. Same list, and the
  // date line is the only place that difference can be seen.
  expect(getByText(/· UNPROMPTED/)).toBeTruthy();
});
