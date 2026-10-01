import React from "react";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import Workouts from "../Workouts";
import { api, Workout } from "../../api";
import { captureFilePicker, csvFile } from "../../testing/filePicker";
import { page } from "../../testing/page";

jest.mock("../../api", () => ({
  ...jest.requireActual("../../api"),
  api: {
    listWorkouts:  jest.fn(),
    listExercises: jest.fn(),
    importWorkoutsCsv: jest.fn(),
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
    exercise_count: 1,
    duration_minutes: 45,
    created_at: "",
    updated_at: "",
  };
}

const eight = Array.from({ length: 8 }, (_, i) => workout(i + 1));

/** More than PAGE_SIZE (20), so the all-workouts list spans two pages. */
const twentyFive = Array.from({ length: 25 }, (_, i) => workout(i + 1));

/**
 * `total` stands in for a database bigger than the fetch cap. Omitting it also
 * omits `meta`, which is the older-API shape the screen must still cope with.
 */
function withWorkouts(data: Workout[], total?: number) {
  mockApi.listWorkouts.mockResolvedValue({
    data,
    ...(total === undefined
      ? {}
      : { meta: { total, returned: data.length, limit: 200 } }),
    summary: { week_count: 2, week_goal: 4, streak_days: 3, last_session: data[0] ?? null },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  withWorkouts(eight);
  mockApi.listExercises.mockResolvedValue(page([]));
});

it("requests the full list from the API in one call", async () => {
  render(<Workouts active />);
  await waitFor(() => expect(mockApi.listWorkouts).toHaveBeenCalledWith({ limit: 200 }));
  expect(mockApi.listWorkouts).toHaveBeenCalledTimes(1);
});

it("opens on the workout list, with the log form behind its own tab", async () => {
  const { findByText, getByText, queryByText, queryByRole } = render(<Workouts active />);
  await waitFor(() => expect(mockApi.listWorkouts).toHaveBeenCalled());

  expect(queryByRole("tab", { name: "View all Workouts", selected: true })).toBeTruthy();
  expect(await findByText("Session 1")).toBeTruthy();
  // Hidden sub-pages are excluded from queries, so the form isn't reachable yet.
  expect(queryByText("Log a workout")).toBeNull();

  fireEvent.press(getByText("Log a Workout"));

  expect(getByText("Log a workout")).toBeTruthy();
  expect(queryByRole("tab", { name: "Log a Workout", selected: true })).toBeTruthy();
  expect(queryByRole("tab", { name: "View all Workouts", selected: true })).toBeNull();
});

it("keeps every sub-page mounted so switching tabs preserves form state", async () => {
  const { findByText, getByText, getByPlaceholderText, getByDisplayValue } =
    render(<Workouts active />);
  await findByText("Session 1");

  fireEvent.press(getByText("Log a Workout"));
  fireEvent.changeText(getByPlaceholderText(/Upper 2/), "Leg Day");
  fireEvent.press(getByText("Import Hevy CSV"));

  // The log form is hidden, not unmounted — its text survives the tab switch.
  expect(getByText("Choose CSV file…")).toBeTruthy();
  expect(getByDisplayValue("Leg Day", { includeHiddenElements: true })).toBeTruthy();
});

it("pages the all-workouts list, 20 rows at a time", async () => {
  withWorkouts(twentyFive);
  const { findByText, getByText, queryByText } = render(<Workouts active />);

  expect(await findByText("Showing 1–20 of 25 workouts, newest first.")).toBeTruthy();
  expect(getByText("Page 1 of 2")).toBeTruthy();
  expect(queryByText("Session 20")).toBeTruthy();
  expect(queryByText("Session 21")).toBeNull();
});

it("moves between pages with the pager buttons", async () => {
  withWorkouts(twentyFive);
  const { findByText, getByText, queryByText } = render(<Workouts active />);
  await findByText("Page 1 of 2");

  fireEvent.press(getByText("Next →"));
  expect(getByText("Showing 21–25 of 25 workouts, newest first.")).toBeTruthy();
  expect(getByText("Page 2 of 2")).toBeTruthy();
  expect(queryByText("Session 21")).toBeTruthy();
  expect(queryByText("Session 20")).toBeNull();

  fireEvent.press(getByText("← Previous"));
  expect(getByText("Page 1 of 2")).toBeTruthy();
  expect(queryByText("Session 20")).toBeTruthy();
});

it("disables the pager button at each end of the range", async () => {
  withWorkouts(twentyFive);
  const { findByText, getByText, queryByRole } = render(<Workouts active />);
  await findByText("Page 1 of 2");

  expect(queryByRole("button", { name: "← Previous", disabled: true })).toBeTruthy();
  expect(queryByRole("button", { name: "Next →", disabled: true })).toBeNull();

  fireEvent.press(getByText("Next →"));

  expect(queryByRole("button", { name: "Next →", disabled: true })).toBeTruthy();
  expect(queryByRole("button", { name: "← Previous", disabled: true })).toBeNull();
});

it("keeps the current page when tabbing away and back", async () => {
  withWorkouts(twentyFive);
  const { findByText, getByText } = render(<Workouts active />);
  await findByText("Page 1 of 2");
  fireEvent.press(getByText("Next →"));

  fireEvent.press(getByText("Log a Workout"));
  fireEvent.press(getByText("View all Workouts"));

  expect(getByText("Page 2 of 2")).toBeTruthy();
});

it("shows no pager when every workout fits on one page", async () => {
  const { findByText, queryByText } = render(<Workouts active />);

  expect(await findByText("Showing 1–8 of 8 workouts, newest first.")).toBeTruthy();
  expect(queryByText(/^Page \d+ of/)).toBeNull();
});

// ── Deep link from Fitness → Home ─────────────────────────────────────────────

it("selects the all-workouts tab when another screen links to the full list", async () => {
  withWorkouts(twentyFive);
  const { findByText, getByText, queryByRole, rerender } =
    render(<Workouts active openAllSignal={0} />);
  await findByText("Page 1 of 2");

  // The list is already the default tab, so leave it — the link has to be able
  // to pull the screen back from wherever the user left it.
  fireEvent.press(getByText("Log a Workout"));
  expect(queryByRole("tab", { name: "View all Workouts", selected: true })).toBeNull();

  rerender(<Workouts active openAllSignal={1} />);

  expect(queryByRole("tab", { name: "View all Workouts", selected: true })).toBeTruthy();
  expect(getByText("Page 1 of 2")).toBeTruthy();
});

it("returns to page 1 each time the link is followed", async () => {
  withWorkouts(twentyFive);
  const { findByText, getByText, rerender } = render(<Workouts active openAllSignal={1} />);
  await findByText("Page 1 of 2");
  fireEvent.press(getByText("Next →"));
  expect(getByText("Page 2 of 2")).toBeTruthy();

  // A second follow bumps the counter again — a boolean would not re-fire here.
  rerender(<Workouts active openAllSignal={2} />);

  expect(getByText("Page 1 of 2")).toBeTruthy();
});

// ── Counts vs. the fetch cap ──────────────────────────────────────────────────

it("counts the rows it lists, not the whole table, in the range label", async () => {
  // 25 fetched out of 250 in the database — the pager only walks the 25.
  withWorkouts(twentyFive, 250);
  const { findByText, getByText } = render(<Workouts active />);

  expect(await findByText("Showing 1–20 of 25 workouts, newest first.")).toBeTruthy();
  expect(getByText("Page 1 of 2")).toBeTruthy();
});

it("says how many older workouts are missing when the fetch is capped", async () => {
  withWorkouts(twentyFive, 250);
  const { findByText } = render(<Workouts active />);

  expect(
    await findByText(
      "Only the 25 most recent of your 250 workouts are loaded — 225 older sessions aren't listed here."
    )
  ).toBeTruthy();
});

it("says nothing about missing workouts when the whole table fits", async () => {
  withWorkouts(eight, 8);
  const { findByText, queryByText } = render(<Workouts active />);

  expect(await findByText("Showing 1–8 of 8 workouts, newest first.")).toBeTruthy();
  expect(queryByText(/most recent of your/)).toBeNull();
});

it("falls back to the fetched count when the API sends no meta", async () => {
  withWorkouts(eight);
  const { findByText, queryByText } = render(<Workouts active />);

  expect(await findByText("Showing 1–8 of 8 workouts, newest first.")).toBeTruthy();
  expect(queryByText(/most recent of your/)).toBeNull();
});

it("shows the empty state on the all-workouts tab when there are no workouts", async () => {
  withWorkouts([]);
  const { findByText, queryByText } = render(<Workouts active />);

  expect(await findByText("No workouts yet. Log one or import a CSV.")).toBeTruthy();
  expect(queryByText(/^Showing /)).toBeNull();
});

// ── CSV import ────────────────────────────────────────────────────────────────

/**
 * Reachable from a test for the first time in Phase 7.0: the handler used to
 * return early on anything Jest reported as native, so everything below the
 * `Platform.OS` check had only ever run in a browser.
 */
it("imports the file the picker hands back, and reports what came of it", async () => {
  mockApi.importWorkoutsCsv.mockResolvedValue({
    imported_sessions: 2,
    imported_sets: 14,
    skipped_sessions: 1,
    errors: [],
  });

  const picker = captureFilePicker();
  const { getByText, findByText } = render(<Workouts active />);
  await waitFor(() => expect(mockApi.listWorkouts).toHaveBeenCalled());

  fireEvent.press(getByText("Import Hevy CSV"));
  fireEvent.press(getByText("Choose CSV file…"));

  // The screen asks the browser for a CSV specifically — a picker offering
  // every file is how someone ends up uploading a photo of their spreadsheet.
  expect(picker.input.type).toBe("file");
  expect(picker.input.accept).toBe(".csv,text/csv");

  const file = csvFile();
  await picker.choose(file);

  expect(mockApi.importWorkoutsCsv).toHaveBeenCalledWith(file);
  expect(await findByText("Imported 2 sessions (14 sets), skipped 1.")).toBeTruthy();

  // The list is re-read rather than patched: an import writes rows this screen
  // is showing, and how many is not something the response says.
  expect(mockApi.listWorkouts.mock.calls.length).toBeGreaterThan(1);
});

it("keeps a failed import on screen instead of a blank result", async () => {
  mockApi.importWorkoutsCsv.mockRejectedValue(new Error("Row 3: unknown set_type"));

  const picker = captureFilePicker();
  const { getByText, findByText } = render(<Workouts active />);
  await waitFor(() => expect(mockApi.listWorkouts).toHaveBeenCalled());

  fireEvent.press(getByText("Import Hevy CSV"));
  fireEvent.press(getByText("Choose CSV file…"));
  await picker.choose(csvFile());

  expect(await findByText("Import failed: Row 3: unknown set_type")).toBeTruthy();
});
