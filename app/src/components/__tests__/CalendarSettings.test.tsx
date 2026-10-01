import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react-native";
import CalendarSettings, { feedStatus } from "../CalendarSettings";
import { CalendarFeed, api } from "../../api";

/**
 * Settings → Calendars.
 *
 * The properties worth holding are the ones about the address, because it is a
 * secret: it goes in once, the box empties the moment it is stored, and a
 * refusal leaves it in the box to be corrected rather than pasted again. The
 * rest is ordinary CRUD, asserted at the request it makes.
 */

jest.mock("../../api", () => ({
  ...jest.requireActual("../../api"),
  api: {
    listCalendarFeeds: jest.fn(),
    addCalendarFeed: jest.fn(),
    updateCalendarFeed: jest.fn(),
    removeCalendarFeed: jest.fn(),
  },
}));

const mockApi = api as jest.Mocked<typeof api>;

const ADDRESS = "https://calendar.google.com/calendar/ical/me%40gmail.com/private-a1b2c3/basic.ics";

const WORK: CalendarFeed = {
  id: 1,
  name: "Work",
  color: "peacock",
  enabled: true,
  status: "ok",
  message: null,
  fetched_at: new Date(Date.now() - 120_000).toISOString(),
  skipped: 0,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockApi.listCalendarFeeds.mockResolvedValue({ data: [WORK] });
});

async function renderIt(props: Partial<React.ComponentProps<typeof CalendarSettings>> = {}) {
  const onChanged = jest.fn();
  render(<CalendarSettings onChanged={onChanged} {...props} />);
  await act(async () => {});

  return { onChanged };
}

describe("the list", () => {
  it("shows each calendar with how its last read went", async () => {
    await renderIt();

    const row = within(screen.getByTestId("calendar-feed-1"));
    expect(row.getByText("Work")).toBeTruthy();
    expect(row.getByText("Read 2m ago.")).toBeTruthy();
  });

  it("reads only while Settings is open, and again each time it opens", async () => {
    // The overlay stays mounted while shut; a list loaded when the HUD first
    // drew would be stale the first time anyone looked.
    const { rerender } = render(<CalendarSettings active={false} />);
    await act(async () => {});
    expect(mockApi.listCalendarFeeds).not.toHaveBeenCalled();

    rerender(<CalendarSettings active />);
    await act(async () => {});
    expect(mockApi.listCalendarFeeds).toHaveBeenCalledTimes(1);

    rerender(<CalendarSettings active={false} />);
    rerender(<CalendarSettings active />);
    await act(async () => {});
    expect(mockApi.listCalendarFeeds).toHaveBeenCalledTimes(2);
  });

  it("never has the address to show, and does not ask for it", async () => {
    await renderIt();

    // Nothing on the row can be the address, because the API never sends it.
    expect(screen.queryByText(/calendar\.google\.com\/calendar\/ical/)).toBeNull();
  });
});

describe("where the address comes from", () => {
  it("says where Google, iCloud and Outlook each keep it", async () => {
    await renderIt();

    // iCloud is the reason this is not Google-only: a calendar subscribed to
    // inside Google has no secret address there, so its link has to come from
    // iCloud itself.
    const howTo = within(screen.getByTestId("calendar-how-to"));
    expect(howTo.getByText(/Secret address in iCal format/)).toBeTruthy();
    expect(howTo.getByText(/Public Calendar → copy the webcal:\/\/ link/)).toBeTruthy();
    expect(howTo.getByText(/Publish a calendar/)).toBeTruthy();
  });

  it("takes an iCloud webcal link as it was copied", async () => {
    const icloud = "webcal://p52-caldav.icloud.com/published/2/MTIzNDU2Nzg5MDEy";
    mockApi.addCalendarFeed.mockResolvedValue({ ...WORK, id: 2, name: "Family" });
    await renderIt();

    fireEvent.changeText(screen.getByTestId("calendar-url"), icloud);
    fireEvent.press(screen.getByTestId("calendar-add"));
    await act(async () => {});

    // The server rewrites it to https; the form does not second-guess it.
    expect(mockApi.addCalendarFeed).toHaveBeenCalledWith(icloud);
    expect(screen.getByText("Family")).toBeTruthy();
  });
});

