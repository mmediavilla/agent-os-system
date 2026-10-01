import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import AutomationsView, { lastRun } from "../AutomationsView";
import { ApiError, Automation, api } from "../../api";

/**
 * Automations: the conversations the assistant opens on its own.
 *
 * What matters is that nothing is drawn as saved before the server says so — a
 * time that looked stored and was not is a greeting that fails to arrive at an
 * hour nobody is watching — that a half-typed field survives the re-reads every
 * write and every Run-now poll makes, and that deleting one asks first.
 */

jest.mock("../../api", () => ({
  ...jest.requireActual("../../api"),
  api: {
    listAutomations: jest.fn(),
    createAutomation: jest.fn(),
    updateAutomation: jest.fn(),
    deleteAutomation: jest.fn(),
    runAutomation: jest.fn(),
  },
}));

const mockApi = api as jest.Mocked<typeof api>;

const row = (extra: Partial<Automation> = {}): Automation => ({
  id: 1,
  name: "Morning greeting",
  time: "06:30",
  intent: "Say good morning and read the day out.",
  context: ["agenda", "weather"],
  enabled: true,
  last_run_on: null,
  last_run_at: null,
  last_outcome: null,
  last_error: null,
  last_conversation_id: null,
  ...extra,
});

const apiError = (status: number, message: string) => Object.assign(new Error(message), { status }) as ApiError;

const list = (data: Automation[]) => ({ data });

beforeEach(() => {
  // Reset, not clear: a queued `Once` answer must not leak into the next test.
  jest.resetAllMocks();
  mockApi.listAutomations.mockResolvedValue(list([row()]));
  mockApi.updateAutomation.mockResolvedValue(row());
  mockApi.createAutomation.mockResolvedValue(row({ id: 2 }));
  mockApi.deleteAutomation.mockResolvedValue(undefined);
  mockApi.runAutomation.mockResolvedValue({ dispatched: true });
});

it("reads on arrival and not before", async () => {
  const view = render(<AutomationsView active={false} />);
  expect(mockApi.listAutomations).not.toHaveBeenCalled();

  view.rerender(<AutomationsView active />);
  await waitFor(() => expect(mockApi.listAutomations).toHaveBeenCalledTimes(1));
});

it("draws a row, what it brings, and that facts are not a choice", async () => {
  render(<AutomationsView active />);
  await screen.findByTestId("automation-1");

  expect(screen.getByTestId("automation-1-name").props.value).toBe("Morning greeting");
  expect(screen.getByTestId("automation-1-time").props.value).toBe("06:30");
  expect(screen.getByTestId("automation-1-enabled").props.value).toBe(true);
  expect(screen.getByTestId("automation-1-context-agenda").props.value).toBe(true);
  expect(screen.getByTestId("automation-1-context-training").props.value).toBe(false);

  // Facts are in the system prompt on every turn, so the runner fetches nothing
  // for them: a switch here would be a control that changes nothing.
  expect(screen.getByTestId("automation-1-context-facts")).toBeTruthy();
  expect(screen.queryByLabelText("Facts")).toBeNull();
});

it("says so when there is nothing scheduled", async () => {
  mockApi.listAutomations.mockResolvedValue(list([]));
  render(<AutomationsView active />);

  expect(await screen.findByTestId("automations-empty")).toBeTruthy();
  // The add card is still there: an empty page with no way off it is a dead end.
  expect(screen.getByTestId("automation-new")).toBeTruthy();
});

/**
 * The field is a picker now, and the one thing a picker can hand back that a
 * time is not is nothing at all — cleared. That is a clear, not a mistake, so
 * the stored time goes back and nothing is written, the way an emptied name or
 * intent does.
 */
it("puts the stored time back when the field is cleared", async () => {
  render(<AutomationsView active />);
  await screen.findByTestId("automation-1");

  const time = screen.getByTestId("automation-1-time");

  fireEvent.changeText(time, "");
  fireEvent(time, "blur");

  expect(screen.getByTestId("automation-1-time").props.value).toBe("06:30");
  expect(mockApi.updateAutomation).not.toHaveBeenCalled();
  expect(screen.queryByText("Use a 24-hour time, like 06:30.")).toBeNull();
});

