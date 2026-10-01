import React from "react";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import Equipment from "../Equipment";
import { api, Equipment as EquipmentItem, PageMeta } from "../../api";
import { PAGE_SIZE } from "../../components/Pagination";
import { captureFilePicker, imageFile } from "../../testing/filePicker";
import { page } from "../../testing/page";

jest.mock("../../api", () => ({
  ...jest.requireActual("../../api"),
  api: {
    listEquipment: jest.fn(),
    createEquipment: jest.fn(),
    updateEquipment: jest.fn(),
    deleteEquipment: jest.fn(),
    uploadEquipmentImage: jest.fn(),
    deleteEquipmentImage: jest.fn(),
  },
}));

const mockApi = api as jest.Mocked<typeof api>;

function item(overrides: Partial<EquipmentItem> = {}): EquipmentItem {
  return {
    id: 1,
    name: "Olympic Barbell",
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

function withEquipment(data: EquipmentItem[], meta: Partial<PageMeta> = {}) {
  mockApi.listEquipment.mockResolvedValue(page(data, meta));
}

beforeEach(() => {
  jest.clearAllMocks();
  withEquipment([item()]);
  mockApi.createEquipment.mockResolvedValue(item({ id: 7, name: "Treadmill" }));
  // Echoes the id back, like the real endpoint — the screen attaches the photo
  // to whatever the save returned, so a fixed id here would hide a mix-up.
  mockApi.updateEquipment.mockImplementation((id) => Promise.resolve(item({ id })));
  mockApi.deleteEquipment.mockResolvedValue(undefined);
  mockApi.uploadEquipmentImage.mockResolvedValue(item());
  mockApi.deleteEquipmentImage.mockResolvedValue(item({ image_url: null }));
});

/** Opens the create sheet and waits for the first load to settle. */
async function openCreate(q: ReturnType<typeof render>) {
  await waitFor(() => expect(mockApi.listEquipment).toHaveBeenCalled());
  fireEvent.press(q.getByText("+ New"));
  await q.findByText("New Equipment");
}

// ── List ──────────────────────────────────────────────────────────────────────

it("lists equipment grouped by type", async () => {
  withEquipment([
    item({ id: 1, name: "Olympic Barbell", equipment_type: "Free Weight" }),
    item({ id: 2, name: "Treadmill", equipment_type: "Cardio" }),
  ]);
  const q = render(<Equipment active />);

  expect(await q.findByText("Olympic Barbell")).toBeTruthy();
  expect(q.getByText("Treadmill")).toBeTruthy();
  expect(q.getByText("Free Weight")).toBeTruthy();
  expect(q.getByText("Cardio")).toBeTruthy();
});

it("shows each item's status", async () => {
  withEquipment([item({ status: "broken" })]);
  const q = render(<Equipment active />);

  expect(await q.findByText("Broken")).toBeTruthy();
});

it("invites a first entry when the catalog is empty", async () => {
  withEquipment([]);
  const q = render(<Equipment active />);

  expect(await q.findByText("No equipment yet")).toBeTruthy();
});

it("debounces the search term into the API call", async () => {
  const q = render(<Equipment active />);
  await waitFor(() => expect(mockApi.listEquipment).toHaveBeenCalled());

  fireEvent.changeText(q.getByPlaceholderText("Search equipment…"), "barbell");

  await waitFor(() =>
    expect(mockApi.listEquipment).toHaveBeenCalledWith(
      expect.objectContaining({ search: "barbell" }),
    ),
  );
});

it("distinguishes an empty search result from an empty catalog", async () => {
  const q = render(<Equipment active />);
  await waitFor(() => expect(mockApi.listEquipment).toHaveBeenCalled());

  withEquipment([]);
  fireEvent.changeText(q.getByPlaceholderText("Search equipment…"), "rower");

  expect(await q.findByText("No matches")).toBeTruthy();
  expect(q.queryByText("No equipment yet")).toBeNull();
});

it("surfaces a failed load", async () => {
  mockApi.listEquipment.mockRejectedValue(new Error("Network is down"));
  const q = render(<Equipment active />);

  expect(await q.findByText("Network is down")).toBeTruthy();
});

// ── Create ────────────────────────────────────────────────────────────────────

it("creates an item from the form", async () => {
  const q = render(<Equipment active />);
  await openCreate(q);

  fireEvent.changeText(q.getByPlaceholderText("e.g. Olympic Barbell"), "Treadmill");
  fireEvent.press(q.getByText("Cardio"));
  fireEvent.press(q.getByText("Save"));

  await waitFor(() =>
    expect(mockApi.createEquipment).toHaveBeenCalledWith({
      name: "Treadmill",
      equipment_type: "Cardio",
      status: "active",
      thumbnail: null,
      notes: undefined,
    }),
  );
});

it("refuses to save without a name", async () => {
  const q = render(<Equipment active />);
  await openCreate(q);

  fireEvent.press(q.getByText("Save"));

  expect(await q.findByText("Name is required")).toBeTruthy();
  expect(mockApi.createEquipment).not.toHaveBeenCalled();
});

it("shows a duplicate-name error beside the field", async () => {
  const err = Object.assign(new Error("Validation failed"), {
    status: 422,
    fieldErrors: { name: ["The name has already been taken."] },
  });
  mockApi.createEquipment.mockRejectedValue(err);

  const q = render(<Equipment active />);
  await openCreate(q);
  fireEvent.changeText(q.getByPlaceholderText("e.g. Olympic Barbell"), "Olympic Barbell");
  fireEvent.press(q.getByText("Save"));

  expect(await q.findByText("The name has already been taken.")).toBeTruthy();
});

// ── Edit and delete ───────────────────────────────────────────────────────────

it("opens an existing item prefilled", async () => {
  withEquipment([item({ name: "Treadmill", equipment_type: "Cardio", notes: "Serviced 2026" })]);
  const q = render(<Equipment active />);

  fireEvent.press(await q.findByText("Treadmill"));

  expect(await q.findByText("Edit Equipment")).toBeTruthy();
  expect(q.getByDisplayValue("Treadmill")).toBeTruthy();
  expect(q.getByDisplayValue("Serviced 2026")).toBeTruthy();
});

it("saves an edit against the item's id", async () => {
  withEquipment([item({ id: 12, name: "Treadmill", equipment_type: "Cardio" })]);
  const q = render(<Equipment active />);

  fireEvent.press(await q.findByText("Treadmill"));
  await q.findByText("Edit Equipment");
  fireEvent.press(q.getByText("Broken"));
  fireEvent.press(q.getByText("Save"));

  await waitFor(() =>
    expect(mockApi.updateEquipment).toHaveBeenCalledWith(12, {
      name: "Treadmill",
      equipment_type: "Cardio",
      status: "broken",
      thumbnail: null,
      notes: undefined,
    }),
  );
});

it("deletes an item once the dialog is confirmed", async () => {
  withEquipment([item({ id: 12, name: "Treadmill" })]);
  const q = render(<Equipment active />);

  fireEvent.press(await q.findByText("Treadmill"));
  await q.findByText("Edit Equipment");
  fireEvent.press(q.getByText("Delete Equipment"));

  // The confirmation is a separate step — nothing is sent until it is accepted.
  await q.findByText(/Exercises that name it keep the label/);
  expect(mockApi.deleteEquipment).not.toHaveBeenCalled();

  fireEvent.press(q.getByText("Delete"));
  await waitFor(() => expect(mockApi.deleteEquipment).toHaveBeenCalledWith(12));
});

// ── Photo ─────────────────────────────────────────────────────────────────────

it("offers to remove the photo only when there is one", async () => {
  withEquipment([
    item({ id: 1, name: "With Photo", image_url: "http://api.test/api/equipment/1/image?v=1" }),
    item({ id: 2, name: "No Photo", image_url: null }),
  ]);
  const q = render(<Equipment active />);

  fireEvent.press(await q.findByText("No Photo"));
  await q.findByText("Edit Equipment");
  expect(q.getByText("Choose photo…")).toBeTruthy();
  expect(q.queryByText("Remove photo")).toBeNull();

  fireEvent.press(q.getByText("Cancel"));
  fireEvent.press(await q.findByText("With Photo"));
  await q.findByText("Edit Equipment");
  expect(q.getByText("Replace photo…")).toBeTruthy();
  expect(q.getByText("Remove photo")).toBeTruthy();
});

it("says the picture is a stand-in until a real photo is uploaded", async () => {
  withEquipment([
    item({ id: 1, name: "With Photo", image_url: "http://api.test/api/equipment/1/image?v=1" }),
    item({ id: 2, name: "No Photo", image_url: null }),
  ]);
  const q = render(<Equipment active />);

  fireEvent.press(await q.findByText("No Photo"));
  await q.findByText("Edit Equipment");
  expect(q.getByText(/showing the thumbnail below/i)).toBeTruthy();

  fireEvent.press(q.getByText("Cancel"));
  fireEvent.press(await q.findByText("With Photo"));
  await q.findByText("Edit Equipment");
  expect(q.queryByText(/showing the thumbnail below/i)).toBeNull();
  // The picker is still there and still live — the thumbnail outlives the
  // photo, so setting one now is not a wasted trip.
  expect(q.getByText(/Shown if the photo is removed/i)).toBeTruthy();
  expect(q.getByTestId("thumbnail-tile-rower").props.accessibilityState.disabled).toBe(false);
});

// ── Thumbnail ─────────────────────────────────────────────────────────────────

it("saves the picked thumbnail with the rest of the form", async () => {
  const q = render(<Equipment active />);
  await openCreate(q);

  fireEvent.changeText(q.getByPlaceholderText("e.g. Olympic Barbell"), "Landmine");
  fireEvent.press(q.getByTestId("thumbnail-tile-barbell"));
  fireEvent.press(q.getByText("Save"));

  await waitFor(() =>
    expect(mockApi.createEquipment).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Landmine", thumbnail: "barbell" }),
    ),
  );
});

it("sends no thumbnail at all when the choice is left automatic", async () => {
  const q = render(<Equipment active />);
  await openCreate(q);

  fireEvent.changeText(q.getByPlaceholderText("e.g. Olympic Barbell"), "Treadmill");
  fireEvent.press(q.getByText("Save"));

  await waitFor(() =>
    expect(mockApi.createEquipment).toHaveBeenCalledWith(
      expect.objectContaining({ thumbnail: null }),
    ),
  );
});

it("opens an item on the thumbnail it was saved with", async () => {
  withEquipment([item({ id: 4, name: "Landmine", thumbnail: "barbell" })]);
  const q = render(<Equipment active />);

  fireEvent.press(await q.findByText("Landmine"));
  await q.findByText("Edit Equipment");

  expect(q.getByTestId("thumbnail-tile-barbell").props.accessibilityState.selected).toBe(true);
  expect(q.getByTestId("thumbnail-tile-auto").props.accessibilityState.selected).toBe(false);
});

it("hands the choice back to the name when Automatic is picked again", async () => {
  withEquipment([item({ id: 4, name: "Landmine", thumbnail: "barbell" })]);
  const q = render(<Equipment active />);

  fireEvent.press(await q.findByText("Landmine"));
  await q.findByText("Edit Equipment");
  fireEvent.press(q.getByTestId("thumbnail-tile-auto"));
  fireEvent.press(q.getByText("Save"));

  // Null, not omitted: clearing has to be a value the API can act on.
  await waitFor(() =>
    expect(mockApi.updateEquipment).toHaveBeenCalledWith(4, expect.objectContaining({ thumbnail: null })),
  );
});

it("does not carry one item's thumbnail into the next sheet", async () => {
  withEquipment([
    item({ id: 4, name: "Landmine", thumbnail: "barbell" }),
    item({ id: 5, name: "Sled", thumbnail: null }),
  ]);
  const q = render(<Equipment active />);

  fireEvent.press(await q.findByText("Landmine"));
  await q.findByText("Edit Equipment");
  fireEvent.press(q.getByText("Cancel"));

  fireEvent.press(await q.findByText("Sled"));
  await q.findByText("Edit Equipment");
  expect(q.getByTestId("thumbnail-tile-auto").props.accessibilityState.selected).toBe(true);

  fireEvent.press(q.getByText("Cancel"));
  fireEvent.press(q.getByText("+ New"));
  await q.findByText("New Equipment");
  expect(q.getByTestId("thumbnail-tile-auto").props.accessibilityState.selected).toBe(true);
});

it("drops a stored thumbnail it cannot draw rather than sending it back", async () => {
  // Reachable if an art key is ever retired; the API validates a closed set, so
  // echoing the old key back would fail the save.
  withEquipment([item({ id: 6, name: "Landmine", thumbnail: "hovercraft" })]);
  const q = render(<Equipment active />);

  fireEvent.press(await q.findByText("Landmine"));
  await q.findByText("Edit Equipment");
  expect(q.getByTestId("thumbnail-tile-auto").props.accessibilityState.selected).toBe(true);

  fireEvent.press(q.getByText("Save"));
  await waitFor(() =>
    expect(mockApi.updateEquipment).toHaveBeenCalledWith(6, expect.objectContaining({ thumbnail: null })),
  );
});

it("clears the photo on save after Remove is pressed", async () => {
  withEquipment([
    item({ id: 3, name: "Treadmill", image_url: "http://api.test/api/equipment/3/image?v=1" }),
  ]);
  const q = render(<Equipment active />);

  fireEvent.press(await q.findByText("Treadmill"));
  await q.findByText("Edit Equipment");
  fireEvent.press(q.getByText("Remove photo"));

  // Removal is staged, not immediate — Cancel must be able to back out of it.
  expect(mockApi.deleteEquipmentImage).not.toHaveBeenCalled();
  expect(q.queryByText("Remove photo")).toBeNull();

  fireEvent.press(q.getByText("Save"));
  await waitFor(() => expect(mockApi.deleteEquipmentImage).toHaveBeenCalledWith(3));
});

it("discards a staged photo removal when the sheet is cancelled", async () => {
  withEquipment([
    item({ id: 3, name: "Treadmill", image_url: "http://api.test/api/equipment/3/image?v=1" }),
  ]);
  const q = render(<Equipment active />);

  fireEvent.press(await q.findByText("Treadmill"));
  await q.findByText("Edit Equipment");
  fireEvent.press(q.getByText("Remove photo"));
  fireEvent.press(q.getByText("Cancel"));

  fireEvent.press(await q.findByText("Treadmill"));
  await q.findByText("Edit Equipment");
  expect(q.getByText("Remove photo")).toBeTruthy();
});

// ── Pagination and filters ────────────────────────────────────────────────────

/**
 * Serve `total` items the way the API does — one page per request, with a page
 * number clamped to the last one that exists.
 */
function withPages(total: number) {
  mockApi.listEquipment.mockImplementation(async (q) => {
    const perPage = q?.per_page ?? total;
    const lastPage = Math.max(1, Math.ceil(total / perPage));
    const current = Math.min(Math.max(q?.page ?? 1, 1), lastPage);
    const offset = (current - 1) * perPage;
    const rows = Array.from({ length: Math.max(0, Math.min(perPage, total - offset)) }, (_, i) =>
      item({ id: offset + i + 1, name: `Kit ${offset + i + 1}` }),
    );
    return page(rows, {
      page: current,
      per_page: perPage,
      total,
      last_page: lastPage,
      from: rows.length ? offset + 1 : null,
      to: rows.length ? offset + rows.length : null,
    });
  });
}

/** Picks `option` out of one of the filter dropdowns above the list. */
function chooseFilter(q: ReturnType<typeof render>, key: string, option: string) {
  fireEvent.press(q.getByTestId(`filter-${key}`));
  // By role, because a type name is also a group heading down the list.
  fireEvent.press(q.getByRole("button", { name: option }));
}

it("asks the API for one page at a time", async () => {
  render(<Equipment active />);

  await waitFor(() =>
    expect(mockApi.listEquipment).toHaveBeenCalledWith(
      expect.objectContaining({ page: 1, per_page: PAGE_SIZE }),
    ),
  );
});

it("hides the pager while everything fits on one page", async () => {
  const q = render(<Equipment active />);

  await q.findByText("Olympic Barbell");
  expect(q.queryByLabelText("Next page")).toBeNull();
});

it("walks to the next page and reports where it is", async () => {
  withPages(60);
  const q = render(<Equipment active />);

  expect(await q.findByText("Page 1 of 3")).toBeTruthy();
  expect(q.getByText("1–25 of 60 items")).toBeTruthy();

  fireEvent.press(q.getByLabelText("Next page"));

  expect(await q.findByText("Page 2 of 3")).toBeTruthy();
  expect(q.getByText("Kit 26")).toBeTruthy();
  expect(q.queryByText("Kit 1")).toBeNull();
});

it("follows the API back when the page it asked for no longer exists", async () => {
  withPages(60);
  const q = render(<Equipment active />);
  await q.findByText("Page 1 of 3");

  withPages(10);
  fireEvent.press(q.getByLabelText("Next page"));

  await waitFor(() => expect(mockApi.listEquipment).toHaveBeenCalledTimes(3));
  expect(mockApi.listEquipment).toHaveBeenLastCalledWith(
    expect.objectContaining({ page: 1 }),
  );
});

it("sends the status filter by value, not by its label", async () => {
  const q = render(<Equipment active />);
  await waitFor(() => expect(mockApi.listEquipment).toHaveBeenCalled());

  chooseFilter(q, "status", "Wishlist");

  await waitFor(() =>
    expect(mockApi.listEquipment).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "wishlist" }),
    ),
  );
});

