import React from "react";
import { useWindowDimensions } from "react-native";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react-native";
import Hud, { MENU_BREAKPOINT } from "../Hud";
import { CalendarFeed, CalendarWindow, Diagnostics, Health, SystemStats, Weather, api } from "../../api";
import { CALENDAR_HEX } from "../../calendarColors";
import { watchRun } from "../../runWatcher";
import { Polled } from "../../polling";
import { browserApis } from "../../../jest.browser-apis";
import { hudPalette } from "../../theme";
import { ThemeProvider } from "../../ThemeProvider";
import { UnitsProvider } from "../../UnitsProvider";
import { AssistantPrefsProvider } from "../../AssistantPrefsProvider";
import { ASSISTANT_PREFS_STORAGE_KEY } from "../../assistantPrefs";

/**
 * What `App` wraps every screen in. The HUD needs it since Settings moved into
 * an overlay here: the appearance and units come from these two contexts.
 */
function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <UnitsProvider>
        <AssistantPrefsProvider>{children}</AssistantPrefsProvider>
      </UnitsProvider>
    </ThemeProvider>
  );
}

/**
 * The HUD, now that there is something behind it.
 *
 * Two things are being asserted here, and they are different in kind. The
 * **shell** — the core menu that replaced the rails, the corner cards, the
 * overlays, and the rule that only one of them is up at a time. And the
 * **readouts**, where what is worth testing for is the states nobody sees on a
 * good day: a machine sample that has not landed, a sample that has gone stale
 * because the queue worker died, a location nobody configured. Those are the
 * states a screen full of fixtures could never have had.
 *
 * The one thing the whole phase's *look* rests on — that the container turns
 * the scoped palette on — has a second half the native preset cannot reach
 * (`dataSet` becoming `data-hud`, and the CSS block matching it); that lives in
 * the `web` Jest project, on the preset that renders DOM.
 */

jest.mock("../../api", () => ({
  ...jest.requireActual("../../api"),
  api: {
    getSystemStats: jest.fn(),
    getDiagnostics: jest.fn(),
    runDiagnostics: jest.fn(),
    // Assistant → Activity reads on arrival; its own suite covers what it draws.
    getAssistantActivity: jest.fn(() => new Promise(() => {})),
    getWeather: jest.fn(),
    listInsights: jest.fn(),
    listWorkouts: jest.fn(),
    getCalendar: jest.fn(),
    listCalendarFeeds: jest.fn(),
    updateCalendarFeed: jest.fn(),
    listConversations: jest.fn(),
    getConversation: jest.fn(),
    createConversation: jest.fn(),
    sendMessage: jest.fn(),
    decideAction: jest.fn(),
    deleteConversation: jest.fn(),
    // Assistant → Settings reads on arrival; its own suite covers what it draws.
    getAssistantSettings: jest.fn(() => new Promise(() => {})),
    getVoiceCredits: jest.fn(() => new Promise(() => {})),
    patchAssistantSettings: jest.fn(),
    voiceToken: jest.fn(async () => ({ token: "tok_test" })),
    voiceTurn: jest.fn(async () => ({ text: "Four times.", conversation_id: 1 })),
    // Facts reads on arrival; its own suite covers what it draws.
    listFacts: jest.fn(() => new Promise(() => {})),
    // The automations the HUD asks for on load, and the rows it watches
    // afterwards. The overlay's own reads are its suite's.
    runDueAutomations: jest.fn(),
    listAutomations: jest.fn(() => new Promise(() => {})),
    createAutomation: jest.fn(),
    updateAutomation: jest.fn(),
    deleteAutomation: jest.fn(),
    runAutomation: jest.fn(),
    listDocuments: jest.fn(() => new Promise(() => {})),
    listDeadlines: jest.fn(() => new Promise(() => {})),
    // Profile reads on arrival; its own suite covers what it draws.
    listSessions: jest.fn(() => new Promise(() => {})),
    listSignIns: jest.fn(() => new Promise(() => {})),
    // News reads on arrival; its own suite covers what it draws. The pins
    // count is the menu head's, and never answers unless a test says so.
    getNews: jest.fn(() => new Promise(() => {})),
    listPins: jest.fn(() => new Promise(() => {})),
  },
}));

// The spoken session, at the seam `elevenlabsSdk` exists to be — a CommonJS
// Jest VM cannot execute the real dynamic import at all. The SDK is mocked at
// the module boundary rather than beneath it, because what is underneath is a
// real WebRTC peer connection to a real account; the options are kept so
// `onConnect` and a client-tool call can be driven by hand.
jest.mock("../../elevenlabsSdk", () => ({
  loadConversationSdk: async () => ({
    Conversation: {
      startSession: async (options: Record<string, any>) => {
        const session = {
          options,
          endSession: jest.fn(async () => {}),
          getInputVolume: () => 0,
          getOutputVolume: () => 0,
        };

        mockSessions.push(session);

        return session;
      },
    },
  }),
}));

// The four Fitness screens have suites of their own, and `FitnessView` has one
// for mounting them. Here the overlay only has to say which tab it was handed,
// and whether it was told it is open.
jest.mock("../../components/FitnessView", () => {
  const { Pressable, Text } = require("react-native");

  return {
    __esModule: true,
    default: ({ active, tab, onTab }: { active: boolean; tab: string; onTab: (tab: string) => void }) => (
      <>
        <Text testID="fitness-view-stub">{`${tab}:${active ? "active" : "idle"}`}</Text>
        <Pressable testID="fitness-view-stub-workouts" onPress={() => onTab("workouts")} />
      </>
    ),
  };
});

/** Every session opened in this file, with the options it was opened with. */
const mockSessions: any[] = [];

// The conversation in the overlay is `AssistantFull`'s, and its own suite drives
// it through a mocked watcher. Here it only has to mount.
jest.mock("../../runWatcher", () => ({ watchRun: jest.fn(() => ({ stop: jest.fn() })) }));
const mockWatchRun = watchRun as jest.MockedFunction<typeof watchRun>;

jest.mock("react-native/Libraries/Utilities/useWindowDimensions");
const mockDimensions = useWindowDimensions as jest.MockedFunction<typeof useWindowDimensions>;
const mockApi = api as jest.Mocked<typeof api>;

// ── fixtures ─────────────────────────────────────────────────────────────────

const SYSTEM: SystemStats = {
  host: "DESKTOP-TEST",
  platform: "Windows",
  sampled_at: "2026-09-06T09:00:00+00:00",
  age_seconds: 4,
  cpu: { percent: 34 },
  memory: { used_bytes: 21_260_000_000, total_bytes: 34_000_000_000, percent: 62.5 },
  disk: {
    used_bytes: 1_562_000_000_000,
    total_bytes: 2_199_000_000_000,
    percent: 71,
    path: "C:\\",
  },
};

/** A checkout that has never diagnosed; what Stats draws of a report is `StatsView`'s own suite. */
const DIAGNOSTICS: Diagnostics = { latest: null, reports: [], groups: [] };

const WEATHER: Weather = {
  configured: true,
  available: true,
  label: "Manila",
  observed_at: "2026-09-06T09:00:00+00:00",
  condition: "Partly cloudy",
  weather_code: 2,
  temperature_c: 28.6,
  apparent_c: 33.9,
  humidity: 78,
  precipitation_chance: 40,
  wind_kph: 11.4,
  wind_from: "SW",
};

const HEALTH: Health = {
  ok: true,
  checked_at: "2026-09-06T09:00:00+00:00",
  database: { state: "up", driver: "sqlite", journal_mode: "wal", size_bytes: 18_874_368 },
  queue: { state: "up", last_beat_at: "2026-09-06T08:59:30+00:00", age_seconds: 30, pending: 0 },
  scheduler: { state: "up", last_beat_at: "2026-09-06T08:59:30+00:00", age_seconds: 30 },
  assistant: { state: "up", enabled: true, configured: true, model: "claude-sonnet-5" },
};

function polled(data: Health | null, extra: Partial<Polled<Health>> = {}): Polled<Health> {
  return { data, error: null, loading: false, latencyMs: 42, refresh: jest.fn(), ...extra };
}

const WORKOUTS = {
  data: [
    {
      id: 1,
      title: "Push A",
      started_at: "2026-09-06T07:00:00+00:00",
      duration_minutes: 61,
      description: null,
      notes: null,
      sets: [],
    },
  ],
  meta: { total: 1 },
  summary: {
    week_count: 2,
    week_goal: 4,
    streak_days: 0,
    last_session: { id: 1, title: "Push A", started_at: "2026-09-06T07:00:00+00:00" },
  },
} as any;

const WORK: CalendarFeed = {
  id: 1,
  name: "Work",
  color: "peacock",
  enabled: true,
  status: "ok",
  message: null,
  fetched_at: new Date().toISOString(),
  skipped: 0,
};

/** A calendar answer. One connected, enabled, healthy calendar unless told otherwise. */
function calendarWindow(overrides: Partial<CalendarWindow> = {}): CalendarWindow {
  return { configured: true, from: "", to: "", events: [], feeds: [WORK], ...overrides };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSessions.length = 0;
  mockApi.voiceToken.mockResolvedValue({ token: "tok_test" });
  mockApi.voiceTurn.mockResolvedValue({ text: "Four times.", conversation_id: 1 });
  mockApi.getSystemStats.mockResolvedValue(SYSTEM);
  // Never answers unless a test says otherwise; a resolved list would leak.
  mockApi.listFacts.mockImplementation(() => new Promise(() => {}));
  mockApi.listPins.mockImplementation(() => new Promise(() => {}));
  mockApi.getNews.mockImplementation(() => new Promise(() => {}));
  // Nothing is due by default, so no test pays for the delivery watcher.
  mockApi.runDueAutomations.mockResolvedValue({ claimed: [] });
  mockApi.listAutomations.mockImplementation(() => new Promise(() => {}));
  mockApi.getDiagnostics.mockResolvedValue(DIAGNOSTICS);
  mockApi.getWeather.mockResolvedValue(WEATHER);
  mockApi.listInsights.mockResolvedValue({ data: [] });
  mockApi.listWorkouts.mockResolvedValue(WORKOUTS);
  mockApi.getCalendar.mockResolvedValue(calendarWindow());
  mockApi.listCalendarFeeds.mockResolvedValue({ data: [] });
  mockApi.listConversations.mockResolvedValue({ data: [] });
  // A spoken turn into no thread makes one, and the id coming back selects it —
  // so this suite can reach the thread loader without ever pressing Send.
  mockApi.getConversation.mockResolvedValue({
    conversation: { id: 1, title: "how was last week?", last_message_at: null, created_at: null },
    messages: [],
    pending_actions: [],
    run: null,
  } as never);
});

function renderAt(width: number, health: Polled<Health> = polled(HEALTH)) {
  mockDimensions.mockReturnValue({ width, height: 900, scale: 1, fontScale: 1 });

  return render(<Hud health={health} />, {
    wrapper: Providers,
    // The camera preview is a raw DOM `<video>`, and this preset renders
    // through `react-test-renderer`, where a host ref is null unless one is
    // supplied. Capturing reads `videoWidth` off exactly that ref, so without
    // this the shutter would test as "returns nothing" forever.
    createNodeMock: (element) =>
      element.type === "video"
        ? { videoWidth: 1280, videoHeight: 720, srcObject: null, play: () => Promise.resolve() }
        : null,
  });
}

/** Lets the four telemetry reads resolve before anything is asserted. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

const WIDE = MENU_BREAKPOINT + 300;
const NARROW = MENU_BREAKPOINT - 300;

/** Clicks the core, unless the menu is already out. */
function openMenu(q: { queryByTestId: typeof screen.queryByTestId; getByTestId: typeof screen.getByTestId } = screen) {
  if (!q.queryByTestId("core-menu-title-core")) fireEvent.press(q.getByTestId("hud-core"));
}

/**
 * The Assistant overlay is the core menu's Assistant title now (13.0): the chat
 * button that used to open it went. It opens on the tab last shown, which is
 * Chat until something changes it.
 */
function openAssistant(q: { queryByTestId: typeof screen.queryByTestId; getByTestId: typeof screen.getByTestId } = screen) {
  openMenu(q);
  fireEvent.press(q.getByTestId("core-menu-title-assistant"));
}

/** Stats is the core menu's System stats title: the numbers left the menu for it. */
function openStats(q: { queryByTestId: typeof screen.queryByTestId; getByTestId: typeof screen.getByTestId } = screen) {
  openMenu(q);
  fireEvent.press(q.getByTestId("core-menu-title-system"));
}

/** Settings is the core menu's Core title now, not a gear. */
function openSettings(q: { queryByTestId: typeof screen.queryByTestId; getByTestId: typeof screen.getByTestId } = screen) {
  openMenu(q);
  fireEvent.press(q.getByTestId("core-menu-title-core"));
}

/**
 * The core is the menu.
 *
 * The rails went in Phase 11.1: clicking the core brings the numbered panels
 * in, down both sides, and clicking it again takes them away. What these
 * assert is that it is shut until asked for (and out of reach while shut), that
 * it keeps the HUD's one-thing-at-a-time rule with the corner cards and the
 * overlays, and that each row does what it says. `CoreMenu`'s own suite covers
 * how a panel is drawn.
 */