it("writes a time only once it is a time, and only when it changed", async () => {
  render(<AutomationsView active />);
  await screen.findByTestId("automation-1");

  const time = screen.getByTestId("automation-1-time");

  fireEvent.changeText(time, "half six");
  fireEvent(time, "blur");
  expect(mockApi.updateAutomation).not.toHaveBeenCalled();
  expect(screen.getByText("Use a 24-hour time, like 06:30.")).toBeTruthy();

  // "7:05" and "07:05" are the same time, and the same time is not a write.
  fireEvent.changeText(time, "06:30");
  fireEvent(time, "blur");
  expect(mockApi.updateAutomation).not.toHaveBeenCalled();

  mockApi.updateAutomation.mockResolvedValue(row({ time: "07:05" }));
  fireEvent.changeText(time, "7:05");
  await act(async () => {
    fireEvent(time, "blur");
  });
  expect(mockApi.updateAutomation).toHaveBeenCalledWith(1, { time: "07:05" });
});

it("redraws from the answer rather than from what was typed", async () => {
  render(<AutomationsView active />);
  await screen.findByTestId("automation-1");

  // The server is the one that says what is stored. A rename it silently
  // trimmed, or refused, must not be left on screen looking saved.
  mockApi.updateAutomation.mockResolvedValue(row({ name: "Morning greeting" }));
  mockApi.listAutomations.mockResolvedValue(list([row({ name: "Morning greeting" })]));

  const name = screen.getByTestId("automation-1-name");
  fireEvent.changeText(name, "Evening wrap-up");
  await act(async () => {
    fireEvent(name, "blur");
  });

  expect(screen.getByTestId("automation-1-name").props.value).toBe("Morning greeting");
});

it("puts an empty name back rather than sending a 422", async () => {
  render(<AutomationsView active />);
  await screen.findByTestId("automation-1");

  const name = screen.getByTestId("automation-1-name");
  fireEvent.changeText(name, "   ");
  await act(async () => {
    fireEvent(name, "blur");
  });

  expect(mockApi.updateAutomation).not.toHaveBeenCalled();
  expect(screen.getByTestId("automation-1-name").props.value).toBe("Morning greeting");
});

it("keeps anything it does not offer when a context piece is toggled", async () => {
  mockApi.listAutomations.mockResolvedValue(list([row({ context: ["agenda", "facts"] })]));
  render(<AutomationsView active />);
  await screen.findByTestId("automation-1");

  await act(async () => {
    fireEvent(screen.getByTestId("automation-1-context-weather"), "valueChange", true);
  });

  // `facts` has no control, so it can only survive by being read out of the row.
  expect(mockApi.updateAutomation).toHaveBeenCalledWith(1, { context: ["agenda", "weather", "facts"] });
});

it("offers deadlines, in the server's order, and keeps them when another piece is toggled", async () => {
  // The toggles rebuild the array from `AUTOMATION_CONTEXT`, so a piece the
  // server accepts and this list lacked would be dropped by the first click.
  mockApi.listAutomations.mockResolvedValue(list([row({ context: ["agenda", "deadlines"] })]));
  render(<AutomationsView active />);
  await screen.findByTestId("automation-1");

  expect(screen.getByTestId("automation-1-context-deadlines").props.value).toBe(true);

  await act(async () => {
    fireEvent(screen.getByTestId("automation-1-context-training"), "valueChange", true);
  });

  expect(mockApi.updateAutomation).toHaveBeenCalledWith(1, { context: ["agenda", "training", "deadlines"] });
});

it("offers the news, and keeps it when another piece is toggled", async () => {
  mockApi.listAutomations.mockResolvedValue(list([row({ context: ["weather", "news"] })]));
  render(<AutomationsView active />);
  await screen.findByTestId("automation-1");

  expect(screen.getByTestId("automation-1-context-news").props.value).toBe(true);

  await act(async () => {
    fireEvent(screen.getByTestId("automation-1-context-deadlines"), "valueChange", true);
  });

  expect(mockApi.updateAutomation).toHaveBeenCalledWith(1, { context: ["weather", "deadlines", "news"] });
});

it("says why a write failed, on the card it came from", async () => {
  mockApi.updateAutomation.mockRejectedValue(apiError(422, "The time must be 24-hour HH:MM, like 06:30."));
  render(<AutomationsView active />);
  await screen.findByTestId("automation-1");

  await act(async () => {
    fireEvent(screen.getByTestId("automation-1-enabled"), "valueChange", false);
  });

  expect(screen.getByText("The time must be 24-hour HH:MM, like 06:30.")).toBeTruthy();
});

it("shows a failed run's own reason", async () => {
  mockApi.listAutomations.mockResolvedValue(
    list([row({ last_run_at: "2026-09-24T06:30:00+00:00", last_outcome: "failed", last_error: "No key." })]),
  );
  render(<AutomationsView active />);
  await screen.findByTestId("automation-1");

  expect(screen.getByText("No key.")).toBeTruthy();
});