it("returns to the first page when a filter changes", async () => {
  withPages(60);
  const q = render(<Equipment active />);
  await q.findByText("Page 1 of 3");
  fireEvent.press(q.getByLabelText("Next page"));
  await q.findByText("Page 2 of 3");

  chooseFilter(q, "type", "Cardio");

  await waitFor(() =>
    expect(mockApi.listEquipment).toHaveBeenLastCalledWith(
      expect.objectContaining({ equipment_type: "Cardio", page: 1 }),
    ),
  );
});

it("drops every filter at once", async () => {
  const q = render(<Equipment active />);
  await waitFor(() => expect(mockApi.listEquipment).toHaveBeenCalled());

  chooseFilter(q, "type", "Cardio");
  chooseFilter(q, "status", "Wishlist");
  await waitFor(() => expect(q.getByText("Clear 2 filters")).toBeTruthy());

  fireEvent.press(q.getByText("Clear 2 filters"));

  await waitFor(() =>
    expect(mockApi.listEquipment).toHaveBeenLastCalledWith(
      expect.objectContaining({ equipment_type: undefined, status: undefined }),
    ),
  );
  expect(q.queryByText("Clear 2 filters")).toBeNull();
});

it("distinguishes an empty filtered result from an empty catalog", async () => {
  const q = render(<Equipment active />);
  await waitFor(() => expect(mockApi.listEquipment).toHaveBeenCalled());

  withEquipment([]);
  chooseFilter(q, "status", "Wishlist");

  expect(await q.findByText("No matches")).toBeTruthy();
  expect(q.queryByText("No equipment yet")).toBeNull();
});

