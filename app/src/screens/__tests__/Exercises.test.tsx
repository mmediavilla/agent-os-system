import React from "react";
import { fireEvent, render, waitFor, within } from "@testing-library/react-native";
import Exercises from "../Exercises";
import { api, Equipment, Exercise, PageMeta } from "../../api";
import { PAGE_SIZE } from "../../components/Pagination";
import { EQUIPMENT_OPTIONS } from "../../exerciseConstants";
import EquipmentImage from "../../components/EquipmentImage";
import { page } from "../../testing/page";

jest.mock("../../api", () => ({
  ...jest.requireActual("../../api"),
  api: {
    listExercises: jest.fn(),
    createExercise: jest.fn(),
    updateExercise: jest.fn(),
    deleteExercise: jest.fn(),
    listEquipment: jest.fn(),
  },
}));

const mockApi = api as jest.Mocked<typeof api>;

function exercise(overrides: Partial<Exercise> = {}): Exercise {
  return {
    id: 1,
    name: "Bench Press",
    primary_muscle: "Chest",
    equipment: null,
    exercise_type: "weight_reps",
    notes: null,
    created_at: "",
    updated_at: "",
    ...overrides,
  };
}

function equipment(name: string, id: number, overrides: Partial<Equipment> = {}): Equipment {
  return {
    id,
    name,
    equipment_type: "Free Weight",
    status: "active",
    notes: null,
    thumbnail: null,
    image_url: null,
    created_at: "",
    updated_at: "",
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockApi.listExercises.mockResolvedValue(page([]));
  mockApi.listEquipment.mockResolvedValue(page([]));
  mockApi.updateExercise.mockResolvedValue(exercise());
});

/** Opens the edit sheet for the one listed exercise. */
async function openEdit(q: ReturnType<typeof render>, name: string) {
  fireEvent.press(await q.findByText(name));
  await q.findByText("Edit Exercise");
}

/**
 * Opens the equipment dropdown. Its options are behind a trigger now, so every
 * assertion about what the picker offers has to open it first. Addressed by
 * testID rather than text because the trigger is labelled with its own value,
 * which the exercise list also renders as a tag on the matching row.
 */
function openEquipment(q: ReturnType<typeof render>) {
  fireEvent.press(q.getByTestId("equipment-dropdown"));
}

/**
 * Serve `total` exercises the way the API does — one page per request, with a
 * page number clamped to the last one that exists.
 *
 * A fake rather than a fixed fixture because the paging assertions are about
 * the conversation, not one response: the screen has to send the page it means,
 * read back the page it got, and notice when the two disagree.
 */
function withPages(total: number) {
  mockApi.listExercises.mockImplementation(async (q) => {
    const perPage = q?.per_page ?? total;
    const lastPage = Math.max(1, Math.ceil(total / perPage));
    const current = Math.min(Math.max(q?.page ?? 1, 1), lastPage);
    const offset = (current - 1) * perPage;
    const rows = Array.from({ length: Math.max(0, Math.min(perPage, total - offset)) }, (_, i) =>
      exercise({ id: offset + i + 1, name: `Ex ${offset + i + 1}` }),
    );
    const meta: Partial<PageMeta> = {
      page: current,
      per_page: perPage,
      total,
      last_page: lastPage,
      from: rows.length ? offset + 1 : null,
      to: rows.length ? offset + rows.length : null,
    };
    return page(rows, meta);
  });
}

/** Picks `option` out of one of the filter dropdowns above the list. */
function chooseFilter(q: ReturnType<typeof render>, key: string, option: string) {
  fireEvent.press(q.getByTestId(`filter-${key}`));
  // By role, because a muscle name is also a group heading down the list.
  fireEvent.press(q.getByRole("button", { name: option }));
}

it("offers the equipment catalog in the picker", async () => {
  mockApi.listEquipment.mockResolvedValue(
    page([equipment("Rogue Ohio Bar", 1), equipment("Concept2 Rower", 2)]),
  );
  const q = render(<Exercises active />);
  await waitFor(() => expect(mockApi.listEquipment).toHaveBeenCalled());

  fireEvent.press(q.getByText("+ New"));
  await q.findByText("New Exercise");
  openEquipment(q);

  expect(q.getByText("Rogue Ohio Bar")).toBeTruthy();
  expect(q.getByText("Concept2 Rower")).toBeTruthy();
  // The catalog replaces the built-in list rather than extending it.
  expect(q.queryByText("Kettlebell")).toBeNull();
});

it("falls back to the built-in options when the catalog is empty", async () => {
  const q = render(<Exercises active />);
  await waitFor(() => expect(mockApi.listEquipment).toHaveBeenCalled());

  fireEvent.press(q.getByText("+ New"));
  await q.findByText("New Exercise");
  openEquipment(q);

  // "Other" is skipped on purpose: PRIMARY_MUSCLES offers it too, so a match
  // would prove nothing about the equipment row.
  for (const opt of EQUIPMENT_OPTIONS.filter((o) => o !== "Other")) {
    expect(q.getByText(opt)).toBeTruthy();
  }
});