describe("the core menu", () => {
  const escape = () =>
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });

  it("has no rails any more", () => {
    renderAt(WIDE);

    expect(screen.queryByTestId("hud-rail-left", { includeHiddenElements: true })).toBeNull();
    expect(screen.queryByTestId("hud-handle-left", { includeHiddenElements: true })).toBeNull();
    expect(screen.queryByTestId("hud-settings-open", { includeHiddenElements: true })).toBeNull();
    // The core is still the column the screen is for.
    expect(screen.getByLabelText("Assistant idle")).toBeTruthy();
  });

  it("is shut, and out of reach, until the core is clicked", () => {
    renderAt(WIDE);

    const core = screen.getByTestId("hud-core");
    expect(core.props.accessibilityLabel).toBe("Core menu");
    expect(core.props.accessibilityState).toEqual({ expanded: false });
    expect(screen.queryByTestId("core-menu-panel-fitness")).toBeNull();
    expect(flatStyle("core-menu-left", true).visibility).toBe("hidden");
    expect(flatStyle("core-menu-left", true).pointerEvents).toBe("none");

    fireEvent.press(core);

    expect(screen.getByTestId("hud-core").props.accessibilityState).toEqual({ expanded: true });
    expect(flatStyle("core-menu-left").visibility).toBe("visible");
  });

  it("without a signed-in owner, is eight panels, four a side", () => {
    // No account, no Profile: eight panels. Signed in is nine, four and five —
    // see Profile below.
    renderAt(WIDE);
    openMenu();

    const left = within(screen.getByTestId("core-menu-left"));
    const right = within(screen.getByTestId("core-menu-right"));

    for (const title of ["FITNESS", "ASSISTANT", "SYSTEM STATS", "CORE"]) expect(left.getByText(title)).toBeTruthy();
    for (const title of ["FACTS", "AUTOMATIONS", "RECORDS", "NEWS"]) expect(right.getByText(title)).toBeTruthy();
    for (const n of ["01", "02", "03", "04", "05", "06", "07", "08"]) expect(screen.getByText(n)).toBeTruthy();
  });

  describe("saying the core can be clicked", () => {
    const ring = () => flatStyle("hud-core-ring", true);
    const lift = () => flatStyle("hud-core-lift").transform[0].scale;
    const circle = () => screen.UNSAFE_getByProps({ "data-testid": "hud-core-ring-circle" });

    it("breathes a faint ring out of the sphere while nothing is on it", () => {
      renderAt(WIDE);

      expect(ring().animation).toMatch(/^hud-core-beckon .* infinite$/);
      expect(lift()).toBe(1);
      expect(flatStyle("hud-core").cursor).toBe("pointer");
      // Nothing has been clicked, so nothing has pinged.
      expect(screen.queryByTestId("hud-core-ping", { includeHiddenElements: true })).toBeNull();
    });

    it("circles in when the pointer finds it, drawing itself round the sphere", () => {
      renderAt(WIDE);
      fireEvent(screen.getByTestId("hud-core"), "hoverIn");

      // Closing in from further out, and landing where the plain styles say.
      expect(ring().animation).toMatch(/^hud-core-ring-in /);
      expect(ring().opacity).toBeGreaterThan(0.5);
      expect(ring().transform[0].scale).toBeGreaterThan(1);
      expect(circle().props.style.animation).toMatch(/^hud-core-ring-draw /);
      expect(lift()).toBeGreaterThan(1);
    });

    it("unwinds when the pointer leaves, then goes back to beckoning", () => {
      jest.useFakeTimers();
      try {
        renderAt(WIDE);
        fireEvent(screen.getByTestId("hud-core"), "hoverIn");
        fireEvent(screen.getByTestId("hud-core"), "hoverOut");

        expect(ring().animation).toMatch(/^hud-core-ring-out /);
        expect(circle().props.style.animation).toMatch(/^hud-core-ring-undraw /);
        expect(lift()).toBe(1);

        act(() => {
          jest.advanceTimersByTime(400);
        });
        expect(ring().animation).toMatch(/hud-core-beckon/);
      } finally {
        jest.useRealTimers();
      }
    });

    it("is drawn in the core's own colour, not always the accent", () => {
      renderAt(WIDE);
      expect(circle().props.stroke).toBe("var(--c-accent)");

      renderAt(WIDE, polled({ ...HEALTH, assistant: { ...HEALTH.assistant, enabled: false, state: "off" } }));
      const circles = screen.UNSAFE_queryAllByProps({ "data-testid": "hud-core-ring-circle" });
      expect(circles.at(-1)!.props.stroke).toBe("var(--c-amber)");

      fireEvent.press(screen.getAllByTestId("hud-core").at(-1)!);
      const pings = screen.getAllByTestId("hud-core-ping", { includeHiddenElements: true });
      expect(Object.assign({}, ...[pings.at(-1)!.props.style].flat(3).filter(Boolean)).borderColor).toBe(
        "var(--c-amber)",
      );
    });

    it("gives under the press, faster than it leans in", () => {
      renderAt(WIDE);
      fireEvent(screen.getByTestId("hud-core"), "hoverIn");
      fireEvent(screen.getByTestId("hud-core"), "pressIn");

      expect(lift()).toBeLessThan(1);
      expect(ring().transform[0].scale).toBeLessThan(1);
      expect(flatStyle("hud-core-lift").transitionDuration).toBe("90ms");

      fireEvent(screen.getByTestId("hud-core"), "pressOut");
      expect(lift()).toBeGreaterThan(1);
      expect(flatStyle("hud-core-lift").transitionDuration).toBe("260ms");
    });

    it("sends one ring out after every click, open or shut", () => {
      renderAt(WIDE);
      const ping = () => screen.getByTestId("hud-core-ping", { includeHiddenElements: true });

      fireEvent.press(screen.getByTestId("hud-core"));
      const first = ping();
      expect(flatStyle.call(null, "hud-core-ping", true).animation).toMatch(/^hud-core-ping .* 1$/);

      // A new element, so the one-shot animation plays again.
      fireEvent.press(screen.getByTestId("hud-core"));
      expect(ping()).not.toBe(first);
    });

    it("holds a steady dim ring while the menu is out, because the core still closes it", () => {
      renderAt(WIDE);
      fireEvent.press(screen.getByTestId("hud-core"));

      expect(ring().animation).toBeUndefined();
      expect(ring().opacity).toBeLessThan(0.5);
    });

    it("keeps the rings out of the way of the click and of a screen reader", () => {
      renderAt(WIDE);
      fireEvent.press(screen.getByTestId("hud-core"));

      expect(ring().pointerEvents).toBe("none");
      expect(screen.getByTestId("hud-core-ring", { includeHiddenElements: true }).props.accessibilityElementsHidden).toBe(true);
      expect(flatStyle("hud-core-ping", true).pointerEvents).toBe("none");
    });
  });

  it("closes when the core is clicked again", () => {
    renderAt(WIDE);
    openMenu();
    fireEvent.press(screen.getByTestId("hud-core"));

    expect(screen.queryByTestId("core-menu-panel-fitness")).toBeNull();
  });

  it("says how to put it away, under the core", () => {
    renderAt(WIDE);
    openMenu();

    expect(screen.getByText("Core menu")).toBeTruthy();
    expect(screen.getByTestId("hud-stage-hint").props.children).toBe(
      "Pick a module. Click the core again to close it.",
    );
  });

  it("puts a corner card away, and a corner card puts it away", async () => {
    renderAt(WIDE);
    await settle();

    fireEvent.press(screen.getByTestId("hud-weather"));
    openMenu();
    expect(screen.queryByTestId("panel-environment")).toBeNull();

    fireEvent.press(screen.getByTestId("hud-agenda"));
    expect(screen.queryByTestId("core-menu-panel-fitness")).toBeNull();
    expect(screen.getByTestId("panel-agenda")).toBeTruthy();
  });

  it("goes first on Escape, and the next Escape does nothing more", () => {
    renderAt(WIDE);
    openMenu();

    escape();
    expect(screen.queryByTestId("core-menu-panel-fitness")).toBeNull();
    escape();
    expect(screen.getByText("Standing by")).toBeTruthy();
  });

  it("is put away when an overlay opens, and is not back when it closes", () => {
    renderAt(WIDE);
    openSettings();

    expect(screen.queryByTestId("core-menu-panel-fitness")).toBeNull();
    fireEvent.press(screen.getByLabelText("Close Settings"));
    expect(screen.queryByTestId("core-menu-panel-fitness")).toBeNull();
  });

  it("opens the Fitness overlay from its title, which has no rows under it", () => {
    renderAt(WIDE);
    openMenu();

    // The tabs are the overlay's own; a row per tab was a second copy of them.
    expect(screen.queryByTestId("core-menu-row-fitness-home")).toBeNull();
    expect(within(screen.getByTestId("core-menu-panel-fitness")).queryByText(/Opens on/)).toBeNull();

    fireEvent.press(screen.getByLabelText("Open Fitness"));

    expect(within(screen.getByTestId("hud-fitness-body")).getByTestId("fitness-view-stub"))
      .toHaveTextContent("home:active");
    // Acting puts the menu away.
    expect(screen.queryByTestId("core-menu-panel-fitness")).toBeNull();
  });

  it("opens Fitness again on the tab it was left on", () => {
    renderAt(WIDE);
    openMenu();
    fireEvent.press(screen.getByLabelText("Open Fitness"));
    fireEvent.press(screen.getByTestId("fitness-view-stub-workouts"));
    fireEvent.press(screen.getByLabelText("Close Fitness"));

    openMenu();
    fireEvent.press(screen.getByLabelText("Open Fitness"));

    expect(screen.getByTestId("fitness-view-stub")).toHaveTextContent("workouts:active");
  });

  it("opens the Assistant from its title, which has no rows under it", async () => {
    renderAt(WIDE);
    openMenu();

    // Chat and Settings are the overlay's tabs, the microphone and the camera
    // are buttons under the core, and the state is the caption.
    for (const row of ["chat", "talk", "camera", "state"]) {
      expect(screen.queryByTestId(`core-menu-row-assistant-${row}`)).toBeNull();
    }

    fireEvent.press(screen.getByLabelText("Open the Assistant"));
    await settle();

    expect(screen.getByLabelText("Close full Assistant")).toBeTruthy();
    expect(within(screen.getByTestId("hud-full-body")).getByLabelText("Message")).toBeTruthy();
    expect(screen.queryByTestId("core-menu-panel-fitness")).toBeNull();
  });

  it("opens the Assistant again on the tab it was left on", async () => {
    renderAt(WIDE);
    await settle();
    openAssistant();
    fireEvent.press(within(screen.getByTestId("hud-full-body")).getByRole("tab", { name: "Settings" }));
    fireEvent.press(screen.getByLabelText("Close full Assistant"));

    openAssistant();

    expect(within(screen.getByTestId("hud-full-body")).getByTestId("anthropic-toggle")).toBeTruthy();
    expect(within(screen.getByTestId("hud-full-body")).queryByLabelText("Message")).toBeNull();
  });

  it("turns the camera off when it opens over the camera card", async () => {
    renderAt(WIDE);
    await settle();

    fireEvent.press(screen.getByTestId("hud-optics"));
    fireEvent.press(screen.getByTestId("camera-toggle"));
    await waitFor(() =>
      expect(screen.getByTestId("camera-capture").props.accessibilityState.disabled).toBe(false),
    );
    const tracks = (await browserApis.getUserMedia.mock.results[0].value).getVideoTracks();

    openMenu();

    expect(screen.queryByTestId("panel-camera")).toBeNull();
    expect(tracks[0].stop).toHaveBeenCalled();
  });

  it("opens Settings from the Core title, which has no rows of its own", () => {
    renderAt(WIDE);
    openMenu();

    const core = within(screen.getByTestId("core-menu-panel-core"));
    expect(core.getAllByRole("button")).toHaveLength(1);
    expect(screen.queryByTestId("core-menu-row-core-calendars")).toBeNull();

    fireEvent.press(screen.getByLabelText("Open Settings"));
    expect(within(screen.getByTestId("hud-settings-body")).getByText("Appearance")).toBeTruthy();
    expect(screen.queryByTestId("core-menu-title-core")).toBeNull();
  });

  it("opens Facts from its title, and reads the facts only while the menu or the overlay shows", () => {
    renderAt(WIDE);
    expect(mockApi.listFacts).not.toHaveBeenCalled();

    // The menu reads them for the count beside the title.
    openMenu();
    expect(mockApi.listFacts).toHaveBeenCalledTimes(1);
    expect(within(screen.getByTestId("core-menu-panel-facts")).queryByText("Not built yet")).toBeNull();

    // The overlay reads its own list on open.
    fireEvent.press(screen.getByLabelText("Open Facts"));
    expect(flatStyle("hud-facts").visibility).toBe("visible");
    expect(within(screen.getByTestId("hud-facts")).getByTestId("facts-view")).toBeTruthy();
    expect(mockApi.listFacts).toHaveBeenCalledTimes(2);

    fireEvent.press(screen.getByLabelText("Close Facts"));
    expect(flatStyle("hud-facts", true).visibility).toBe("hidden");
  });

  it("opens Automations from its title, and the overlay reads the rows on the way in", () => {
    renderAt(WIDE);
    openMenu();
    expect(within(screen.getByTestId("core-menu-panel-automations")).queryByText("Not built yet")).toBeNull();
    expect(mockApi.listAutomations).not.toHaveBeenCalled();

    fireEvent.press(screen.getByLabelText("Open Automations"));
    expect(flatStyle("hud-automations").visibility).toBe("visible");
    expect(within(screen.getByTestId("hud-automations")).getByTestId("automations-view")).toBeTruthy();
    expect(mockApi.listAutomations).toHaveBeenCalledTimes(1);

    fireEvent.press(screen.getByLabelText("Close Automations"));
    expect(flatStyle("hud-automations", true).visibility).toBe("hidden");
  });

  it("opens Records from its title, and the Documents tab reads the cabinet on the way in", () => {
    renderAt(WIDE);
    openMenu();
    expect(mockApi.listDocuments).not.toHaveBeenCalled();

    fireEvent.press(screen.getByLabelText("Open Records"));
    expect(flatStyle("hud-records").visibility).toBe("visible");
    expect(within(screen.getByTestId("hud-records")).getByTestId("documents-view")).toBeTruthy();
    expect(mockApi.listDocuments).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("core-menu-title-core")).toBeNull();

    fireEvent.press(screen.getByLabelText("Close Records"));
    expect(flatStyle("hud-records", true).visibility).toBe("hidden");
  });

  it("opens News from its title, and the overlay reads the first beat on the way in", () => {
    renderAt(WIDE);
    openMenu();
    expect(mockApi.getNews).not.toHaveBeenCalled();

    fireEvent.press(screen.getByLabelText("Open News"));
    expect(flatStyle("hud-news").visibility).toBe("visible");
    expect(within(screen.getByTestId("hud-news")).getByTestId("news-view")).toBeTruthy();
    // No beat picked yet: the server's first.
    expect(mockApi.getNews).toHaveBeenCalledWith(null);
    expect(screen.queryByTestId("core-menu-title-core")).toBeNull();

    fireEvent.press(screen.getByLabelText("Close News"));
    expect(flatStyle("hud-news", true).visibility).toBe("hidden");
  });

  it("says beside the News title how many pins are unread, and nothing when none are", async () => {
    mockApi.listPins.mockResolvedValue({ data: [], unread: 3 });
    renderAt(WIDE);
    expect(mockApi.listPins).not.toHaveBeenCalled();
    openMenu();
    await settle();

    expect(within(screen.getByTestId("core-menu-panel-news")).getByText("3 unread pinned")).toBeTruthy();
    expect(screen.getByLabelText("Open News — 3 unread pinned")).toBeTruthy();
  });

  it("draws no count on News when every pin is read", async () => {
    mockApi.listPins.mockResolvedValue({ data: [], unread: 0 });
    renderAt(WIDE);
    openMenu();
    await settle();

    expect(within(screen.getByTestId("core-menu-panel-news")).queryByText(/unread/)).toBeNull();
    expect(screen.getByLabelText("Open News")).toBeTruthy();
  });

  it("becomes one column over a scrim on a narrow window, and the scrim closes it", () => {
    renderAt(NARROW);
    openMenu();

    expect(screen.queryByTestId("core-menu-left")).toBeNull();
    expect(within(screen.getByTestId("core-menu-single")).getByText("AUTOMATIONS")).toBeTruthy();

    fireEvent.press(screen.getByLabelText("Close the core menu"));
    expect(screen.queryByTestId("core-menu-panel-fitness")).toBeNull();
  });

  it("leaves the corner buttons above it", () => {
    renderAt(WIDE);

    expect(flatStyle("hud-popouts").zIndex).toBeGreaterThan(flatStyle("core-menu").zIndex);
    expect(flatStyle("hud-popouts-top-right").zIndex).toBeGreaterThan(flatStyle("core-menu").zIndex);
  });
});

/**
 * Profile: always the last panel, and the overlay its title opens.
 *
 * `App` hands the HUD who is signed in; without that there is no panel, which
 * is how every other suite here mounts the HUD. `ProfileView`'s own suite
 * covers the overlay's contents, and `CoreMenu`'s where a top panel is drawn.
 */
