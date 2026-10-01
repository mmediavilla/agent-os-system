import React from "react";
import { useWindowDimensions } from "react-native";
import { fireEvent, render, within } from "@testing-library/react-native";
import App from "../../App";
import { api } from "../api";
import { TOKEN_KEY } from "../auth";

const mockApi = api as jest.Mocked<typeof api>;

const OWNER = {
  id: 1,
  name: "Alex",
  email: "owner@example.com",
  avatar_url: null,
  linked_at: null,
  last_login_at: null,
  timezone: "Asia/Manila",
  mcp_token_configured: false,
};

// Signed in unless a test says otherwise: a stored token the API accepts.
beforeEach(() => {
  window.localStorage.setItem(TOKEN_KEY, "1|token");
  mockApi.me.mockResolvedValue(OWNER);
});

// The shell mounts the HUD, which polls several endpoints, and the chrome bar
// polls one more. Nothing here depends on what any of them return — a
// never-settling promise keeps everything loading without leaking an unhandled
// rejection.
jest.mock("../api", () => ({
  ...jest.requireActual("../api"),
  api: {
    listWorkouts: jest.fn(() => new Promise(() => {})),
    listExercises: jest.fn(() => new Promise(() => {})),
    listEquipment: jest.fn(() => new Promise(() => {})),
    listInsights: jest.fn(() => new Promise(() => {})),
    getFitnessStats: jest.fn(() => new Promise(() => {})),
    listConversations: jest.fn(() => new Promise(() => {})),
    getSystemStats: jest.fn(() => new Promise(() => {})),
    getDiagnostics: jest.fn(() => new Promise(() => {})),
    getAssistantActivity: jest.fn(() => new Promise(() => {})),
    getWeather: jest.fn(() => new Promise(() => {})),
    getHealth: jest.fn(() => new Promise(() => {})),
    getCalendar: jest.fn(() => new Promise(() => {})),
    listCalendarFeeds: jest.fn(() => new Promise(() => {})),
    me: jest.fn(),
  },
}));

jest.mock("react-native/Libraries/Utilities/useWindowDimensions");
const mockDimensions = useWindowDimensions as jest.MockedFunction<typeof useWindowDimensions>;

/** Render signed in, once the stored token has been checked. */
async function atWidth(width: number) {
  mockDimensions.mockReturnValue({ width, height: 900, scale: 1, fontScale: 1 });

  const q = render(<App />);
  await q.findByTestId("hud");

  return q;
}

const WIDE = 1400;
const NARROW = 375;

/**
 * The shell, once the HUD became the only screen.
 *
 * The menu bar went in 11.2: the core is the menu, and Fitness opens over the
 * HUD. What is left to hold onto is that the bar is still there and still the
 * HUD's, that it offers nowhere to go, and that the real Fitness screens mount
 * inside the overlay.
 */

it("starts on the HUD", async () => {
  const q = await atWidth(WIDE);

  expect(q.getByTestId("hud")).toBeTruthy();
  expect(q.getByText("Standing by")).toBeTruthy();
});

it("has no menu left in the bar, at any width", async () => {
  for (const width of [WIDE, NARROW]) {
    const q = await atWidth(width);

    expect(q.getByTestId("hud-chrome")).toBeTruthy();
    expect(q.queryByRole("menubar")).toBeNull();
    expect(q.queryByTestId("nav-hud")).toBeNull();
    expect(q.queryByLabelText("Fitness")).toBeNull();
    expect(q.queryByText("Heads-up display")).toBeNull();
    q.unmount();
  }
});

it("paints the bar in the HUD's palette", async () => {
  const q = await atWidth(WIDE);

  expect(q.getByTestId("chrome-scope").props.dataSet).toEqual({ hud: "true" });
});

it("drops the clock on a narrow viewport and keeps the status words", async () => {
  const q = await atWidth(NARROW);

  expect(q.getByTestId("status-pill")).toHaveTextContent("CONNECTING");
});

it("opens the real Workouts screen inside the Fitness overlay", async () => {
  const q = await atWidth(WIDE);
  fireEvent.press(q.getByTestId("hud-core"));
  fireEvent.press(q.getByLabelText("Open Fitness"));
  fireEvent.press(q.getByRole("tab", { name: "Workouts" }));

  const body = q.getByTestId("hud-fitness-body");
  expect(within(body).getByText("All workouts")).toBeTruthy();
  // Still the HUD underneath.
  expect(q.getByTestId("hud")).toBeTruthy();
});

it("keeps a Fitness screen mounted after the overlay closes", async () => {
  // Closing over a half-filled form must not wipe it.
  const q = await atWidth(WIDE);
  fireEvent.press(q.getByTestId("hud-core"));
  fireEvent.press(q.getByLabelText("Open Fitness"));
  fireEvent.press(q.getByRole("tab", { name: "Workouts" }));
  fireEvent.press(q.getByLabelText("Close Fitness"));

  expect(q.queryByText("All workouts")).toBeNull();
  expect(q.queryByText("All workouts", { includeHiddenElements: true })).toBeTruthy();
});

it("reaches Settings from the core menu, over the HUD", async () => {
  const q = await atWidth(WIDE);
  fireEvent.press(q.getByTestId("hud-core"));
  fireEvent.press(q.getByTestId("core-menu-title-core"));

  expect(q.getByText("Appearance")).toBeTruthy();
  expect(q.getByTestId("hud")).toBeTruthy();
});

describe("signed out", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.localStorage.removeItem(TOKEN_KEY);
    mockDimensions.mockReturnValue({ width: WIDE, height: 900, scale: 1, fontScale: 1 });
  });

  it("draws Login and mounts nothing that polls", async () => {
    const q = render(<App />);

    expect(await q.findByLabelText("Sign in with Google")).toBeTruthy();
    expect(q.queryByTestId("hud")).toBeNull();
    // The shell is not mounted, so the health poll never started.
    expect(mockApi.getHealth).not.toHaveBeenCalled();
    expect(mockApi.me).not.toHaveBeenCalled();
  });

  it("drops a stored token the API refuses", async () => {
    window.localStorage.setItem(TOKEN_KEY, "1|revoked");
    mockApi.me.mockRejectedValue(Object.assign(new Error("Sign in first."), { status: 401 }));

    const q = render(<App />);

    expect(await q.findByText("Your session ended. Sign in again.")).toBeTruthy();
    expect(window.localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(q.queryByTestId("hud")).toBeNull();
  });
});