it("falls back to the built-in options when the catalog cannot be reached", async () => {
  mockApi.listEquipment.mockRejectedValue(new Error("Network is down"));
  const q = render(<Exercises active />);
  await waitFor(() => expect(mockApi.listEquipment).toHaveBeenCalled());

  fireEvent.press(q.getByText("+ New"));
  await q.findByText("New Exercise");
  openEquipment(q);

  expect(q.getByText("Barbell")).toBeTruthy();
  // A catalog that fails to load is not the exercise list's problem.
  expect(q.queryByText("Network is down")).toBeNull();
});

it("keeps an exercise's own equipment selectable when the catalog dropped it", async () => {
  mockApi.listExercises.mockResolvedValue(
    page([exercise({ name: "Bench Press", equipment: "Retired Bar" })]),
  );
  mockApi.listEquipment.mockResolvedValue(page([equipment("Rogue Ohio Bar", 1)]));

  const q = render(<Exercises active />);
  await waitFor(() => expect(mockApi.listEquipment).toHaveBeenCalled());
  await openEdit(q, "Bench Press");

  // The trigger names the stale value rather than falling back to the
  // placeholder, which would read as an exercise with no equipment at all.
  expect(within(q.getByTestId("equipment-dropdown")).getByText("Retired Bar")).toBeTruthy();

  openEquipment(q);

  // Otherwise the sheet would offer no row matching what the trigger shows, so
  // a user who opened it to browse could never get back to the current value.
  expect(q.getByRole("button", { name: "Retired Bar", selected: true })).toBeTruthy();
  expect(q.getByRole("button", { name: "Rogue Ohio Bar", selected: false })).toBeTruthy();
});

it("saves the equipment name chosen from the catalog", async () => {
  mockApi.listExercises.mockResolvedValue(page([exercise({ id: 5, name: "Bench Press" })]));
  mockApi.listEquipment.mockResolvedValue(page([equipment("Rogue Ohio Bar", 1)]));

  const q = render(<Exercises active />);
  await waitFor(() => expect(mockApi.listEquipment).toHaveBeenCalled());
  await openEdit(q, "Bench Press");

  openEquipment(q);
  fireEvent.press(q.getByText("Rogue Ohio Bar"));
  fireEvent.press(q.getByText("Save"));

  await waitFor(() =>
    expect(mockApi.updateExercise).toHaveBeenCalledWith(
      5,
      expect.objectContaining({ equipment: "Rogue Ohio Bar" }),
    ),
  );
});

it("clears the equipment with the sheet's No equipment entry", async () => {
  mockApi.listExercises.mockResolvedValue(
    page([exercise({ id: 5, name: "Bench Press", equipment: "Rogue Ohio Bar" })]),
  );
  mockApi.listEquipment.mockResolvedValue(page([equipment("Rogue Ohio Bar", 1)]));

  const q = render(<Exercises active />);
  await waitFor(() => expect(mockApi.listEquipment).toHaveBeenCalled());
  await openEdit(q, "Bench Press");

  // Equipment is optional, and a dropdown has no equivalent of tapping the
  // active pill again, so the sheet has to carry its own way to empty it.
  openEquipment(q);
  fireEvent.press(q.getByText("No equipment"));
  fireEvent.press(q.getByText("Save"));

  await waitFor(() =>
    expect(mockApi.updateExercise).toHaveBeenCalledWith(
      5,
      expect.objectContaining({ equipment: undefined }),
    ),
  );
});

// ── Pagination ────────────────────────────────────────────────────────────────

it("asks the API for one page at a time", async () => {
  render(<Exercises active />);

  await waitFor(() =>
    expect(mockApi.listExercises).toHaveBeenCalledWith(
      expect.objectContaining({ page: 1, per_page: PAGE_SIZE }),
    ),
  );
});

it("hides the pager while everything fits on one page", async () => {
  withPages(3);
  const q = render(<Exercises active />);

  await q.findByText("Ex 1");
  // A permanently disabled Prev/Next pair reads as broken rather than as
  // "there is nothing more".
  expect(q.queryByLabelText("Next page")).toBeNull();
});

it("walks to the next page and reports where it is", async () => {
  withPages(60);
  const q = render(<Exercises active />);

  expect(await q.findByText("Page 1 of 3")).toBeTruthy();
  expect(q.getByText("1–25 of 60 exercises")).toBeTruthy();

  fireEvent.press(q.getByLabelText("Next page"));

  expect(await q.findByText("Page 2 of 3")).toBeTruthy();
  expect(q.getByText("Ex 26")).toBeTruthy();
  expect(q.queryByText("Ex 1")).toBeNull();
});