describe("adding one", () => {
  it("posts the address, lists what comes back, and empties the box", async () => {
    mockApi.listCalendarFeeds.mockResolvedValue({ data: [] });
    mockApi.addCalendarFeed.mockResolvedValue({ ...WORK, id: 2, name: "Home", color: "flamingo" });
    const { onChanged } = await renderIt();

    fireEvent.changeText(screen.getByTestId("calendar-url"), `  ${ADDRESS}  `);
    fireEvent.press(screen.getByTestId("calendar-add"));
    await act(async () => {});

    expect(mockApi.addCalendarFeed).toHaveBeenCalledWith(ADDRESS);
    expect(screen.getByText("Home")).toBeTruthy();
    // Cleared the moment it is stored: the address is not something this
    // screen holds on to, even in a text box.
    expect(screen.getByTestId("calendar-url").props.value).toBe("");
    expect(onChanged).toHaveBeenCalled();
  });

  it("says it is checking while the server fetches the address", async () => {
    let resolve!: (feed: CalendarFeed) => void;
    mockApi.addCalendarFeed.mockReturnValue(new Promise((r) => (resolve = r)));
    await renderIt();

    fireEvent.changeText(screen.getByTestId("calendar-url"), ADDRESS);
    fireEvent.press(screen.getByTestId("calendar-add"));

    expect(screen.getByText("Checking…")).toBeTruthy();
    expect(screen.getByTestId("calendar-url").props.editable).toBe(false);

    await act(async () => resolve({ ...WORK, id: 2 }));
    expect(screen.getByText("Add calendar")).toBeTruthy();
  });

  it("keeps the address in the box when it is refused, with the server's sentence", async () => {
    const refusal = Object.assign(
      new Error("The calendar no longer recognises this address. It may have been reset or stopped being shared; add the new address."),
      { status: 422 },
    );
    mockApi.addCalendarFeed.mockRejectedValue(refusal);
    const { onChanged } = await renderIt();

    fireEvent.changeText(screen.getByTestId("calendar-url"), ADDRESS);
    fireEvent.press(screen.getByTestId("calendar-add"));
    await act(async () => {});

    expect(screen.getByText(/no longer recognises this address/)).toBeTruthy();
    expect(screen.getByTestId("calendar-url").props.value).toBe(ADDRESS);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("does nothing with an empty box", async () => {
    await renderIt();

    fireEvent.changeText(screen.getByTestId("calendar-url"), "   ");
    fireEvent.press(screen.getByTestId("calendar-add"));

    expect(mockApi.addCalendarFeed).not.toHaveBeenCalled();
  });
});

describe("changing one", () => {
  it("switches a calendar off", async () => {
    mockApi.updateCalendarFeed.mockResolvedValue({ ...WORK, enabled: false });
    const { onChanged } = await renderIt();

    fireEvent(screen.getByTestId("calendar-toggle-1"), "valueChange", false);
    await act(async () => {});

    expect(mockApi.updateCalendarFeed).toHaveBeenCalledWith(1, { enabled: false });
    expect(screen.getByText("Switched off — not on the agenda.")).toBeTruthy();
    expect(onChanged).toHaveBeenCalled();
  });

  it("offers Google's eleven colours by name, with the current one chosen", async () => {
    await renderIt();

    const radios = within(screen.getByLabelText("Work colour")).getAllByRole("radio");
    expect(radios).toHaveLength(11);
    expect(screen.getByLabelText("Peacock").props.accessibilityState.selected).toBe(true);
    expect(screen.getByLabelText("Blueberry").props.accessibilityState.selected).toBe(false);
  });

  it("recolours a calendar", async () => {
    mockApi.updateCalendarFeed.mockResolvedValue({ ...WORK, color: "grape" });
    await renderIt();

    fireEvent.press(screen.getByLabelText("Grape"));
    await act(async () => {});

    expect(mockApi.updateCalendarFeed).toHaveBeenCalledWith(1, { color: "grape" });
    expect(screen.getByLabelText("Grape").props.accessibilityState.selected).toBe(true);
  });

  it("says so on the row when a change is refused", async () => {
    mockApi.updateCalendarFeed.mockRejectedValue(new Error("HTTP 500: nope"));
    await renderIt();

    fireEvent.press(screen.getByLabelText("Grape"));
    await act(async () => {});

    expect(within(screen.getByTestId("calendar-feed-1")).getByText("HTTP 500: nope")).toBeTruthy();
  });
});

describe("removing one", () => {
  it("asks first, because adding it back needs the secret again", async () => {
    await renderIt();

    fireEvent.press(screen.getByLabelText("Remove Work"));

    expect(screen.getByText("Remove Work?")).toBeTruthy();
    expect(mockApi.removeCalendarFeed).not.toHaveBeenCalled();
  });

  it("removes it on confirmation", async () => {
    mockApi.removeCalendarFeed.mockResolvedValue();
    const { onChanged } = await renderIt();

    fireEvent.press(screen.getByLabelText("Remove Work"));
    // The row's own button says Remove too; the dialog's is the last one drawn.
    const confirm = screen.getAllByText("Remove");
    fireEvent.press(confirm[confirm.length - 1]);
    await waitFor(() => expect(mockApi.removeCalendarFeed).toHaveBeenCalledWith(1));

    await waitFor(() => expect(screen.queryByTestId("calendar-feed-1")).toBeNull());
    expect(onChanged).toHaveBeenCalled();
  });
});

describe("feedStatus", () => {
  const now = new Date("2026-09-10T05:00:00+00:00");
  const at = "2026-09-10T04:55:00+00:00";

  it("says when it was read", () => {
    expect(feedStatus({ ...WORK, fetched_at: at }, now)).toBe("Read 5m ago.");
  });

  it("says how many events in it could not be read", () => {
    expect(feedStatus({ ...WORK, fetched_at: at, skipped: 2 }, now)).toBe(
      "Read 5m ago. 2 events in it could not be read.",
    );
  });

  it("shows the server's own sentence for a failure", () => {
    expect(feedStatus({ ...WORK, status: "failed", message: "The calendar answered 500." }, now)).toBe(
      "The calendar answered 500.",
    );
  });

  it("falls back to a sentence naming no provider", () => {
    expect(feedStatus({ ...WORK, status: "failed", message: null }, now)).toBe("This calendar could not be read.");
  });

  it("puts switched off ahead of a failure nobody is asking about any more", () => {
    expect(feedStatus({ ...WORK, enabled: false, status: "failed", message: "x" }, now)).toBe(
      "Switched off — not on the agenda.",
    );
  });

  it("says a calendar nobody has read yet has not been read", () => {
    expect(feedStatus({ ...WORK, status: "pending", fetched_at: null }, now)).toBe("Not read yet.");
  });
});