describe("Profile", () => {
  const ACCOUNT = {
    user: {
      id: 1,
      name: "Alex Rivera",
      email: "owner@example.com",
      avatar_url: null,
      linked_at: null,
      last_login_at: null,
      timezone: "Asia/Manila",
      mcp_token_configured: false,
    },
    signOut: jest.fn(),
  };

  function renderSignedIn() {
    mockDimensions.mockReturnValue({ width: WIDE, height: 900, scale: 1, fontScale: 1 });
    return render(<Hud health={polled(HEALTH)} account={ACCOUNT} />, { wrapper: Providers });
  }

  beforeEach(() => ACCOUNT.signOut.mockClear());

  it("is not on the menu without a signed-in account", async () => {
    renderAt(WIDE);
    openMenu();
    await settle();

    expect(screen.queryByTestId("core-menu-panel-profile")).toBeNull();
  });

  it("is always the last panel, under News, with the owner's name and address", async () => {
    renderSignedIn();
    openMenu();
    await settle();

    const right = within(screen.getByTestId("core-menu-right"));
    expect(within(screen.getByTestId("core-menu-panel-profile")).getByText("09")).toBeTruthy();
    expect(right.getByText("ALEX RIVERA")).toBeTruthy();
    expect(right.getByText("owner@example.com")).toBeTruthy();
    // News sits directly above it.
    expect(within(screen.getByTestId("core-menu-panel-news")).getByText("08")).toBeTruthy();
  });

  it("makes the menu four and five, the fifth on the right, Core the fourth down the left", async () => {
    renderSignedIn();
    openMenu();
    await settle();

    const left = within(screen.getByTestId("core-menu-left"));
    const right = within(screen.getByTestId("core-menu-right"));
    for (const n of ["01", "02", "03", "04"]) expect(left.getByText(n)).toBeTruthy();
    for (const n of ["05", "06", "07", "08", "09"]) expect(right.getByText(n)).toBeTruthy();
    expect(left.getByText("CORE")).toBeTruthy();
  });

  it("opens the Profile overlay from its title, putting the menu away", async () => {
    renderSignedIn();
    expect(flatStyle("hud-profile", true).visibility).toBe("hidden");

    openMenu();
    await settle();
    fireEvent.press(screen.getByLabelText("Open Profile"));
    await settle();

    expect(flatStyle("hud-profile").visibility).toBe("visible");
    expect(screen.queryByTestId("core-menu-title-core")).toBeNull();
    expect(mockApi.listSessions).toHaveBeenCalled();
  });

  it("signs out from the menu in one press", async () => {
    renderSignedIn();
    openMenu();
    await settle();

    fireEvent.press(screen.getByTestId("core-menu-row-profile-sign-out"));
    expect(ACCOUNT.signOut).toHaveBeenCalledTimes(1);
  });
});

describe("the HUD scope", () => {
  it("turns itself on for its own subtree", () => {
    // RN-Web writes this out as `data-hud`, which the reduced-motion and voice
    // rules in theme.ts match — see the web project for the other half.
    renderAt(WIDE);

    expect(screen.getByTestId("hud").props.dataSet).toEqual({ hud: "true" });
  });

  it("paints its own ground rather than borrowing the app's", () => {
    // `colors.bg` is `var(--c-bg)`, the navy on `:root`. Painting it here
    // rather than leaving the HUD transparent keeps the graticule on a ground
    // of its own.
    renderAt(WIDE);
    const style = [screen.getByTestId("hud").props.style].flat(3).filter(Boolean);

    expect(Object.assign({}, ...style).backgroundColor).toBe("var(--c-bg)");
    expect(hudPalette.bg).toBe("#040d18");
  });
});

/**
 * The machine's numbers live in the Stats overlay, which the core menu's System
 * stats title opens. The panel keeps its host and a warning, and nothing else.
 */
describe("this machine", () => {
  const stats = () => within(screen.getByTestId("hud-stats"));

  it("opens Stats from the System stats title, and puts the menu away", async () => {
    renderAt(WIDE);
    openStats();
    await settle();

    expect(flatStyle("hud-stats").visibility).toBe("visible");
    expect(screen.queryByTestId("core-menu-title-core")).toBeNull();
  });

  it("leaves the panel a destination: the host, and no rows", async () => {
    renderAt(WIDE);
    openMenu();
    await settle();

    expect(screen.getByLabelText("Open Stats")).toBeTruthy();
    expect(screen.getByText(/DESKTOP-TEST/)).toBeTruthy();
    expect(screen.queryByTestId("core-menu-row-system-cpu")).toBeNull();
    expect(screen.queryByTestId("core-menu-row-system-api")).toBeNull();
    // A fresh sample says nothing: an age under a panel with no gauges is a
    // caption for a reading nobody can see.
    expect(screen.queryByText(/Sampled/)).toBeNull();
    expect(screen.queryByText(/Sample stale/)).toBeNull();
  });

  it("says beside the Facts title how many proposals wait, and nothing when none do", async () => {
    const proposal = (id: number, key: string) => ({
      id,
      category: "food",
      key,
      value: "Black.",
      confidence: "inferred" as const,
      source: "extracted" as const,
      status: "proposed" as const,
      conversation_id: 3,
      learned_at: "2026-09-22T02:00:00+00:00",
      decided_at: null,
      replaces: null,
    });
    mockApi.listFacts.mockResolvedValue({ active: [], proposed: [proposal(1, "coffee"), proposal(2, "tea")] });
    renderAt(WIDE);
    openMenu();
    await settle();

    const facts = within(screen.getByTestId("core-menu-panel-facts"));
    expect(facts.getByText("2 to review")).toBeTruthy();
    expect(screen.getByLabelText("Open Facts — 2 to review")).toBeTruthy();
  });

  it("draws no count on Facts when nothing waits", async () => {
    mockApi.listFacts.mockResolvedValue({ active: [], proposed: [] });
    renderAt(WIDE);
    openMenu();
    await settle();

    expect(within(screen.getByTestId("core-menu-panel-facts")).queryByText(/to review/)).toBeNull();
    expect(screen.getByLabelText("Open Facts")).toBeTruthy();
  });

  it("warns on the panel when the sample has gone stale", async () => {
    // A climbing age is the second sign the queue worker is dead, and the menu
    // is where you are before you open anything.
    mockApi.getSystemStats.mockResolvedValue({ ...SYSTEM, age_seconds: 300 });
    renderAt(WIDE);
    openMenu();
    await settle();

    expect(screen.getByText("Sample stale — 5m ago")).toBeTruthy();
  });

  it("does not call a sample that has not landed stale", async () => {
    // `isStale(null)` is true, and the age is null until the first sample —
    // without the guard every open of the menu would flash "stale — never".
    mockApi.getSystemStats.mockResolvedValue({ ...SYSTEM, sampled_at: null, age_seconds: null, cpu: null, memory: null });
    renderAt(WIDE);
    openMenu();
    await settle();

    expect(screen.queryByText(/Sample stale/)).toBeNull();
  });

  it("draws the gauges out of the sample, in Stats", async () => {
    renderAt(WIDE);
    openStats();
    await settle();

    expect(stats().getByText("34%")).toBeTruthy();
    // One unit for the pair, chosen from the total: "19.8 / 32 GB" is one
    // measurement, "19.8 GB / 32 GB" is two.
    expect(stats().getByText("19.8 / 31.7 GB")).toBeTruthy();
    expect(stats().getByText(/^Sampled 4s ago\./)).toBeTruthy();
  });

  it("says a sample is stale rather than blanking the gauges", async () => {
    // CPU and memory are sampled on a queue worker, so an age that climbs past
    // a minute means nothing is servicing the queue. The last reading with a
    // warning under it is more use than two empty bars.
    mockApi.getSystemStats.mockResolvedValue({ ...SYSTEM, age_seconds: 600 });
    renderAt(WIDE);
    openStats();
    await settle();

    expect(stats().getByText("34%")).toBeTruthy();
    expect(stats().getByText(/Sample stale/)).toBeTruthy();
  });

  it("shows the disk before the first sample has landed", async () => {
    // `disk_free_space()` is a stat() call and never waits for the probe, which
    // is what puts something on the page on the very first load.
    mockApi.getSystemStats.mockResolvedValue({
      ...SYSTEM,
      sampled_at: null,
      age_seconds: null,
      cpu: null,
      memory: null,
    });
    renderAt(WIDE);
    openStats();
    await settle();

    expect(stats().getByText("1.4 / 2 TB")).toBeTruthy();
    // Not a zeroed bar: that would be a reading, and there isn't one yet.
    expect(stats().getAllByText("waiting")).toHaveLength(2);
  });

  it("is sampled only while the menu is out or Stats is open", async () => {
    renderAt(WIDE);
    await settle();
    expect(mockApi.getSystemStats).not.toHaveBeenCalled();

    openMenu();
    await settle();
    expect(mockApi.getSystemStats).toHaveBeenCalledTimes(1);
  });

  it("keeps being sampled once Stats is open, though the menu has gone", async () => {
    // Opening Stats closes the menu in the same commit, so a gate on the menu
    // alone would freeze the gauges on the one screen that draws them.
    jest.useFakeTimers({ doNotFake: ["nextTick", "queueMicrotask"] });
    try {
      renderAt(WIDE);
      openStats();
      await settle();
      const before = mockApi.getSystemStats.mock.calls.length;

      await act(async () => {
        jest.advanceTimersByTime(5_500);
        await Promise.resolve();
      });

      expect(mockApi.getSystemStats.mock.calls.length).toBeGreaterThan(before);
    } finally {
      jest.useRealTimers();
    }
  });

  it("reads the diagnosis only once Stats is open, and Escape closes it", async () => {
    renderAt(WIDE);
    openMenu();
    await settle();
    expect(mockApi.getDiagnostics).not.toHaveBeenCalled();

    fireEvent.press(screen.getByTestId("core-menu-title-system"));
    await settle();
    expect(mockApi.getDiagnostics).toHaveBeenCalledTimes(1);
    expect(within(screen.getByTestId("stats-verdict")).getByText("Not yet run")).toBeTruthy();

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(flatStyle("hud-stats", true).visibility).toBe("hidden");
  });
});

/**
 * The weather: a button bottom left that pops out a card.
 *
 * It was the left rail's second panel. What these assert is the move — that it
 * is a button in its corner, inset the way the launchers are in theirs — and
 * what the card adds: the hours and the week,
 * because the question the assistant kept failing was about tomorrow.
 */