it("asks before deleting one", async () => {
  render(<AutomationsView active />);
  await screen.findByTestId("automation-1");

  fireEvent.press(screen.getByLabelText("Delete Morning greeting"));
  expect(mockApi.deleteAutomation).not.toHaveBeenCalled();
  expect(screen.getByText("Delete Morning greeting?")).toBeTruthy();

  mockApi.listAutomations.mockResolvedValue(list([]));
  await act(async () => {
    // The card's own button and the dialog's both say Delete; this is the dialog's.
    fireEvent.press(screen.getAllByText("Delete").at(-1)!);
  });

  expect(mockApi.deleteAutomation).toHaveBeenCalledWith(1);
  expect(screen.queryByTestId("automation-1")).toBeNull();
});

it("adds one switched off", async () => {
  mockApi.listAutomations.mockResolvedValue(list([]));
  render(<AutomationsView active />);
  await screen.findByTestId("automation-new");

  fireEvent.changeText(screen.getByTestId("automation-new-name"), "Evening wrap-up");
  fireEvent.changeText(screen.getByTestId("automation-new-time"), "18:30");
  fireEvent.changeText(screen.getByTestId("automation-new-intent"), "Ask how the day went.");

  await act(async () => {
    fireEvent.press(screen.getByLabelText("Add automation"));
  });

  // Off, like the seeded row: a conversation that starts arriving before its
  // intent has been read back is a surprise.
  expect(mockApi.createAutomation).toHaveBeenCalledWith({
    name: "Evening wrap-up",
    time: "18:30",
    intent: "Ask how the day went.",
    context: ["agenda"],
    enabled: false,
  });
  expect(screen.getByTestId("automation-new-name").props.value).toBe("");
});

describe("Run now", () => {
  afterEach(() => jest.useRealTimers());

  it("waits for the worker, and stops the moment the row moves", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "queueMicrotask"] });
    render(<AutomationsView active />);
    await act(async () => {});

    await act(async () => {
      fireEvent.press(screen.getByLabelText("Run Morning greeting now"));
    });

    expect(mockApi.runAutomation).toHaveBeenCalledWith(1);
    // The endpoint answers when the job is queued; the outcome is a worker's.
    expect(screen.getByText("waiting on the worker…")).toBeTruthy();

    const reads = mockApi.listAutomations.mock.calls.length;
    await act(async () => {
      jest.advanceTimersByTime(3_500);
    });
    expect(mockApi.listAutomations.mock.calls.length).toBe(reads + 1);

    mockApi.listAutomations.mockResolvedValue(
      list([row({ last_run_at: "2026-09-24T06:30:00+00:00", last_outcome: "ok", last_conversation_id: 9 })]),
    );
    await act(async () => {
      jest.advanceTimersByTime(3_500);
    });
    await act(async () => {});

    expect(screen.queryByText("waiting on the worker…")).toBeNull();

    // Landed, so the loop is over: no further reads.
    const settled = mockApi.listAutomations.mock.calls.length;
    await act(async () => {
      jest.advanceTimersByTime(30_000);
    });
    expect(mockApi.listAutomations.mock.calls.length).toBe(settled);
  });
});

describe("lastRun", () => {
  const now = new Date("2026-09-24T09:00:00+00:00");

  it("says switched off only while a switched-off row has never run", () => {
    expect(lastRun(row({ enabled: false }), now)).toBe("switched off");
  });

  it("reports a run on a switched-off row, since Run now works there", () => {
    expect(lastRun(row({ enabled: false, last_run_at: "2026-09-24T08:00:00+00:00", last_outcome: "ok" }), now)).toBe("1h ago");
    expect(lastRun(row({ enabled: false, last_run_at: "2026-09-24T08:00:00+00:00", last_outcome: "failed" }), now)).toBe(
      "failed 1h ago",
    );
  });

  it("says never before the first run", () => {
    expect(lastRun(row(), now)).toBe("never");
  });

  it("is an age when it went through", () => {
    expect(lastRun(row({ last_run_at: "2026-09-24T08:00:00+00:00", last_outcome: "ok" }), now)).toBe("1h ago");
  });

  it("names a failure, and calls a skip what it is", () => {
    expect(lastRun(row({ last_run_at: "2026-09-24T08:00:00+00:00", last_outcome: "failed" }), now)).toBe("failed 1h ago");
    // The Anthropic switch is a decision, not a fault.
    expect(lastRun(row({ last_run_at: "2026-09-24T08:00:00+00:00", last_outcome: "skipped" }), now)).toBe(
      "skipped 1h ago — Anthropic off",
    );
  });
});