it("walks back to the previous page", async () => {
  withPages(60);
  const q = render(<Exercises active />);

  await q.findByText("Page 1 of 3");
  fireEvent.press(q.getByLabelText("Next page"));
  await q.findByText("Page 2 of 3");

  fireEvent.press(q.getByLabelText("Previous page"));

  expect(await q.findByText("Page 1 of 3")).toBeTruthy();
});

it("follows the API back when the page it asked for no longer exists", async () => {
  withPages(60);
  const q = render(<Exercises active />);
  await q.findByText("Page 1 of 3");

  // Everything past the first page is deleted elsewhere, so the API clamps the
  // page 2 the footer is about to ask for.
  withPages(10);
  fireEvent.press(q.getByLabelText("Next page"));

  // Without following meta.page the screen would sit on page 2 for good, asking
  // for a page that no longer exists on every later load.
  await waitFor(() => expect(mockApi.listExercises).toHaveBeenCalledTimes(3));
  expect(mockApi.listExercises).toHaveBeenLastCalledWith(
    expect.objectContaining({ page: 1 }),
  );
});

it("returns to the first page when the search term changes", async () => {
  withPages(60);
  const q = render(<Exercises active />);
  await q.findByText("Page 1 of 3");
  fireEvent.press(q.getByLabelText("Next page"));
  await q.findByText("Page 2 of 3");

  fireEvent.changeText(q.getByPlaceholderText("Search exercises…"), "bench");

  // Page 2 of "bench" has nothing to do with page 2 of the whole catalog.
  await waitFor(() =>
    expect(mockApi.listExercises).toHaveBeenLastCalledWith(
      expect.objectContaining({ search: "bench", page: 1 }),
    ),
  );
});

// ── Filters ───────────────────────────────────────────────────────────────────

it("sends a chosen filter to the API", async () => {
  const q = render(<Exercises active />);
  await waitFor(() => expect(mockApi.listExercises).toHaveBeenCalled());

  chooseFilter(q, "muscle", "Legs");

  await waitFor(() =>
    expect(mockApi.listExercises).toHaveBeenLastCalledWith(
      expect.objectContaining({ primary_muscle: "Legs" }),
    ),
  );
});

it("filters by an equipment name from the catalog", async () => {
  mockApi.listEquipment.mockResolvedValue(page([equipment("Rogue Ohio Bar", 1)]));
  const q = render(<Exercises active />);
  await waitFor(() => expect(mockApi.listEquipment).toHaveBeenCalled());

  chooseFilter(q, "equipment", "Rogue Ohio Bar");

  await waitFor(() =>
    expect(mockApi.listExercises).toHaveBeenLastCalledWith(
      expect.objectContaining({ equipment: "Rogue Ohio Bar" }),
    ),
  );
});

it("sends the exercise type by value, not by its label", async () => {
  const q = render(<Exercises active />);
  await waitFor(() => expect(mockApi.listExercises).toHaveBeenCalled());

  chooseFilter(q, "type", "Duration");

  await waitFor(() =>
    expect(mockApi.listExercises).toHaveBeenLastCalledWith(
      expect.objectContaining({ exercise_type: "duration" }),
    ),
  );
});

it("returns to the first page when a filter changes", async () => {
  withPages(60);
  const q = render(<Exercises active />);
  await q.findByText("Page 1 of 3");
  fireEvent.press(q.getByLabelText("Next page"));
  await q.findByText("Page 2 of 3");

  chooseFilter(q, "muscle", "Legs");

  await waitFor(() =>
    expect(mockApi.listExercises).toHaveBeenLastCalledWith(
      expect.objectContaining({ primary_muscle: "Legs", page: 1 }),
    ),
  );
});

it("drops every filter at once", async () => {
  const q = render(<Exercises active />);
  await waitFor(() => expect(mockApi.listExercises).toHaveBeenCalled());

  chooseFilter(q, "muscle", "Legs");
  chooseFilter(q, "type", "Duration");
  await waitFor(() => expect(q.getByText("Clear 2 filters")).toBeTruthy());

  fireEvent.press(q.getByText("Clear 2 filters"));

  await waitFor(() =>
    expect(mockApi.listExercises).toHaveBeenLastCalledWith(
      expect.objectContaining({ primary_muscle: undefined, exercise_type: undefined }),
    ),
  );
  expect(q.queryByText("Clear 2 filters")).toBeNull();
});

it("distinguishes an empty filtered result from an empty catalog", async () => {
  const q = render(<Exercises active />);
  await waitFor(() => expect(mockApi.listExercises).toHaveBeenCalled());

  chooseFilter(q, "muscle", "Legs");

  expect(await q.findByText("No matches")).toBeTruthy();
  expect(q.queryByText("No exercises yet")).toBeNull();
});