// ── Photo ─────────────────────────────────────────────────────────────────────

/**
 * Reachable from a test for the first time in Phase 7.0. Everything below
 * `pickImage`'s `Platform.OS` check — the DOM input, the object URL, the staged
 * file that only travels on save — had only ever run in a browser.
 */
it("stages the chosen photo without uploading it, then sends it once the row exists", async () => {
  const picker = captureFilePicker();
  const q = render(<Equipment active />);
  await openCreate(q);

  fireEvent.changeText(q.getByPlaceholderText("e.g. Olympic Barbell"), "Treadmill");
  fireEvent.press(q.getByText("Choose photo…"));

  expect(picker.input.accept).toBe("image/jpeg,image/png,image/webp");

  const file = imageFile();
  await picker.choose(file);

  // The slot shows the pick, and nothing has been sent: a photo cannot be
  // attached to a row that does not exist yet.
  const shown = q.getByTestId("equipment-photo-photo").props.source as { uri: string };
  expect(shown.uri).toBe("blob:test/rack.jpg");
  expect(q.getByText("Replace photo…")).toBeTruthy();
  expect(mockApi.uploadEquipmentImage).not.toHaveBeenCalled();

  fireEvent.press(q.getByText("Save"));

  // Create first, then the photo against the id it came back with.
  await waitFor(() => expect(mockApi.uploadEquipmentImage).toHaveBeenCalledWith(7, file));
  expect(mockApi.createEquipment).toHaveBeenCalledTimes(1);
});

it("drops a staged photo when the sheet is cancelled", async () => {
  const picker = captureFilePicker();
  const q = render(<Equipment active />);
  await openCreate(q);

  fireEvent.press(q.getByText("Choose photo…"));
  await picker.choose(imageFile());
  fireEvent.press(q.getByText("Cancel"));

  await openCreate(q);

  expect(q.getByText("Choose photo…")).toBeTruthy();
  expect(q.queryByTestId("equipment-photo-photo")).toBeNull();
});