describe("the weather", () => {
  /** Wall clock, the way the API writes the forecast's times. */
  const wall = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` +
    `T${String(d.getHours()).padStart(2, "0")}:00:00`;

  function forecast(): Weather {
    const now = new Date();
    const hour = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours());

    return {
      ...WEATHER,
      hourly: Array.from({ length: 24 }, (_, i) => ({
        time: wall(new Date(hour.getTime() + i * 3_600_000)),
        condition: i === 3 ? "Light rain" : "Partly cloudy",
        weather_code: i === 3 ? 61 : 2,
        is_day: true,
        temperature_c: 27 + (i % 5),
        precipitation_chance: i === 3 ? 70 : 5,
      })),
      daily: Array.from({ length: 7 }, (_, i) => {
        const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);

        return {
          date: wall(day).slice(0, 10),
          condition: i === 1 ? "Thunderstorm" : "Partly cloudy",
          weather_code: i === 1 ? 95 : 2,
          high_c: 31.4,
          low_c: 24.6,
          precipitation_chance: i === 1 ? 90 : 10,
          precipitation_mm: 3,
          wind_max_kph: 18,
          uv_index: 9,
          sunrise: `${wall(day).slice(0, 10)}T05:43:00`,
          sunset: `${wall(day).slice(0, 10)}T18:01:00`,
        };
      }),
    };
  }

  function openCard() {
    fireEvent.press(screen.getByTestId("hud-weather"));
  }

  it("is shut until asked for", async () => {
    renderAt(WIDE);
    await settle();

    expect(screen.queryByTestId("panel-environment")).toBeNull();
  });

  it("sits bottom left, at the agenda's inset mirrored", () => {
    renderAt(WIDE);

    const track = flatStyle("hud-popouts");
    expect(within(screen.getByTestId("hud-popouts")).getByTestId("hud-weather")).toBeTruthy();
    expect(track.left).toBe(flatStyle("hud-popouts-top-right").right);
    expect(track.bottom).toBeDefined();
    expect(track.top).toBeUndefined();
  });

  it("pops the card out to the button's right, bottom edges level", async () => {
    // The owner's call: out towards the core, not up into the corner.
    renderAt(WIDE);
    await settle();
    openCard();

    const card = flatStyle("hud-weather-card");
    expect(card.left).toBe("100%");
    expect(card.bottom).toBe(0);
    expect(card.top).toBeUndefined();
  });

  it("is glass, like the overlays", async () => {
    // The same blur and accent edge as Settings and the full Assistant, and a
    // clear fill — an opaque panel would hide the blur behind it.
    renderAt(WIDE);
    await settle();
    openCard();

    expect(screen.getByTestId("hud-weather-card").props.dataSet).toEqual({ glass: "true" });
    expect(flatStyle("panel-environment").backgroundColor).toBe("var(--c-glass)");
    expect(flatStyle("panel-environment").borderColor).toBe("var(--c-accentBd)");
  });

  it("is on screen at every width", () => {
    for (const width of [WIDE, NARROW]) {
      const q = renderAt(width);

      expect(q.getByTestId("hud-weather")).toBeTruthy();
      q.unmount();
    }
  });

  it("shows the icon and nothing else, and says the reading in its name", async () => {
    // The owner's call: the temperature came off the button. It is still in the name,
    // which is not drawn, and at the top of the card.
    renderAt(WIDE);
    await settle();

    const button = screen.getByLabelText("Weather — Partly cloudy, 29°");
    expect(within(button).queryAllByText(/./)).toHaveLength(0);
    expect(button.props.accessibilityState).toEqual({ expanded: false });
  });

  it("pops out the conditions, the next hours and the week", async () => {
    mockApi.getWeather.mockResolvedValue(forecast());
    renderAt(WIDE);
    await settle();
    openCard();

    const card = within(screen.getByTestId("panel-environment"));
    expect(card.getByRole("header", { name: "Partly cloudy" })).toBeTruthy();
    expect(card.getByText("11 km/h SW")).toBeTruthy();

    // Every third hour from now, six of them.
    const hours = within(screen.getByTestId("weather-hours"));
    expect(hours.getByText("Now")).toBeTruthy();
    expect(hours.getByText("70%")).toBeTruthy(); // the one wet hour, three from now
    expect(hours.getAllByText(/°$/)).toHaveLength(6);

    // A week of days, named rather than dated.
    const days = within(screen.getByTestId("weather-days"));
    expect(days.getByText("Today")).toBeTruthy();
    expect(days.getByText("Tmrw")).toBeTruthy();
    expect(days.getByText("Thunderstorm")).toBeTruthy();
    expect(days.getAllByText("25° / 31°")).toHaveLength(7);

    expect(card.getByText("Manila · Sunrise 05:43 · Sunset 18:01")).toBeTruthy();
    expect(screen.getByTestId("hud-weather").props.accessibilityState).toEqual({ expanded: true });
  });

  it("closes on its own button, on its ✕ and on Escape", async () => {
    renderAt(WIDE);
    await settle();

    openCard();
    openCard();
    expect(screen.queryByTestId("panel-environment")).toBeNull();

    openCard();
    fireEvent.press(screen.getByLabelText("Close the weather"));
    expect(screen.queryByTestId("panel-environment")).toBeNull();

    openCard();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(screen.queryByTestId("panel-environment")).toBeNull();
  });

  it("is put away when an overlay opens over it", async () => {
    renderAt(WIDE);
    await settle();

    openCard();
    openSettings();
    fireEvent.press(screen.getByTestId("hud-settings-close"));

    // Not back, unasked for, the moment the glass goes.
    expect(screen.queryByTestId("panel-environment")).toBeNull();
  });

  it("says nobody has set a location, rather than that it is broken", async () => {
    mockApi.getWeather.mockResolvedValue({
      configured: false,
      available: false,
      message: "Set WEATHER_LATITUDE and WEATHER_LONGITUDE…",
    });
    renderAt(WIDE);
    await settle();

    // No number on the button when there is no reading.
    expect(within(screen.getByLabelText("Weather — no location set")).queryAllByText(/./)).toHaveLength(0);

    openCard();

    // Two different cards, because what the reader has to do about them is
    // different.
    expect(screen.getByText(/No location set/)).toBeTruthy();
  });

  it("distinguishes a forecast it could not fetch", async () => {
    mockApi.getWeather.mockResolvedValue({ configured: true, available: false });
    renderAt(WIDE);
    await settle();

    expect(screen.getByLabelText("Weather — unavailable")).toBeTruthy();
    openCard();
    expect(screen.getByText(/could not be fetched/)).toBeTruthy();
  });
});

/**
 * Optics: the camera, moved off the left rail onto a button of its own, on top
 * of the weather's, popping out the same glass card.
 *
 * What these assert is the owner's three asks — a popout, a button above the
 * weather's, one card at a time — and the rule the move brings with it: the
 * camera is on only while its card is out.
 */
describe("the optics popout", () => {
  const openOptics = () => fireEvent.press(screen.getByTestId("hud-optics"));
  const openWeather = () => fireEvent.press(screen.getByTestId("hud-weather"));

  it("is shut until asked for", async () => {
    renderAt(WIDE);
    await settle();

    expect(screen.queryByTestId("panel-camera")).toBeNull();
    expect(screen.getByTestId("hud-optics").props.accessibilityState).toEqual({ expanded: false });
  });

  it("is a button under the core, just above its caption", async () => {
    // Phase 11, the owner's call: off the weather's column, under the sphere.
    renderAt(WIDE);
    await settle();

    // In the stage's own flow, after the core and before "Standing by".
    const tree = JSON.stringify(screen.toJSON());
    const at = (needle: string) => tree.indexOf(needle);
    expect(at('"hud-optics-slot"')).toBeGreaterThan(at('"holographic-core"'));
    expect(at('"hud-optics-slot"')).toBeLessThan(at('"Standing by"'));
    expect(within(screen.getByTestId("hud-optics-slot")).getByTestId("hud-optics")).toBeTruthy();

    // The weather is alone at the bottom now.
    const bottom = within(screen.getByTestId("hud-popouts")).getAllByRole("button");
    expect(bottom.map((b) => b.props.accessibilityLabel)).toEqual(["Weather — Partly cloudy, 29°"]);
  });

  it("is on screen at every width", () => {
    for (const width of [WIDE, NARROW]) {
      const q = renderAt(width);

      expect(q.getByTestId("hud-optics")).toBeTruthy();
      q.unmount();
    }
  });

  it("puts the camera card at the top of the core's column, above the sphere, in glass", async () => {
    // The owner's call: button under the sphere, card above it, nothing over the core.
    renderAt(WIDE);
    await settle();
    openOptics();

    expect(screen.getByTestId("panel-camera")).toBeTruthy();
    expect(screen.getByTestId("hud-optics").props.accessibilityState).toEqual({ expanded: true });

    const centre = within(screen.getByTestId("hud-centre"));
    expect(within(centre.getByTestId("hud-optics-track")).getByTestId("hud-optics-card")).toBeTruthy();
    const track = flatStyle("hud-optics-track");
    expect(track.position).toBe("absolute");
    expect(track.top).toBeDefined();
    expect(track.bottom).toBeUndefined();
    expect(track.alignItems).toBe("center");
    // The strip either side of the card takes no clicks.
    expect(track.pointerEvents).toBe("box-none");

    const card = flatStyle("hud-optics-card");
    expect(card.transform[0]).toEqual({ translateY: 0 });
    expect(card.visibility).toBe("visible");
    // Shut, the weather card is hidden outright rather than only click-through,
    // so nothing in it can sit over this one.
    const shut = screen.getByTestId("hud-weather-card", { includeHiddenElements: true });
    expect(Object.assign({}, ...[shut.props.style].flat(3)).visibility).toBe("hidden");
    expect(screen.getByTestId("hud-optics-card").props.dataSet).toEqual({ glass: "true" });
    expect(card.backgroundColor).toBe("var(--c-glass)");
    expect(card.borderColor).toBe("var(--c-accentBd)");
  });

  it("is shut and out of reach until its button is pressed", () => {
    renderAt(WIDE);

    expect(flatStyle("hud-optics-track").pointerEvents).toBe("box-none");
    const card = screen.getByTestId("hud-optics-card", { includeHiddenElements: true });
    const style = Object.assign({}, ...[card.props.style].flat(3).filter(Boolean));
    expect(style.visibility).toBe("hidden");
    expect(style.pointerEvents).toBe("none");
  });

  it("keeps one card out at a time, whichever button is pressed", async () => {
    renderAt(WIDE);
    await settle();

    openWeather();
    openOptics();
    // The weather goes away as the camera comes out — not stacked under it.
    expect(screen.queryByTestId("panel-environment")).toBeNull();
    expect(screen.getByTestId("panel-camera")).toBeTruthy();
    expect(screen.getByTestId("hud-weather").props.accessibilityState).toEqual({ expanded: false });

    openWeather();
    expect(screen.queryByTestId("panel-camera")).toBeNull();
    expect(screen.getByTestId("panel-environment")).toBeTruthy();
    expect(screen.getByTestId("hud-optics").props.accessibilityState).toEqual({ expanded: false });
  });

  it("closes on its own button, on its ✕ and on Escape", async () => {
    renderAt(WIDE);
    await settle();

    openOptics();
    openOptics();
    expect(screen.queryByTestId("panel-camera")).toBeNull();

    openOptics();
    fireEvent.press(screen.getByLabelText("Close optics"));
    expect(screen.queryByTestId("panel-camera")).toBeNull();

    openOptics();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(screen.queryByTestId("panel-camera")).toBeNull();
  });

  it("turns the camera off when its card is put away, and does not reopen it", async () => {
    renderAt(WIDE);
    await settle();
    openOptics();

    fireEvent.press(screen.getByTestId("camera-toggle"));
    await waitFor(() =>
      expect(screen.getByTestId("camera-capture").props.accessibilityState.disabled).toBe(false),
    );
    const tracks = (await browserApis.getUserMedia.mock.results[0].value).getVideoTracks();

    // Put away by the other card, which is the way it is easiest not to notice.
    openWeather();
    expect(tracks[0].stop).toHaveBeenCalled();

    // A light on behind a shut card is one nobody can see the reason for, and
    // bringing the card back is not a press of Start.
    openOptics();
    expect(screen.UNSAFE_queryAllByType("video" as never)).toHaveLength(0);
    expect(screen.getByTestId("camera-toggle").props.accessibilityLabel).toBe("Start");
    expect(browserApis.getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("is put away when an overlay opens over it", async () => {
    renderAt(WIDE);
    await settle();

    openOptics();
    openSettings();
    fireEvent.press(screen.getByTestId("hud-settings-close"));

    expect(screen.queryByTestId("panel-camera")).toBeNull();
  });
});

describe("the agenda", () => {
  /**
   * A fixed noon on Thursday the 10th, so "left today" and "in 40m" mean the
   * same thing at whatever hour the suite runs. The endpoint has no default
   * window, so the other thing under test is that *this side* works out which
   * day is today and asks for it.
   */
  const NOON = new Date(2026, 8, 10, 12, 0);

  beforeEach(() => {
    // `advanceTimers` so the clock keeps moving under RNTL's own waits, and
    // only `Date` and the timers faked — the promises the mocks resolve with
    // must still settle.
    jest.useFakeTimers({ now: NOON, advanceTimers: true, doNotFake: ["nextTick", "queueMicrotask"] });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const at = (date: string, time: string, title: string, overrides: object = {}) => ({
    calendar_id: 1,
    title,
    starts_at: `${date}T${time}:00`,
    ends_at: null,
    all_day: false,
    location: null,
    ...overrides,
  });

  // The card is shut until its button is pressed, and RNTL's queries skip a
  // shut card, so every read of it opens it first.
  const panel = () => {
    if (!screen.queryByTestId("panel-agenda")) fireEvent.press(screen.getByTestId("hud-agenda"));

    return within(screen.getByTestId("panel-agenda"));
  };

  it("is a button top right, alone there, and shut until asked for", async () => {
    renderAt(WIDE);
    await settle();

    const track = flatStyle("hud-popouts-top-right");
    expect(track.right).toBe(flatStyle("hud-popouts").left);
    expect(track.top).toBeDefined();

    // The gear that sat under it moved into the core menu.
    const buttons = within(screen.getByTestId("hud-popouts-top-right")).getAllByRole("button");
    expect(buttons.map((b) => b.props.testID)).toEqual(["hud-agenda"]);

    expect(screen.queryByTestId("panel-agenda")).toBeNull();
    expect(within(screen.getByTestId("hud-agenda")).queryAllByText(/./)).toHaveLength(0);
  });

  it("says how much is left today in the button's name", async () => {
    mockApi.getCalendar.mockResolvedValue(
      calendarWindow({
        events: [at("2026-09-10", "15:00", "Dentist"), at("2026-09-10", "18:00", "Dinner")],
      }),
    );
    renderAt(WIDE);
    await settle();

    expect(screen.getByLabelText("Agenda — 2 left today")).toBeTruthy();
  });

  it("opens below the button, right edges level", async () => {
    renderAt(WIDE);
    await settle();
    panel();

    const card = flatStyle("hud-agenda-card");
    expect(card.top).toBe("100%");
    expect(card.right).toBe(0);
    expect(card.left).toBeUndefined();
    expect(screen.getByTestId("hud-agenda-card").props.dataSet).toEqual({ glass: "true" });
    // RN-Web stamps z-index 0 on every View, so an open slot has to outrank
    // its siblings', or the card paints under the next button in the column.
    const slot = screen.getByTestId("hud-agenda-card").parent!.parent!;
    expect(Object.assign({}, ...[slot.props.style].flat(3)).zIndex).toBe(1);
  });

  it("shows what is left of today, and not the days after it", async () => {
    mockApi.getCalendar.mockResolvedValue(
      calendarWindow({
        events: [
          at("2026-09-10", "15:00", "Dentist"),
          at("2026-09-12", "09:00", "Flight to Cebu"),
        ],
      }),
    );
    renderAt(WIDE);
    await settle();

    expect(panel().getByText("Dentist")).toBeTruthy();
    expect(panel().getByText("15:00")).toBeTruthy();
    expect(panel().queryByText("COMING UP")).toBeNull();
    expect(panel().queryByText("Flight to Cebu")).toBeNull();
  });

  it("keeps one card out at a time with Optics and the weather", async () => {
    renderAt(WIDE);
    await settle();

    panel();
    fireEvent.press(screen.getByTestId("hud-optics"));
    expect(screen.queryByTestId("panel-agenda")).toBeNull();
    expect(screen.getByTestId("panel-camera")).toBeTruthy();

    fireEvent.press(screen.getByTestId("hud-agenda"));
    expect(screen.queryByTestId("panel-camera")).toBeNull();
    fireEvent.press(screen.getByTestId("hud-weather"));
    expect(screen.queryByTestId("panel-agenda")).toBeNull();
  });

  it("closes on its own button, on its ✕ and on Escape, and when an overlay opens", async () => {
    renderAt(WIDE);
    await settle();

    panel();
    fireEvent.press(screen.getByTestId("hud-agenda"));
    expect(screen.queryByTestId("panel-agenda")).toBeNull();

    panel();
    fireEvent.press(screen.getByLabelText("Close the agenda"));
    expect(screen.queryByTestId("panel-agenda")).toBeNull();

    panel();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(screen.queryByTestId("panel-agenda")).toBeNull();

    panel();
    openSettings();
    fireEvent.press(screen.getByTestId("hud-settings-close"));
    expect(screen.queryByTestId("panel-agenda")).toBeNull();
  });

  it("counts down to the next thing that starts", async () => {
    mockApi.getCalendar.mockResolvedValue(
      calendarWindow({ events: [at("2026-09-10", "12:40", "Standup")] }),
    );
    renderAt(WIDE);
    await settle();

    expect(panel().getByTestId("agenda-next").props.children.join("")).toBe(
      "NEXT · in 40m · Standup",
    );
  });

  it("keeps a trip that began last week on today's list", async () => {
    // A Google calendar is full of spans. The window includes this one because
    // it overlaps today; a list keyed on start dates would drop it everywhere.
    mockApi.getCalendar.mockResolvedValue(
      calendarWindow({
        events: [
          at("2026-09-07", "00:00", "Leave", { all_day: true, ends_at: "2026-09-12T00:00:00" }),
        ],
      }),
    );
    renderAt(WIDE);
    await settle();

    expect(panel().getByText("Leave")).toBeTruthy();
    expect(panel().getByText("All day")).toBeTruthy();
  });

  it("brings today's all-day events to the top, where a busy day cannot push them off", async () => {
    mockApi.getCalendar.mockResolvedValue(
      calendarWindow({
        events: [
          at("2026-09-10", "00:00", "Holiday", { all_day: true, ends_at: "2026-09-11T00:00:00" }),
          at("2026-09-10", "13:00", "One"),
          at("2026-09-10", "14:00", "Two"),
          at("2026-09-10", "15:00", "Three"),
          at("2026-09-10", "16:00", "Four"),
          at("2026-09-10", "17:00", "Five"),
          at("2026-09-10", "18:00", "Six"),
          at("2026-09-10", "19:00", "Seven"),
        ],
      }),
    );
    renderAt(WIDE);
    await settle();

    // Six timed rows is the cap, and the holiday is not one of them.
    const band = within(panel().getByTestId("agenda-all-day"));
    expect(band.getByText("Holiday")).toBeTruthy();
    expect(band.getByText("All day")).toBeTruthy();
    expect(panel().getByText("Six")).toBeTruthy();
    expect(panel().queryByText("Seven")).toBeNull();
    expect(panel().getByText("+1 more today")).toBeTruthy();
  });

  it("makes tomorrow's all-day event next when nothing is left today", async () => {
    mockApi.getCalendar.mockResolvedValue(
      calendarWindow({
        events: [at("2026-09-11", "00:00", "Rosh Hashanah", { all_day: true, ends_at: "2026-09-12T00:00:00" })],
      }),
    );
    renderAt(WIDE);
    await settle();

    // The day, not "in 12h": a countdown to midnight says nothing about a holiday.
    expect(panel().getByTestId("agenda-next").props.children.join("")).toBe("NEXT · Tmrw · Rosh Hashanah");
  });

  it("drops what has already happened today rather than striking it through", async () => {
    // A four-row panel that spends two rows on things already done stops being
    // read by lunchtime. The whole day is behind ↗.
    mockApi.getCalendar.mockResolvedValue(
      calendarWindow({ events: [at("2026-09-10", "09:00", "Early standup")] }),
    );
    renderAt(WIDE);
    await settle();

    expect(panel().queryByText("Early standup")).toBeNull();
    expect(panel().getByText("Nothing left today.")).toBeTruthy();
  });

  it("colours each event by the calendar it came from", async () => {
    mockApi.getCalendar.mockResolvedValue(
      calendarWindow({
        feeds: [WORK, { ...WORK, id: 2, name: "Home", color: "tomato" }],
        events: [
          at("2026-09-10", "14:00", "Review", { calendar_id: 1 }),
          at("2026-09-10", "18:00", "Dinner", { calendar_id: 2 }),
        ],
      }),
    );
    renderAt(WIDE);
    await settle();

    const dots = panel()
      .getAllByTestId("agenda-dot")
      .map((d) => d.props.style.find((x: any) => x?.backgroundColor)?.backgroundColor);

    expect(dots).toEqual([CALENDAR_HEX.peacock, CALENDAR_HEX.tomato]);
    // And the legend says which colour is which.
    expect(within(screen.getByTestId("agenda-legend")).getByText("Home")).toBeTruthy();
  });

  it("says when a calendar could not be read, instead of drawing a free day", async () => {
    // The one thing the panel must never do silently: an empty afternoon
    // beside an unreachable calendar is not an empty afternoon.
    mockApi.getCalendar.mockResolvedValue(
      calendarWindow({ feeds: [{ ...WORK, status: "failed", fetched_at: null }] }),
    );
    renderAt(WIDE);
    await settle();

    expect(panel().getByText("Work is unreachable and has never been read.")).toBeTruthy();
    expect(screen.getByLabelText("Work, unreachable")).toBeTruthy();
  });

  it("asks for today and the week after it, in local dates", async () => {
    renderAt(WIDE);
    await settle();

    expect(mockApi.getCalendar).toHaveBeenCalledWith({ from: "2026-09-10", to: "2026-09-17" });
  });

  it("says where to connect one when there is no calendar yet", async () => {
    // The state this ships in. A blank box would read as a failed load.
    mockApi.getCalendar.mockResolvedValue(calendarWindow({ configured: false, feeds: [] }));
    renderAt(WIDE);
    await settle();

    expect(panel().getByText("No calendars connected. Add one in Settings.")).toBeTruthy();
    expect(screen.queryByTestId("agenda-legend")).toBeNull();
    expect(screen.getByLabelText("Agenda — no calendars connected")).toBeTruthy();
  });

  it("tells a switched-off calendar apart from an empty week", async () => {
    mockApi.getCalendar.mockResolvedValue(calendarWindow({ feeds: [] }));
    renderAt(WIDE);
    await settle();

    expect(panel().getByText("Every calendar is switched off in Settings.")).toBeTruthy();
  });

  it("opens Google Calendar in a new tab from ↗", async () => {
    // A click is a user gesture, so the page can open the tab itself — no
    // server tool, and no voice exemption, because leaving was the user's call.
    const open = jest.spyOn(window, "open").mockImplementation(() => null);
    renderAt(WIDE);
    await settle();

    fireEvent.press(panel().getByLabelText("Open Google Calendar"));

    expect(open).toHaveBeenCalledWith(
      "https://calendar.google.com/calendar",
      "_blank",
      "noopener,noreferrer",
    );
    open.mockRestore();
  });

  it("re-reads the calendar when Settings changes one", async () => {
    // A calendar added or recoloured shows when Settings closes, not two
    // minutes later on the next poll.
    mockApi.listCalendarFeeds.mockResolvedValue({ data: [WORK] });
    mockApi.updateCalendarFeed.mockResolvedValue({ ...WORK, color: "tomato" });
    renderAt(WIDE);
    await settle();
    const before = mockApi.getCalendar.mock.calls.length;

    openSettings();
    await settle();
    fireEvent.press(screen.getByTestId("calendar-color-1-tomato"));
    await settle();

    expect(mockApi.updateCalendarFeed).toHaveBeenCalledWith(1, { color: "tomato" });
    expect(mockApi.getCalendar.mock.calls.length).toBe(before + 1);
  });
});

describe("what the rails used to hold", () => {
  it("reads no nudges and no workouts any more", async () => {
    renderAt(WIDE);
    openMenu();
    await settle();

    expect(mockApi.listInsights).not.toHaveBeenCalled();
    expect(mockApi.listWorkouts).not.toHaveBeenCalled();
  });
});

describe("polling", () => {
  it("does not read anything while the HUD is not the screen you are on", () => {
    // Screens are hidden rather than unmounted, so a poller keyed off mounting
    // would keep asking for telemetry nobody has looked at since breakfast.
    mockDimensions.mockReturnValue({ width: WIDE, height: 900, scale: 1, fontScale: 1 });
    render(<Hud active={false} health={polled(HEALTH)} />, { wrapper: Providers });

    expect(mockApi.getSystemStats).not.toHaveBeenCalled();
    expect(mockApi.getWeather).not.toHaveBeenCalled();
  });

  it("keeps the last reading when a refresh fails", async () => {
    renderAt(WIDE);
    openStats();
    await settle();

    mockApi.getSystemStats.mockRejectedValue(new Error("network"));
    await act(async () => {
      jest.advanceTimersByTime?.(6_000);
      await Promise.resolve();
    });

    // A gauge that blanks on one dropped request flickers its way through a
    // wifi hiccup.
    expect(screen.getByText("34%")).toBeTruthy();
  });
});

describe("the assistant column", () => {
  it("says what the core's state means, so it is not only a colour", () => {
    renderAt(WIDE);

    expect(screen.getByLabelText("Assistant idle")).toBeTruthy();
    expect(screen.getByText("Standing by")).toBeTruthy();
  });

  describe("when it cannot answer", () => {
    const stageHint = () => screen.getByTestId("hud-stage-hint").props.children;
    const withHealth = (patch: Partial<Health>, extra: Partial<Polled<Health>> = {}) =>
      renderAt(WIDE, polled({ ...HEALTH, ...patch }, extra));

    it("turns amber and keeps moving when the switch is off", () => {
      withHealth({ assistant: { ...HEALTH.assistant, enabled: false, state: "off" } });

      expect(screen.getByLabelText("Assistant switched off")).toBeTruthy();
      expect(screen.getByText("Switched off")).toBeTruthy();
      expect(stageHint()).toMatch(/switched off/);
    });

    it("fails, and says why, when it is on and has no key", () => {
      withHealth({ assistant: { ...HEALTH.assistant, configured: false, state: "down" } });

      expect(screen.getByLabelText("Assistant failed")).toBeTruthy();
      // Not "that run failed": no run did.
      expect(screen.getByText("Unavailable")).toBeTruthy();
      expect(stageHint()).toBe("There's no ANTHROPIC_API_KEY in backend/.env.");
    });

    it("fails, and names the account, when Anthropic has refused a call for credit", () => {
      withHealth({
        assistant: {
          ...HEALTH.assistant,
          credit: { exhausted: true, since: "2026-09-29T08:00:00+00:00", last_refused_at: "2026-09-29T09:00:00+00:00" },
        },
      });

      expect(screen.getByLabelText("Assistant failed")).toBeTruthy();
      expect(stageHint()).toMatch(/out of credit/);
    });

    it("fails when the queue worker has stopped, but not when it never ran", () => {
      withHealth({ queue: { ...HEALTH.queue, state: "down" } });
      expect(screen.getByLabelText("Assistant failed")).toBeTruthy();
      expect(stageHint()).toMatch(/queue worker is down/);
      screen.unmount();

      withHealth({ queue: { ...HEALTH.queue, state: "unknown" } });
      expect(screen.getByLabelText("Assistant idle")).toBeTruthy();
    });

    it("fails when the API cannot be reached at all", () => {
      renderAt(WIDE, polled(null, { error: "network" }));

      expect(screen.getByLabelText("Assistant failed")).toBeTruthy();
      expect(stageHint()).toBe("Can't reach the API.");
    });

    it("claims nothing before the first reading, or over one dropped poll", () => {
      renderAt(WIDE, polled(null, { loading: true, latencyMs: null }));
      expect(screen.getByLabelText("Assistant idle")).toBeTruthy();
      screen.unmount();

      withHealth({}, { error: "network" });
      expect(screen.getByLabelText("Assistant idle")).toBeTruthy();
    });

    it("says the same reason in the full Assistant", () => {
      withHealth({ database: { state: "down" } });
      openAssistant();

      expect(
        within(screen.getByTestId("hud-full")).getByText("The database isn't answering."),
      ).toBeTruthy();
    });
  });

  it("has no preview row under the core any more", () => {
    // The owner removed it in Phase 11: the core shows only what is happening.
    renderAt(WIDE);

    expect(screen.queryByText("PREVIEW STATE")).toBeNull();
    expect(screen.queryByText("listening")).toBeNull();
  });

  it("turns the sphere over to the call, and back at each end of it", async () => {
    renderAt(WIDE);
    await settle();

    fireEvent.press(screen.getByLabelText("Talk to the assistant"));

    // Asked for, not open: the sphere must not claim to be hearing anything
    // while the permission prompt is still up. That was the lie the ring's CSS
    // clock told before 7.3, and opening a line is two awaits deep.
    expect(screen.getByLabelText("Assistant idle")).toBeTruthy();

    await waitFor(() => expect(mockSessions.length).toBeGreaterThan(0));
    const session = mockSessions[mockSessions.length - 1];

    await act(async () => session.options.onConnect?.());

    // `listening` was scaffolding until 7.3; this is the assertion that it is
    // not any more.
    expect(screen.getByLabelText("Assistant listening")).toBeTruthy();

    const bars = screen
      .UNSAFE_getAllByType("g" as never)
      .map((n) => String((n.props as any).style?.transform ?? ""))
      .filter((t) => t.includes("var(--h-voice, 0)"));

    expect(bars).toHaveLength(56);

    // The other end of the same call, and the reason `speaking` is a state of
    // its own rather than a shade of `listening`: the very same ring is driven
    // from the speaker here and from the microphone above.
    await act(async () => session.options.onModeChange?.({ mode: "speaking" }));

    expect(screen.getByLabelText("Assistant speaking")).toBeTruthy();
  });

  /**
   * The one stretch of a spoken conversation with nothing else to show for it.
   *
   * A typed message is answered by a queued run the screen watches, so the
   * sphere moves off run events. A spoken one is answered inside the client
   * tool's own await — no run to watch — and without this the sphere sits
   * listening through the five to fifteen seconds the tool loop takes.
   */
  it("sweeps while a spoken question is in the loop", async () => {
    renderAt(WIDE);
    await settle();

    fireEvent.press(screen.getByLabelText("Talk to the assistant"));

    await waitFor(() => expect(mockSessions.length).toBeGreaterThan(0));
    const session = mockSessions[mockSessions.length - 1];
    await act(async () => session.options.onConnect?.());

    // Held open, so the sphere can be looked at mid-question.
    let answer: (value: { text: string; conversation_id: number }) => void = () => {};
    mockApi.voiceTurn.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }) as never,
    );

    let asked: Promise<string> = Promise.resolve("");
    await act(async () => {
      asked = session.options.clientTools.ask_life_os({ question: "how was last week?" });
    });

    expect(screen.getByLabelText("Assistant working")).toBeTruthy();

    await act(async () => {
      answer({ text: "Four times.", conversation_id: 1 });
      await asked;
    });
  });
});

/** Every host element's style on one node, flattened the way RN-Web would. */
function flatStyle(id: string, includeHiddenElements = false) {
  const raw = [screen.getByTestId(id, { includeHiddenElements }).props.style].flat(3).filter(Boolean);

  return Object.assign({}, ...raw);
}

/** A thread with something in it, so "the same one" is a question with an answer. */
function withThread(text: string) {
  mockApi.listConversations.mockResolvedValue({
    data: [{ id: 7, title: "last week", created_at: null, last_message_at: null }],
  } as any);
  mockApi.getConversation.mockResolvedValue({
    conversation: { id: 7, title: "last week", created_at: null, last_message_at: null },
    messages: [{ id: 1, role: "assistant", content: [{ type: "text", text }], created_at: null }],
    pending_actions: [],
    run: null,
  } as any);
}

/**
 * The microphone, under the core beside the camera's button.
 *
 * It was the big button in the bottom-right corner, with a chat button stacked
 * over it, until 13.0: the chat button went (the typed conversation is the core
 * menu's Assistant title, or ⌘K) and the microphone came under the core at the
 * camera button's size. What these assert is that it is there at every width,
 * that it is the only thing left of the corner, and that talking and typing stay
 * two different doors.
 */
describe("the microphone", () => {
  it("sits under the core beside the camera's button, at every width", () => {
    for (const width of [WIDE, NARROW]) {
      const q = renderAt(width);

      const slot = within(q.getByTestId("hud-optics-slot"));
      expect(slot.getByLabelText("Talk to the assistant")).toBeTruthy();
      expect(slot.getByTestId("hud-optics")).toBeTruthy();
      // No popover, so there is nothing to type into on the HUD itself.
      expect(q.queryByLabelText("Message")).toBeNull();
      q.unmount();
    }
  });

  it("comes after the camera, in a row", () => {
    renderAt(WIDE);

    const order = screen
      .getByTestId("hud-optics-slot")
      .findAll((n: any) => typeof n.type === "string" && ["hud-optics", "hud-talk"].includes(n.props.testID))
      .map((n: any) => n.props.testID);

    expect(order).toEqual(["hud-optics", "hud-talk"]);
    expect(flatStyle("hud-optics-slot").flexDirection).toBe("row");
  });

  it("is the camera button's size, and edged in the accent", () => {
    renderAt(WIDE);

    const mic = flatStyle("hud-talk");
    const camera = flatStyle("hud-optics");
    expect([mic.width, mic.height, mic.borderRadius]).toEqual([camera.width, camera.height, camera.borderRadius]);
    expect(mic.borderColor).toBe("var(--c-accentBd)");
  });

  it("leaves the bottom-right corner empty, with no chat button anywhere", () => {
    renderAt(WIDE);

    expect(screen.queryByTestId("hud-chat", { includeHiddenElements: true })).toBeNull();
    expect(screen.queryByTestId("hud-launchers", { includeHiddenElements: true })).toBeNull();
    expect(screen.queryByLabelText("Open the assistant")).toBeNull();
  });

  it("carries an icon and no words", () => {
    // The words moved rather than vanished: into its name, and into the caption
    // under the core.
    renderAt(WIDE);

    expect(within(screen.getByTestId("hud-talk")).queryAllByText(/./)).toHaveLength(0);
  });

  it("talks without opening anything to type into", async () => {
    renderAt(WIDE);
    await settle();

    fireEvent.press(screen.getByLabelText("Talk to the assistant"));
    await waitFor(() => expect(mockSessions).toHaveLength(1));

    // The microphone's one job. The popover it used to open is gone, and the
    // full Assistant is the core menu's.
    expect(screen.queryByLabelText("Message")).toBeNull();
    expect(screen.queryByLabelText("Close full Assistant")).toBeNull();
  });

  it("leaves the typed conversation to the core menu", async () => {
    renderAt(WIDE);
    await settle();

    openAssistant();

    expect(screen.getByLabelText("Close full Assistant")).toBeTruthy();
    expect(within(screen.getByTestId("hud-full-body")).getByLabelText("Message")).toBeTruthy();
    // Opening a place to type is not opening a line to a third party.
    expect(mockApi.voiceToken).not.toHaveBeenCalled();
  });

  it("keeps the microphone out of the typed conversation", async () => {
    renderAt(WIDE);
    await settle();

    openAssistant();

    expect(
      within(screen.getByTestId("hud-full-body")).queryByLabelText("Talk to the assistant"),
    ).toBeNull();
  });

  /**
   * The camera's Remove bug, with a live microphone on the end of it: a
   * control whose job is to *stop* something must not be closed by the state
   * it would stop. Everything that would start something is correctly closed
   * while a write is parked.
   */
  it("closes the microphone while a write is parked", async () => {
    mockApi.listConversations.mockResolvedValue({
      data: [{ id: 1, title: "last week", created_at: null, last_message_at: null }],
    } as any);
    mockApi.getConversation.mockResolvedValue({
      conversation: { id: 1, title: "last week", created_at: null, last_message_at: null },
      messages: [
        {
          id: 1,
          role: "assistant",
          content: [{ type: "tool_use", id: "tu_1", name: "log_workout", input: {} }],
          created_at: null,
        },
      ],
      pending_actions: [
        {
          id: 9,
          tool: "log_workout",
          input: { title: "Push Day" },
          requires_confirmation: true,
          status: "pending",
          result: null,
          is_error: false,
          decided_at: null,
          created_at: null,
        },
      ],
      run: null,
    } as any);

    renderAt(WIDE);

    await waitFor(() =>
      expect(screen.getByTestId("hud-talk").props.accessibilityState.disabled).toBe(true),
    );
  });
});

/**
 * The spoken conversation, from the HUD's microphone.
 *
 * These lived in the full Assistant's suite while Talk was in its composer. The
 * seam they protect did not move with the button: the audio and the turn-taking
 * happen at ElevenLabs, and the *answer* comes from the same tool loop a typed
 * message runs, through a client tool that lives in this page. Every assertion
 * here is on that boundary — what is asked for before a microphone opens, what
 * is sent when a question arrives, and what is said on screen meanwhile.
 */
describe("the spoken conversation", () => {
  /** Let the newest session finish opening, and report itself connected. */
  async function connect() {
    await waitFor(() => expect(mockSessions.length).toBeGreaterThan(0));

    const session = mockSessions[mockSessions.length - 1];
    await act(async () => session.options.onConnect?.());

    return session;
  }

  /** Call the client tool the way the ElevenLabs agent would. */
  function ask(params: unknown): Promise<string> {
    return mockSessions[mockSessions.length - 1].options.clientTools.ask_life_os(params);
  }

  const hint = () => screen.getByTestId("hud-stage-hint").props.children;

  it("asks the server for permission rather than holding a key", async () => {
    renderAt(WIDE);
    await settle();

    fireEvent.press(screen.getByLabelText("Talk to the assistant"));
    await waitFor(() => expect(mockSessions).toHaveLength(1));

    // The whole reason the token route exists: an EXPO_PUBLIC_* value is
    // inlined into the bundle, so the page is handed a token scoped to one
    // session and never the ElevenLabs key.
    expect(mockApi.voiceToken).toHaveBeenCalled();
    expect(mockSessions[0].options.conversationToken).toBe("tok_test");
    expect(mockSessions[0].options.connectionType).toBe("webrtc");
  });

  it("says where the audio goes before the press, and while the line is open", async () => {
    renderAt(WIDE);
    await settle();

    // A button that opens a microphone to a third party and says nothing is
    // not asking for consent, it is assuming it — and this one is an icon, so
    // the caption under the core is where it says so.
    expect(hint()).toMatch(/goes to ElevenLabs/);

    fireEvent.press(screen.getByLabelText("Talk to the assistant"));

    // Asked for, not open. The permission prompt may still be up, and nothing
    // is being captured.
    await waitFor(() => expect(hint()).toBe("Opening the line…"));
    expect(screen.getByLabelText("End the spoken conversation")).toBeTruthy();

    await connect();

    expect(hint()).toMatch(/goes to ElevenLabs until you stop/);
  });

  it("puts a spoken question through the same loop, into the thread the HUD holds", async () => {
    withThread("You trained four times.");
    renderAt(WIDE);
    await waitFor(() => expect(mockApi.getConversation).toHaveBeenCalledWith(7));

    fireEvent.press(screen.getByLabelText("Talk to the assistant"));
    await connect();

    mockApi.voiceTurn.mockResolvedValue({ text: "Four times.", conversation_id: 7 });
    const reads = mockApi.getConversation.mock.calls.length;

    const spoken = await act(async () => ask({ question: "how was last week?" }));

    // The thread being held is the thread it lands in — one transcript and one
    // audit log out of speaking and typing.
    expect(mockApi.voiceTurn).toHaveBeenCalledWith("how was last week?", 7);
    // Returned to the agent, which reads it out.
    expect(spoken).toBe("Four times.");
    // Re-read rather than mirrored: the runner wrote the rows already.
    expect(mockApi.getConversation.mock.calls.length).toBe(reads + 1);
  });

  it("adopts the thread the server made when none was open, for the Assistant to open on", async () => {
    renderAt(WIDE);
    await settle();

    fireEvent.press(screen.getByLabelText("Talk to the assistant"));
    await connect();

    mockApi.voiceTurn.mockResolvedValue({ text: "Four times.", conversation_id: 12 });
    mockApi.getConversation.mockResolvedValue({
      conversation: { id: 12, title: "how was last week?", created_at: null, last_message_at: null },
      messages: [{ id: 1, role: "assistant", content: [{ type: "text", text: "Four times." }], created_at: null }],
      pending_actions: [],
      run: null,
    } as any);

    await act(async () => ask({ question: "how was last week?" }));

    expect(mockApi.voiceTurn).toHaveBeenCalledWith("how was last week?", null);

    openAssistant();
    await waitFor(() =>
      expect(within(screen.getByTestId("hud-full-body")).getByText("Four times.")).toBeTruthy(),
    );
  });

  it("answers a tool call with no question in it rather than asking nothing", async () => {
    renderAt(WIDE);
    await settle();

    fireEvent.press(screen.getByLabelText("Talk to the assistant"));
    await connect();

    // Their router model picks the arguments, so this is a bad turn rather
    // than an impossibility — and putting it through the loop pays Anthropic
    // to be asked nothing.
    const spoken = await act(async () => ask({}));

    expect(spoken).toMatch(/did not catch/i);
    expect(mockApi.voiceTurn).not.toHaveBeenCalled();
  });

  it("hands a refusal to the agent as words, because it will read them out", async () => {
    renderAt(WIDE);
    await settle();

    fireEvent.press(screen.getByLabelText("Talk to the assistant"));
    await connect();

    mockApi.voiceTurn.mockRejectedValue(
      Object.assign(new Error("There is a pending action waiting to be approved on screen, Sir."), {
        status: 409,
      }),
    );

    const spoken = await act(async () => ask({ question: "how was last week?" }));

    expect(spoken).toMatch(/pending action/);
  });

  it("puts a refusal to open the line under the core, where the button's presser is looking", async () => {
    mockApi.voiceToken.mockRejectedValue(
      Object.assign(new Error("Set ELEVENLABS_AGENT_ID to the id of the Life OS agent."), {
        status: 503,
      }),
    );

    renderAt(WIDE);
    await settle();

    fireEvent.press(screen.getByLabelText("Talk to the assistant"));

    // With no token there is no session, and the icon has nowhere to put a
    // sentence — so the core's caption carries it.
    await waitFor(() => expect(hint()).toMatch(/ELEVENLABS_AGENT_ID/));
    expect(mockSessions).toHaveLength(0);
    expect(screen.getByLabelText("Talk to the assistant")).toBeTruthy();
  });

  it("ends the line when the button is pressed again", async () => {
    renderAt(WIDE);
    await settle();

    fireEvent.press(screen.getByLabelText("Talk to the assistant"));
    await connect();

    expect(screen.getByTestId("hud-talk").props.accessibilityState.selected).toBe(true);

    fireEvent.press(screen.getByLabelText("End the spoken conversation"));

    await waitFor(() => expect(mockSessions[0].endSession).toHaveBeenCalled());
    expect(screen.getByLabelText("Talk to the assistant")).toBeTruthy();
  });

  describe("leaving the tab", () => {
    function setVisibility(state: "hidden" | "visible") {
      act(() => {
        Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
        document.dispatchEvent(new Event("visibilitychange"));
      });
    }

    // Every other test in the file assumes a tab someone is looking at.
    afterEach(() => setVisibility("visible"));

    it("ends the line when you switch to another tab", async () => {
      renderAt(WIDE);
      await settle();

      fireEvent.press(screen.getByLabelText("Talk to the assistant"));
      const session = await connect();

      setVisibility("hidden");

      // A microphone to a third party, still open behind a tab nobody is
      // looking at, is the thing the rule exists to prevent.
      expect(session.endSession).toHaveBeenCalled();
      expect(screen.getByLabelText("Talk to the assistant")).toBeTruthy();
    });

    it("keeps the line through the tab the assistant opens, so the answer is still spoken", async () => {
      renderAt(WIDE);
      await settle();

      fireEvent.press(screen.getByLabelText("Talk to the assistant"));
      const session = await connect();

      // "Show me my week": the server opens Google Calendar in a tab, in
      // front, while the question is still in the loop — so the HUD goes
      // hidden before the answer has come back.
      let answer!: (value: { text: string; conversation_id: number }) => void;
      mockApi.voiceTurn.mockReturnValue(new Promise((resolve) => (answer = resolve)));

      let spoken!: Promise<string>;
      act(() => {
        spoken = ask({ question: "show me my week" });
      });

      setVisibility("hidden");
      expect(session.endSession).not.toHaveBeenCalled();

      await act(async () => answer({ text: "It is on your screen, Sir.", conversation_id: 7 }));

      // Handed to the agent to read out, over a line that is still open.
      await expect(spoken).resolves.toBe("It is on your screen, Sir.");
      expect(session.endSession).not.toHaveBeenCalled();
      expect(screen.getByLabelText("End the spoken conversation")).toBeTruthy();

      // Excused once, not for good: come back and leave again, and it is an
      // ordinary tab switch.
      setVisibility("visible");
      setVisibility("hidden");
      expect(session.endSession).toHaveBeenCalled();
    });
  });
});

/**
 * The Assistant, given the whole window — and the only place to type.
 *
 * There is no Assistant tab and no popover, so the thing to prove is that the
 * conversation is still reachable in full, over the HUD rather than instead of
 * it, and that it is *the same conversation* the microphone writes into — one
 * `useConversation`, shared.
 */
describe("the full Assistant", () => {
  it("is not reachable until the core menu opens it", async () => {
    renderAt(WIDE);
    await settle();

    // Mounted so it can animate, and therefore hidden rather than merely
    // invisible — the rule every other surface here follows.
    expect(screen.queryByLabelText("Close full Assistant")).toBeNull();
    expect(screen.queryByTestId("hud-full-spine")).toBeNull();

    openAssistant();

    expect(screen.getByLabelText("Close full Assistant")).toBeTruthy();
    // The console's spine, which is the only title it has.
    expect(screen.getByTestId("hud-full-spine")).toBeTruthy();
  });

  it("opens on the thread the HUD is holding rather than starting one", async () => {
    withThread("four sessions, all pushing");
    renderAt(WIDE);
    await waitFor(() => expect(mockApi.getConversation).toHaveBeenCalled());
    await settle();

    openAssistant();

    await waitFor(() =>
      expect(
        within(screen.getByTestId("hud-full-body")).getByText("four sessions, all pushing"),
      ).toBeTruthy(),
    );
    // One controller, not two. A second `useConversation` would have listed the
    // threads and fetched one again, and would have picked its own.
    expect(mockApi.getConversation).toHaveBeenCalledTimes(1);
    expect(mockApi.createConversation).not.toHaveBeenCalled();
  });

  it("fades in rather than appearing, and is inert until it has", async () => {
    renderAt(WIDE);
    await settle();

    expect(flatStyle("hud-full").transitionProperty).toBe("opacity, transform, visibility");
    expect(flatStyle("hud-full").opacity).toBe(0);
    expect(flatStyle("hud-full").pointerEvents).toBe("none");
    // Its disabled Send would otherwise stay clickable through the shut frame.
    expect(flatStyle("hud-full").visibility).toBe("hidden");

    openAssistant();

    expect(flatStyle("hud-full").opacity).toBe(1);
    expect(flatStyle("hud-full").pointerEvents).toBe("auto");
    expect(flatStyle("hud-full").visibility).toBe("visible");
  });

  it("closes on its own control, leaving the HUD where it was", async () => {
    renderAt(WIDE);
    openAssistant();
    await settle();

    fireEvent.press(screen.getByLabelText("Close full Assistant"));

    expect(screen.queryByLabelText("Close full Assistant")).toBeNull();
    // Over the HUD, never instead of it: the core has been there throughout.
    expect(screen.getByLabelText("Assistant idle")).toBeTruthy();
  });

  it("closes on Escape, and does nothing with one while it is shut", async () => {
    renderAt(WIDE);
    await settle();

    // The calendar drawer binds its own listener on exactly these terms, so an
    // overlay that acted while shut would answer an Escape meant for it.
    const escape = () =>
      act(() => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      });

    escape();

    openAssistant();
    expect(screen.getByLabelText("Close full Assistant")).toBeTruthy();

    escape();
    expect(screen.queryByLabelText("Close full Assistant")).toBeNull();
  });
});

/**
 * Settings, moved off the menu and onto the HUD.
 *
 * It was a screen, and the property worth holding onto is the one that made it
 * move: it opens over the HUD, in the Assistant's glass frame, and closes back
 * onto a HUD that never went anywhere.
 */
describe("Settings", () => {
  const escape = () =>
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });

  it("is no longer a gear, but the Core title of the core menu", () => {
    renderAt(WIDE);

    expect(screen.queryByLabelText("Settings")).toBeNull();
    openMenu();
    expect(within(screen.getByTestId("core-menu-panel-core")).getByLabelText("Open Settings")).toBeTruthy();
  });

  it("is not reachable until the core menu opens it", () => {
    renderAt(WIDE);

    expect(screen.queryByText("Appearance")).toBeNull();
    expect(screen.queryByTestId("hud-settings-spine")).toBeNull();

    openSettings();

    expect(within(screen.getByTestId("hud-settings-body")).getByText("Appearance")).toBeTruthy();
    expect(screen.getByTestId("hud-settings-spine").props.children).toBe("SETTINGS");
  });

  it("opens in the Assistant's frame: glass, faded in, inert until it has", () => {
    renderAt(WIDE);

    expect(screen.getByTestId("hud-settings").props.dataSet).toEqual({ glass: "true" });
    expect(flatStyle("hud-settings").transitionProperty).toBe("opacity, transform, visibility");
    expect(flatStyle("hud-settings").pointerEvents).toBe("none");
    expect(flatStyle("hud-settings").visibility).toBe("hidden");

    openSettings();

    expect(flatStyle("hud-settings").opacity).toBe(1);
    expect(flatStyle("hud-settings").pointerEvents).toBe("auto");
    expect(flatStyle("hud-settings").visibility).toBe("visible");
  });

  it("is hidden while shut, not only click-through — its disabled buttons included", () => {
    // Found in a browser, not here: RN-Web renders a disabled Pressable as
    // `box-none`, whose rule turns pointer events back on for its label. So the
    // shut Settings' disabled "Add calendar" stayed clickable over the Optics ✕
    // until Settings had been opened once. `visibility: hidden` cannot be
    // re-enabled from below; this pins that the layer sets it.
    renderAt(WIDE);

    expect(flatStyle("hud-settings").visibility).toBe("hidden");
    openSettings();
    fireEvent.press(screen.getByLabelText("Close Settings"));
    expect(flatStyle("hud-settings").visibility).toBe("hidden");
  });

  it("closes on its own control and on Escape, leaving the HUD where it was", () => {
    renderAt(WIDE);

    openSettings();
    fireEvent.press(screen.getByLabelText("Close Settings"));
    expect(screen.queryByText("Appearance")).toBeNull();
    expect(screen.getByLabelText("Assistant idle")).toBeTruthy();

    openSettings();
    escape();
    expect(screen.queryByText("Appearance")).toBeNull();
  });

  it("gives way to the conversation on ⌘K rather than opening it underneath", () => {
    // Each overlay covers the whole HUD, so a second one opened beneath the
    // first would be a layer nobody can see.
    renderAt(WIDE);
    openSettings();

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
    });

    expect(screen.getByLabelText("Close full Assistant")).toBeTruthy();
    expect(screen.queryByText("Appearance")).toBeNull();
  });

  it("no longer holds the Anthropic switch", () => {
    renderAt(WIDE);
    openSettings();

    expect(within(screen.getByTestId("hud-settings-body")).queryByTestId("anthropic-toggle")).toBeNull();
  });
});

/**
 * The key, and the dot.
 *
 * Both are about a conversation that is *not* on screen — a shortcut that only
 * works where you can see what it did, and a signal for an answer that arrived
 * while you were looking at something else.
 */
describe("the keyboard", () => {
  const press = (key: string, mods: Partial<KeyboardEventInit> = {}) =>
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key, ...mods }));
    });

  it("opens the typed conversation and closes it again", () => {
    renderAt(WIDE);

    press("k", { metaKey: true });
    expect(screen.getByLabelText("Close full Assistant")).toBeTruthy();

    press("k", { ctrlKey: true });
    expect(screen.queryByLabelText("Close full Assistant")).toBeNull();
  });

  it("lands on Chat, even when the Assistant was left on Settings", async () => {
    renderAt(WIDE);
    await settle();
    openAssistant();
    fireEvent.press(within(screen.getByTestId("hud-full-body")).getByRole("tab", { name: "Settings" }));
    fireEvent.press(screen.getByLabelText("Close full Assistant"));

    press("k", { metaKey: true });
    expect(within(screen.getByTestId("hud-full-body")).getByLabelText("Message")).toBeTruthy();

    // Over Settings it goes to Chat rather than closing, since Chat is what it names.
    fireEvent.press(within(screen.getByTestId("hud-full-body")).getByRole("tab", { name: "Settings" }));
    press("k", { metaKey: true });
    expect(within(screen.getByTestId("hud-full-body")).getByLabelText("Message")).toBeTruthy();
    press("k", { metaKey: true });
    expect(screen.queryByLabelText("Close full Assistant")).toBeNull();
  });

  it("never opens the microphone", () => {
    // A key pressed on a keyboard is somebody about to type, and a shortcut is
    // pressed where nobody can see it — the one way a line to a third party
    // must never open.
    renderAt(WIDE);

    press("k", { metaKey: true });

    expect(mockApi.voiceToken).not.toHaveBeenCalled();
  });

  it("binds nothing while the HUD is not the screen you are on", () => {
    // Screens are hidden rather than unmounted, so a listener keyed off
    // mounting would open an overlay onto a HUD nobody is looking at.
    mockDimensions.mockReturnValue({ width: WIDE, height: 900, scale: 1, fontScale: 1 });
    render(<Hud active={false} health={polled(HEALTH)} />, { wrapper: Providers });

    press("k", { metaKey: true });

    expect(screen.queryByLabelText("Close full Assistant")).toBeNull();
  });

  it("leaves a plain k to the composer it would otherwise be typed into", () => {
    renderAt(WIDE);

    press("k");

    expect(screen.queryByLabelText("Close full Assistant")).toBeNull();
  });

  it("listens where the composer cannot swallow it", () => {
    // Found in a browser and unreachable from here: RN-Web's `TextInput` calls
    // `stopPropagation()` on every keydown, so a listener bound the ordinary
    // way is deaf to any key pressed while the composer has focus — which is
    // to say, Escape worked everywhere except inside the thing it closes. This
    // preset renders through `react-test-renderer` and has no DOM propagation
    // to swallow anything, so the phase is what there is to assert.
    const spy = jest.spyOn(window, "addEventListener");
    renderAt(WIDE);

    const bound = spy.mock.calls.filter(([type]) => type === "keydown");

    expect(bound.length).toBeGreaterThan(0);
    expect(bound.every(([, , capture]) => capture === true)).toBe(true);
    spy.mockRestore();
  });
});

describe("the unread signal", () => {
  /** A thread with an answer already in it, and a run still going. */
  function midRun(text: string) {
    mockApi.listConversations.mockResolvedValue({
      data: [{ id: 7, title: "last week", created_at: null, last_message_at: null }],
    } as any);
    mockApi.getConversation.mockResolvedValue({
      conversation: { id: 7, title: "last week", created_at: null, last_message_at: null },
      messages: [{ id: 1, role: "assistant", content: [{ type: "text", text }], created_at: null }],
      pending_actions: [],
      run: {
        id: "run-9",
        conversation_id: 7,
        trigger: "message",
        status: "running",
        finished: false,
        error: null,
        created_at: null,
      },
    } as any);
  }

  /** What the thread looks like once that run has written its answer. */
  function answered(text: string) {
    mockApi.getConversation.mockResolvedValue({
      conversation: { id: 7, title: "last week", created_at: null, last_message_at: null },
      messages: [
        { id: 1, role: "assistant", content: [{ type: "text", text: "four sessions" }], created_at: null },
        { id: 2, role: "assistant", content: [{ type: "text", text }], created_at: null },
      ],
      pending_actions: [],
      run: null,
    } as any);
  }

  const finish = async () => {
    await act(async () => {
      await mockWatchRun.mock.calls[0][1].onDone();
    });
  };

  /**
   * "new reply" beside the core menu's Assistant title. The menu is shut unless
   * the test opened it, so this opens it to look — the signal is also the
   * caption, which needs no menu, and `caption` reads that.
   */
  const dot = () => {
    openMenu();
    const title = screen.getByTestId("core-menu-title-assistant");
    const lit = within(title).queryByText(/new reply/);
    fireEvent.press(screen.getByTestId("hud-core"));

    return lit;
  };
  const caption = () => screen.getByTestId("hud-stage-hint").props.children;

  it("says nothing about a conversation you have only just arrived at", async () => {
    midRun("four sessions");
    renderAt(WIDE);
    await settle();
    // The watcher starts inside the same `then` that stores the transcript, so
    // this is the transcript being on screen and not merely on its way.
    await waitFor(() => expect(mockWatchRun).toHaveBeenCalled());
    await settle();

    // Yesterday's answer is not something said while nobody was looking, and a
    // dot on every reload is a dot that stops meaning anything.
    expect(dot()).toBeNull();
    expect(caption()).not.toMatch(/new reply/);
  });

  it("lights up when the answer lands with the conversation shut", async () => {
    midRun("four sessions");
    renderAt(WIDE);
    await settle();
    await waitFor(() => expect(mockWatchRun).toHaveBeenCalled());

    answered("and a PR on Tuesday");
    await finish();

    expect(dot()).toBeTruthy();
    // Said under the core too, with the way to it, and in the title's name.
    expect(caption()).toBe("A new reply — ⌘K, or click the core and then Assistant.");
    openMenu();
    expect(screen.getByLabelText("Open the Assistant — a new reply")).toBeTruthy();
  });

  it("stays quiet when announcing replies is switched off", async () => {
    localStorage.setItem(ASSISTANT_PREFS_STORAGE_KEY, JSON.stringify({ unreadSignal: false, openOn: "last" }));
    midRun("four sessions");
    renderAt(WIDE);
    await settle();
    await waitFor(() => expect(mockWatchRun).toHaveBeenCalled());

    answered("and a PR on Tuesday");
    await finish();

    expect(dot()).toBeNull();
    expect(caption()).not.toMatch(/new reply/);
  });

  it("is not read by the Assistant's Settings tab", async () => {
    midRun("four sessions");
    renderAt(WIDE);
    await settle();
    await waitFor(() => expect(mockWatchRun).toHaveBeenCalled());
    openAssistant();
    fireEvent.press(within(screen.getByTestId("hud-full-body")).getByRole("tab", { name: "Settings" }));

    answered("and a PR on Tuesday");
    await finish();
    fireEvent.press(screen.getByLabelText("Close full Assistant"));

    expect(caption()).toMatch(/new reply/);
  });

  it("clears the moment the conversation is opened", async () => {
    midRun("four sessions");
    renderAt(WIDE);
    await settle();
    await waitFor(() => expect(mockWatchRun).toHaveBeenCalled());

    answered("and a PR on Tuesday");
    await finish();

    expect(dot()).toBeTruthy();

    openAssistant();

    expect(dot()).toBeNull();
    fireEvent.press(screen.getByLabelText("Close full Assistant"));
    expect(caption()).not.toMatch(/new reply/);
  });

  it("stays quiet while the conversation is already open", async () => {
    midRun("four sessions");
    renderAt(WIDE);
    openAssistant();
    await settle();
    await waitFor(() => expect(mockWatchRun).toHaveBeenCalled());

    answered("and a PR on Tuesday");
    await finish();

    // Looking at it is reading it.
    expect(dot()).toBeNull();
  });

  it("stays quiet for an answer that was spoken, because it was heard", async () => {
    withThread("four sessions");
    renderAt(WIDE);
    await waitFor(() => expect(mockApi.getConversation).toHaveBeenCalled());
    await settle();

    fireEvent.press(screen.getByLabelText("Talk to the assistant"));
    await waitFor(() => expect(mockSessions).toHaveLength(1));
    await act(async () => mockSessions[0].options.onConnect?.());

    // The spoken turn is written into the same thread, and the re-read brings
    // the answer onto the transcript while the Assistant is shut.
    mockApi.voiceTurn.mockResolvedValue({ text: "and a PR on Tuesday", conversation_id: 7 });
    answered("and a PR on Tuesday");

    await act(async () =>
      mockSessions[0].options.clientTools.ask_life_os({ question: "anything else?" }),
    );
    await settle();

    expect(dot()).toBeNull();
  });
});

/** Kept honest: every fixture above has to be a shape the API really returns. */
it("uses the endpoints rather than a fixture module", async () => {
  renderAt(WIDE);
  openMenu();
  await waitFor(() => expect(mockApi.getSystemStats).toHaveBeenCalled());

  expect(mockApi.getWeather).toHaveBeenCalled();
  expect(mockApi.getCalendar).toHaveBeenCalled();
});

// ── The Anthropic switch ──────────────────────────────────────────────────────

describe("the assistant when the API is switched off", () => {
  const OFF: Health = {
    ...HEALTH,
    assistant: { state: "off", enabled: false, configured: true, model: "claude-sonnet-5" },
  };

  it("closes the full Assistant's composer", async () => {
    const q = renderAt(WIDE, polled(OFF));

    // A shut overlay is inert, so open it before asking anything about what is
    // inside it.
    openAssistant(q);

    await waitFor(() => expect(q.getByLabelText("Message")).toBeTruthy());
    expect(q.getByLabelText("Message").props.editable).toBe(false);
    expect(
      q.getByText("The Anthropic API is switched off under Settings, so the assistant can't answer."),
    ).toBeTruthy();
  });

  it("closes the microphone too", async () => {
    // A spoken question runs the same loop and gets the same refusal, and
    // finding that out by talking to a machine for ten seconds is worse than
    // finding it out from a closed button.
    const q = renderAt(WIDE, polled(OFF));
    await settle();

    expect(q.getByTestId("hud-talk").props.accessibilityState.disabled).toBe(true);

    fireEvent.press(q.getByTestId("hud-talk"));
    expect(mockApi.voiceToken).not.toHaveBeenCalled();
  });
});

// ── The camera ───────────────────────────────────────────────────────────────

describe("the camera panel", () => {
  /** The camera lives in the Optics card, and a shut card is out of reach. */
  const openOptics = (q: ReturnType<typeof renderAt>) => fireEvent.press(q.getByTestId("hud-optics"));

  /**
   * Press Start and wait for a *live* camera, not merely a starting one.
   *
   * The distinction is the panel's own: the shutter is disabled until a track
   * is actually running, so waiting for the button to say "Stop" — which it
   * does the instant the permission prompt goes up — would press a dead
   * control and assert nothing.
   */
  const start = async (q: ReturnType<typeof renderAt>) => {
    fireEvent.press(q.getByTestId("camera-toggle"));
    await waitFor(() =>
      expect(q.getByTestId("camera-capture").props.accessibilityState.disabled).toBe(false),
    );
  };

  it("is off until it is started, and says nothing is recorded", async () => {
    const q = renderAt(WIDE);
    await settle();
    openOptics(q);

    expect(q.getByTestId("panel-camera")).toBeTruthy();
    // No picture in the lens until the camera is on.
    expect(q.UNSAFE_queryAllByType("video" as never)).toHaveLength(0);
    expect(browserApis.getUserMedia).not.toHaveBeenCalled();

    // The bargain is stated where the button that changes it is, not in a
    // settings page nobody reads at the moment it applies.
    expect(q.getByText(/Nothing is recorded/)).toBeTruthy();
  });

  it("opens the stream on a press and never asks for audio", async () => {
    const q = renderAt(WIDE);
    await settle();
    openOptics(q);
    await start(q);

    expect(browserApis.getUserMedia).toHaveBeenCalledWith(
      expect.objectContaining({ audio: false }),
    );
    expect(q.getByText(/This preview stays in the browser/)).toBeTruthy();
  });

  it("shows the picture in a round lens on the card, and nowhere on the core", async () => {
    // The owner's call: nothing covers the sphere, so the preview is on the card
    // above it rather than a lens inside it.
    const q = renderAt(WIDE);
    await settle();
    openOptics(q);
    await start(q);

    const videos = (node: any) => node.findAll((n: any) => n.type === "video");
    const lens = within(q.getByTestId("hud-optics-card")).getByTestId("hud-camera-lens");
    const style = Object.assign({}, ...[lens.props.style].flat(3).filter(Boolean));
    expect(style.borderRadius).toBe(style.width / 2);
    expect(videos(lens)).toHaveLength(1);
    expect(q.UNSAFE_queryAllByType("video" as never)).toHaveLength(1);

    fireEvent.press(q.getByLabelText("Close optics"));
    expect(q.UNSAFE_queryAllByType("video" as never)).toHaveLength(0);
  });

  it("says what to do about a refusal rather than what the browser called it", async () => {
    browserApis.getUserMedia.mockRejectedValueOnce(
      Object.assign(new Error("Permission denied"), { name: "NotAllowedError" }),
    );

    const q = renderAt(WIDE);
    await settle();
    openOptics(q);

    fireEvent.press(q.getByTestId("camera-toggle"));

    await waitFor(() => expect(q.getByTestId("camera-error")).toBeTruthy());
    expect(q.getByTestId("camera-error").props.children).toContain("browser's settings");
    // Back to off, not stuck at "opening".
    expect(q.getByTestId("camera-toggle").props.accessibilityLabel).toBe("Start");
  });

  it("cannot capture until a frame has actually arrived", async () => {
    const q = renderAt(WIDE);
    await settle();
    openOptics(q);

    expect(q.getByTestId("camera-capture").props.accessibilityState.disabled).toBe(true);
  });

  it("stages a captured frame on the composer and opens the full Assistant to it", async () => {
    const q = renderAt(WIDE);
    await settle();
    openOptics(q);
    await start(q);
    const tracks = (await browserApis.getUserMedia.mock.results[0].value).getVideoTracks();

    fireEvent.press(q.getByTestId("camera-capture"));

    // The composer is inside the full Assistant, and a shut overlay is inert —
    // so a capture that left it shut would put the picture out of reach.
    await waitFor(() => expect(q.getByTestId("composer-snapshot")).toBeTruthy());
    expect(q.getByLabelText("Close full Assistant")).toBeTruthy();
    // The overlay puts the Optics card away, and the camera with it: the frame
    // was taken before either went.
    expect(q.queryByTestId("panel-camera")).toBeNull();
    expect(tracks[0].stop).toHaveBeenCalled();
    // 1280×720 is over the ceiling, so the frame is the downscaled size and
    // not the sensor's.
    expect(q.getByText(/1024×576/)).toBeTruthy();

    // Nothing has been uploaded. Pressing the shutter is not pressing send.
    expect(mockApi.sendMessage).not.toHaveBeenCalled();
  });

  it("sends the staged frame with the next message, then clears it", async () => {
    mockApi.createConversation.mockResolvedValue({
      id: 1, title: null, last_message_at: null, created_at: null,
    });
    mockApi.sendMessage.mockResolvedValue({
      run: { id: "run-9", conversation_id: 1, trigger: "message", status: "queued", finished: false, error: null, created_at: null },
      conversation: { id: 1, title: "Camera snapshot", last_message_at: null, created_at: null },
      message: { id: 5, role: "user", content: [], text: "", stop_reason: null, created_at: null },
    });

    const q = renderAt(WIDE);
    await settle();
    openOptics(q);
    await start(q);

    fireEvent.press(q.getByTestId("camera-capture"));
    await waitFor(() => expect(q.getByTestId("composer-snapshot")).toBeTruthy());

    // No words at all: a picture is a whole question, so Send is live.
    fireEvent.press(q.getByLabelText("Send"));

    await waitFor(() => expect(mockApi.sendMessage).toHaveBeenCalled());
    expect(mockApi.sendMessage).toHaveBeenCalledWith(
      1,
      "",
      expect.objectContaining({ media_type: "image/jpeg" }),
    );
    await waitFor(() => expect(q.queryByTestId("composer-snapshot")).toBeNull());
  });

  it("takes a staged frame back off the composer", async () => {
    const q = renderAt(WIDE);
    await settle();
    openOptics(q);
    await start(q);

    fireEvent.press(q.getByTestId("camera-capture"));
    await waitFor(() => expect(q.getByTestId("composer-snapshot")).toBeTruthy());

    fireEvent.press(q.getByTestId("composer-snapshot-remove"));
    expect(q.queryByTestId("composer-snapshot")).toBeNull();
  });

  it("still takes it back off when the composer is closed", async () => {
    // Found in a browser, not here: Remove shared the composer's disabled flag,
    // so switching Anthropic off — which closes everything that would send
    // something — stranded a captured frame with no way to remove it. Taking a
    // picture back off sends nothing.
    const off: Health = {
      ...HEALTH,
      assistant: { state: "off", enabled: false, configured: true, model: "claude-sonnet-5" },
    };

    const q = renderAt(WIDE, polled(off));
    await settle();
    openOptics(q);
    await start(q);

    fireEvent.press(q.getByTestId("camera-capture"));
    await waitFor(() => expect(q.getByTestId("composer-snapshot")).toBeTruthy());

    expect(q.getByLabelText("Send").props.accessibilityState.disabled).toBe(true);

    fireEvent.press(q.getByTestId("composer-snapshot-remove"));
    expect(q.queryByTestId("composer-snapshot")).toBeNull();
  });

  it("closes when the tab goes away, and does not reopen itself", async () => {
    const q = renderAt(WIDE);
    await settle();
    openOptics(q);
    await start(q);

    const tracks = (await browserApis.getUserMedia.mock.results[0].value).getVideoTracks();

    act(() => {
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(tracks[0].stop).toHaveBeenCalled();
    expect(q.getByTestId("camera-closed")).toBeTruthy();
    expect(q.getByTestId("camera-toggle").props.accessibilityLabel).toBe("Start");

    // Coming back is not a press. 7.3's rule, and a camera has a light on it.
    act(() => {
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(browserApis.getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("offers a picker once the browser will name more than one camera", async () => {
    const q = renderAt(WIDE);
    openOptics(q);

    await waitFor(() => expect(q.getByTestId("camera-devices")).toBeTruthy());
    expect(q.getByText("Logitech C920")).toBeTruthy();

    // Choosing a camera is not the same gesture as turning one on.
    fireEvent.press(q.getByText("Logitech C920"));
    expect(browserApis.getUserMedia).not.toHaveBeenCalled();

    await start(q);
    expect(browserApis.getUserMedia).toHaveBeenCalledWith(
      expect.objectContaining({ video: expect.objectContaining({ deviceId: { exact: "cam-2" } }) }),
    );
  });
});

describe("opening the Assistant on a new chat", () => {
  const useNew = () =>
    localStorage.setItem(ASSISTANT_PREFS_STORAGE_KEY, JSON.stringify({ unreadSignal: true, openOn: "new" }));

  it("continues the last thread by default", async () => {
    withThread("four sessions, all pushing");
    renderAt(WIDE);
    await waitFor(() => expect(mockApi.getConversation).toHaveBeenCalled());
    await settle();

    openAssistant();

    await waitFor(() =>
      expect(within(screen.getByTestId("hud-full-body")).getByText("four sessions, all pushing")).toBeTruthy(),
    );
  });

  it("starts an empty thread when the preference says so", async () => {
    useNew();
    withThread("four sessions, all pushing");
    renderAt(WIDE);
    await waitFor(() => expect(mockApi.getConversation).toHaveBeenCalled());
    await settle();

    openAssistant();
    await settle();

    expect(within(screen.getByTestId("hud-full-body")).queryByText("four sessions, all pushing")).toBeNull();
    // No request: an empty thread is made by the first message, not by opening.
    expect(mockApi.createConversation).not.toHaveBeenCalled();
  });

  it("keeps the thread a camera frame was just staged on", async () => {
    useNew();
    withThread("four sessions, all pushing");
    renderAt(WIDE);
    await waitFor(() => expect(mockApi.getConversation).toHaveBeenCalled());
    await settle();

    fireEvent.press(screen.getByTestId("hud-optics"));
    fireEvent.press(screen.getByTestId("camera-toggle"));
    await waitFor(() =>
      expect(screen.getByTestId("camera-capture").props.accessibilityState.disabled).toBe(false),
    );
    fireEvent.press(screen.getByTestId("camera-capture"));

    await waitFor(() =>
      expect(within(screen.getByTestId("hud-full-body")).getByText("four sessions, all pushing")).toBeTruthy(),
    );
  });
});

describe("the Fitness overlay", () => {
  const openFitness = () => {
    fireEvent.press(screen.getByTestId("hud-core"));
    fireEvent.press(screen.getByLabelText("Open Fitness"));
  };

  it("is shut, and tells its screens so, until its title opens it", () => {
    renderAt(WIDE);

    expect(screen.queryByTestId("hud-fitness-spine")).toBeNull();
    expect(
      screen.getByTestId("fitness-view-stub", { includeHiddenElements: true }),
    ).toHaveTextContent("home:idle");

    openFitness();
    expect(screen.getByTestId("hud-fitness-spine")).toHaveTextContent("FITNESS");
  });

  it("closes on ✕ and on Escape, and tells its screens", () => {
    renderAt(WIDE);
    openFitness();
    fireEvent.press(screen.getByLabelText("Close Fitness"));

    expect(screen.queryByTestId("hud-fitness-spine")).toBeNull();
    expect(
      screen.getByTestId("fitness-view-stub", { includeHiddenElements: true }),
    ).toHaveTextContent("home:idle");

    openFitness();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(screen.queryByTestId("hud-fitness-spine")).toBeNull();
  });

  it("gives way to the typed conversation on ⌘K", async () => {
    renderAt(WIDE);
    openFitness();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
    });
    await settle();

    expect(screen.queryByTestId("hud-fitness-spine")).toBeNull();
    expect(screen.getByLabelText("Close full Assistant")).toBeTruthy();
  });
});

/**
 * Automations, on the HUD's side: asking for what is due, and what happens when
 * one of them lands. What a row looks like and how it is changed is
 * `AutomationsView`'s own suite.
 */
describe("a scheduled conversation", () => {
  function setVisibility(state: "hidden" | "visible") {
    act(() => {
      Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
  }

  afterEach(() => {
    setVisibility("visible");
    jest.useRealTimers();
  });

  /** One row, claimed on the first ask, whose run has landed and opened `thread`. */
  function delivers(thread: number) {
    mockApi.runDueAutomations.mockResolvedValue({ claimed: [1] });
    mockApi.listAutomations.mockResolvedValue({
      data: [
        {
          id: 1,
          name: "Morning greeting",
          time: "06:30",
          intent: "Say good morning.",
          context: ["agenda"],
          enabled: true,
          last_run_on: "2026-09-24",
          // After the claim, which is what tells this run from yesterday's.
          last_run_at: new Date(Date.now() + 1_000).toISOString(),
          last_outcome: "ok",
          last_error: null,
          last_conversation_id: thread,
        },
      ],
    });
  }

  /** Let the claim, the watch and the thread it opens all land. */
  async function collect() {
    await settle();
    await act(async () => {
      jest.advanceTimersByTime(4_500);
    });
    await settle();
    await settle();
  }

  it("asks for what is due on arrival, and again when the tab comes back", async () => {
    renderAt(WIDE);
    await settle();
    expect(mockApi.runDueAutomations).toHaveBeenCalledTimes(1);

    // A render is not an arrival. The HUD redraws on every poll, and one ask
    // per redraw would be a claim attempt every few seconds all day.
    openMenu();
    await settle();
    expect(mockApi.runDueAutomations).toHaveBeenCalledTimes(1);

    setVisibility("hidden");
    setVisibility("visible");
    await settle();
    expect(mockApi.runDueAutomations).toHaveBeenCalledTimes(2);
  });

  it("nothing due is nothing said", async () => {
    renderAt(WIDE);
    await settle();

    // No claim, so nothing is watched — the rows are never even read.
    expect(mockApi.listAutomations).not.toHaveBeenCalled();
    expect(caption()).not.toMatch(/new reply/);
  });

  it("puts a delivered greeting on the core, and the Assistant opens on it", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "queueMicrotask"] });
    delivers(7);

    renderAt(WIDE);
    await collect();

    // Nothing was going on, so the thread is switched: the greeting is written
    // in front of you rather than behind you.
    expect(mockApi.getConversation).toHaveBeenCalledWith(7);
    expect(caption()).toMatch(/new reply/);

    // Opening it is reading it.
    openAssistant();
    await settle();
    fireEvent.press(screen.getByLabelText("Close full Assistant"));
    expect(caption()).not.toMatch(/new reply/);
  });

  it("does not move you out of a conversation you are already reading", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "queueMicrotask"] });
    delivers(7);

    renderAt(WIDE);
    openAssistant();
    await collect();

    // The answer to whatever is being asked in there would land in a thread
    // the screen had just been moved out of.
    expect(mockApi.getConversation).not.toHaveBeenCalledWith(7);

    // It is still waiting, and opening the Assistant again is what reads it.
    fireEvent.press(screen.getByLabelText("Close full Assistant"));
    expect(caption()).toMatch(/new reply/);
    openAssistant();
    await settle();
    expect(mockApi.getConversation).toHaveBeenCalledWith(7);
  });

  it("says nothing when the run failed — the row is where that is answered", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "queueMicrotask"] });
    delivers(7);
    const rows = await mockApi.listAutomations();
    mockApi.listAutomations.mockResolvedValue({
      data: [{ ...rows.data[0], last_outcome: "failed", last_error: "No key.", last_conversation_id: null }],
    });

    renderAt(WIDE);
    await collect();

    expect(mockApi.getConversation).not.toHaveBeenCalledWith(7);
    expect(caption()).not.toMatch(/new reply/);
  });

  /**
   * The delivered thread, carrying the greeting its run wrote into it.
   *
   * `delivers` alone leaves the default transcript, which is empty — so these
   * are the tests that have something to say out loud, and the ones above are
   * the tests where the greeting is read rather than heard.
   */
  function greets(text: string) {
    delivers(7);
    mockApi.getConversation.mockResolvedValue({
      conversation: { id: 7, title: "Morning greeting", created_at: null, last_message_at: null },
      messages: [{ id: 1, role: "assistant", content: [{ type: "text", text }], created_at: null }],
      pending_actions: [],
      run: null,
    } as never);
  }

  it("offers a delivered greeting out loud, and one press is what reads it", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "queueMicrotask"] });
    greets("**Good morning.** Two things today.");

    renderAt(WIDE);
    await collect();

    // The card names the automation rather than calling itself a greeting, and
    // previews what is waiting.
    const card = screen.getByTestId("hud-greeting");
    expect(within(card).getByText("MORNING GREETING")).toBeTruthy();

    // The microphone is the thing moving, because the press is the whole
    // interface: it is what a browser needs before it will make a sound, and
    // what says somebody is in the room before minutes are spent.
    expect(pulsing()).toBeTruthy();

    fireEvent.press(screen.getByLabelText("Hear the greeting"));
    await waitFor(() => expect(mockSessions).toHaveLength(1));

    // The agent opens the call by reading it out: the words on file, with the
    // markers that were written for a screen taken off.
    expect(mockSessions[0].options.overrides).toEqual({
      agent: { firstMessage: "Good morning. Two things today." },
    });

    // Hearing it is reading it — the card goes, and so does the chip.
    expect(screen.queryByTestId("hud-greeting")).toBeNull();
    expect(pulsing()).toBeNull();
    expect(caption()).not.toMatch(/new reply/);
  });

  it("offers nothing out loud until the run has written something", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "queueMicrotask"] });
    // Delivered, thread switched to, and nothing said in it: a run that failed
    // after the conversation was made leaves exactly this.
    delivers(7);

    renderAt(WIDE);
    await collect();

    // The chip is up — there is a thread to look at — but there is nothing to
    // read aloud, and a card offering to speak silence is worse than no card.
    expect(caption()).toMatch(/new reply/);
    expect(screen.queryByTestId("hud-greeting")).toBeNull();
    expect(pulsing()).toBeNull();
  });

  it("does not offer out loud a greeting it did not put on screen", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "queueMicrotask"] });
    greets("Good morning.");

    renderAt(WIDE);
    // Mid-something, so the thread switch is declined — and what is not on
    // screen is not offered out loud either. The chip waits instead.
    openAssistant();
    await collect();

    expect(screen.queryByTestId("hud-greeting")).toBeNull();

    fireEvent.press(screen.getByLabelText("Close full Assistant"));
    expect(caption()).toMatch(/new reply/);
  });

  it("keeps the microphone's own meaning when nothing has been delivered", async () => {
    renderAt(WIDE);
    await settle();

    // No greeting: the button is the button it always was, and pressing it opens
    // a line with nothing put into the agent's mouth.
    expect(pulsing()).toBeNull();
    fireEvent.press(screen.getByLabelText("Talk to the assistant"));
    await waitFor(() => expect(mockSessions).toHaveLength(1));

    expect(mockSessions[0].options.overrides).toBeUndefined();
  });

  const caption = () => screen.getByTestId("hud-stage-hint").props.children;

  /**
   * The ring beckoning on the microphone.
   *
   * Hidden from accessibility, because it is a decoration on a button that is
   * already named — so the query has to be told to look at hidden elements, or
   * both halves of every assertion about it would pass for the wrong reason.
   */
  const pulsing = () => screen.queryByTestId("hud-talk-waiting", { includeHiddenElements: true });
});