// ── Equipment pictures in the pickers ─────────────────────────────────────────

/**
 * What the pickers are drawing for `name`.
 *
 * Asserting on EquipmentImage's props rather than on a rendered <Image>: what
 * this screen is responsible for is handing the right item to the right slot,
 * and EquipmentImage.test.tsx already covers which drawing comes out of that.
 *
 * Both pickers are fed by the same renderer and neither is unmounted while its
 * sheet is closed, so this deliberately gathers every match: what is asserted
 * is that nothing on screen draws that name any other way.
 */
function picturesFor(q: ReturnType<typeof render>, name: string) {
  const found = q.UNSAFE_getAllByType(EquipmentImage).filter((n) => n.props.name === name);
  expect(found.length).toBeGreaterThan(0);
  return found.map((n) => n.props);
}

it("draws each catalog item's own picture beside its name in the picker", async () => {
  mockApi.listEquipment.mockResolvedValue(
    page([
      equipment("Concept2 Rower", 1, {
        equipment_type: "Cardio",
        image_url: "http://api.test/api/equipment/1/image?v=1",
      }),
      equipment("Landmine", 2, { thumbnail: "barbell" }),
    ]),
  );
  const q = render(<Exercises active />);
  await waitFor(() => expect(mockApi.listEquipment).toHaveBeenCalled());

  fireEvent.press(q.getByText("+ New"));
  await q.findByText("New Exercise");
  openEquipment(q);

  // The uploaded photo wins, exactly as it does on the Equipment screen.
  for (const picture of picturesFor(q, "Concept2 Rower")) {
    expect(picture).toMatchObject({
      uri: "http://api.test/api/equipment/1/image?v=1",
      equipmentType: "Cardio",
    });
  }
  // And a pinned thumbnail travels with the item, so the picker shows the same
  // drawing the catalog does rather than re-deriving one from the name.
  for (const picture of picturesFor(q, "Landmine")) {
    expect(picture).toMatchObject({ uri: null, thumbnail: "barbell" });
  }
});

it("still draws something for a name the catalog does not hold", async () => {
  // The built-in fallbacks are names with no record behind them; so is a value
  // an exercise kept after its catalog row was deleted. Both draw from the
  // name, with no category to fall back on.
  const q = render(<Exercises active />);
  await waitFor(() => expect(mockApi.listEquipment).toHaveBeenCalled());

  fireEvent.press(q.getByText("+ New"));
  await q.findByText("New Exercise");
  openEquipment(q);

  for (const picture of picturesFor(q, "Kettlebell")) {
    expect(picture).toMatchObject({ uri: null, equipmentType: "", thumbnail: null });
  }
});

it("draws the picture on the filter's trigger too, not only in its sheet", async () => {
  mockApi.listEquipment.mockResolvedValue(
    page([equipment("Rogue Ohio Bar", 1, { equipment_type: "Barbell" })]),
  );
  const q = render(<Exercises active />);
  await waitFor(() => expect(mockApi.listEquipment).toHaveBeenCalled());

  chooseFilter(q, "equipment", "Rogue Ohio Bar");

  // Scoped to the trigger, because the filter bar is where the user reads back
  // what is currently applied — a picture only inside the sheet would vanish
  // the moment the filter took effect.
  const [picture] = q.getByTestId("filter-equipment").findAllByType(EquipmentImage);
  expect(picture.props).toMatchObject({ name: "Rogue Ohio Bar", equipmentType: "Barbell" });
});

it("draws the equipment's picture on the exercise's list row", async () => {
  mockApi.listExercises.mockResolvedValue(
    page([exercise({ name: "Concept2 Row", equipment: "Concept2 Rower" })]),
  );
  mockApi.listEquipment.mockResolvedValue(
    page([equipment("Concept2 Rower", 1, { equipment_type: "Cardio", thumbnail: "rower" })]),
  );
  const q = render(<Exercises active />);
  await q.findByText("Concept2 Row");

  // The row borrows the equipment's picture whole — an exercise has none of
  // its own — so a pinned thumbnail reaches it like anything else.
  for (const picture of picturesFor(q, "Concept2 Rower")) {
    expect(picture).toMatchObject({ uri: null, equipmentType: "Cardio", thumbnail: "rower" });
  }
});

it("draws nothing on the row of an exercise that names no equipment", async () => {
  // The slot is still held — see the row markup — but an empty box in it would
  // read as a picture that failed to load.
  mockApi.listExercises.mockResolvedValue(page([exercise({ name: "Dead Hang", equipment: null })]));
  const q = render(<Exercises active />);
  await q.findByText("Dead Hang");

  expect(q.UNSAFE_queryAllByType(EquipmentImage)).toHaveLength(0);
});
