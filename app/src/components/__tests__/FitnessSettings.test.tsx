import React from "react";
import { Text } from "react-native";
import { fireEvent, render, waitFor, within } from "@testing-library/react-native";
import FitnessSettings, { normaliseTime } from "../FitnessSettings";
import { FitnessServerSettings, NUDGE_TRIGGERS, NudgeSettings, api } from "../../api";
import { FitnessPrefsProvider, useFitnessPrefs } from "../../FitnessPrefsProvider";
import { UnitsProvider, useUnits } from "../../UnitsProvider";
import { STATS_RANGES, STATS_RANGE_LABELS } from "../../fitnessPrefs";
import { DIMENSION_LABELS, UNIT_LABELS } from "../../units";

/**
 * Fitness → Settings. The units moved here from the HUD's Settings in 12.0, and
 * their tests came with them.
 */

jest.mock("../../api", () => ({
  ...jest.requireActual("../../api"),
  api: { getFitnessSettings: jest.fn(), patchFitnessSettings: jest.fn() },
}));

const mockApi = api as jest.Mocked<typeof api>;

beforeEach(() => {
  jest.clearAllMocks();
  // Never answers, so the units and range tests below stay synchronous; the
  // nudge tests give it an answer of their own.
  mockApi.getFitnessSettings.mockReturnValue(new Promise(() => {}));
});

const renderSettings = (extra?: React.ReactNode) =>
  render(
    <UnitsProvider>
      <FitnessPrefsProvider>
        <FitnessSettings active />
        {extra}
      </FitnessPrefsProvider>
    </UnitsProvider>,
  );

type Screen = ReturnType<typeof renderSettings>;

/** The radios of one group — every group uses the same role. */
const groupRadios = (screen: Screen, label: string) =>
  within(screen.getByLabelText(label)).getAllByRole("radio");

const selectedIn = (screen: Screen, label: string) =>
  groupRadios(screen, label).filter((r) => r.props.accessibilityState?.selected);

it("puts the browser's preferences in one column and the machine's in the other", () => {
  const screen = renderSettings();
  const browser = within(screen.getByTestId("fitness-settings-browser"));
  const machine = within(screen.getByTestId("fitness-settings-machine"));

  expect(browser.getByText("Units")).toBeTruthy();
  expect(browser.getByText("Home")).toBeTruthy();
  expect(machine.getByTestId("fitness-calculations")).toBeTruthy();
  expect(machine.getByTestId("fitness-nudges")).toBeTruthy();
});

// ── Units ─────────────────────────────────────────────────────────────────────

it("offers a group for each unit dimension", () => {
  const screen = renderSettings();
  Object.values(DIMENSION_LABELS).forEach((label) => {
    expect(groupRadios(screen, label)).toHaveLength(2);
  });
});

it("starts on the canonical unit of every dimension", () => {
  const screen = renderSettings();

  expect(selectedIn(screen, DIMENSION_LABELS.weight)[0]).toHaveTextContent(new RegExp(`^${UNIT_LABELS.kg}`));
  expect(selectedIn(screen, DIMENSION_LABELS.distance)[0]).toHaveTextContent(new RegExp(`^${UNIT_LABELS.km}`));
  expect(selectedIn(screen, DIMENSION_LABELS.measurement)[0]).toHaveTextContent(new RegExp(`^${UNIT_LABELS.cm}`));
});

it("changes one dimension without disturbing the others", () => {
  // The three are independent: pounds with kilometers is a normal combination.
  const screen = renderSettings();
  fireEvent.press(screen.getByText(UNIT_LABELS.lb));

  const weight = selectedIn(screen, DIMENSION_LABELS.weight);
  expect(weight).toHaveLength(1);
  expect(weight[0]).toHaveTextContent(new RegExp(`^${UNIT_LABELS.lb}`));
  expect(selectedIn(screen, DIMENSION_LABELS.distance)[0]).toHaveTextContent(new RegExp(`^${UNIT_LABELS.km}`));
  expect(selectedIn(screen, DIMENSION_LABELS.measurement)[0]).toHaveTextContent(new RegExp(`^${UNIT_LABELS.cm}`));
});

it("publishes the chosen units to the rest of the app", () => {
  function Probe() {
    const { units } = useUnits();
    return <Text>units:{`${units.weight}/${units.distance}/${units.measurement}`}</Text>;
  }
  const screen = renderSettings(<Probe />);

  fireEvent.press(screen.getByText(UNIT_LABELS.lb));
  fireEvent.press(screen.getByText(UNIT_LABELS.mi));
  expect(screen.getByText("units:lb/mi/cm")).toBeTruthy();
});

it("says body measurements aren't wired up yet", () => {
  expect(renderSettings().getByText(/Body measurements aren't logged in the app yet/)).toBeTruthy();
});

it("previews the same values in whichever units are picked", () => {
  // Fixed canonical values, so the only thing that moves is the setting.
  const screen = renderSettings();
  const preview = () => within(screen.getByTestId("fitness-units-preview"));

  expect(preview().getByText("3 × 8 · 100 kg")).toBeTruthy();
  expect(preview().getByText("5 km")).toBeTruthy();
  expect(preview().getByText("80 cm")).toBeTruthy();

  fireEvent.press(screen.getByText(UNIT_LABELS.lb));
  fireEvent.press(screen.getByText(UNIT_LABELS.mi));
  fireEvent.press(screen.getByText(UNIT_LABELS.in));

  expect(preview().getByText("3 × 8 · 220.5 lb")).toBeTruthy();
  expect(preview().getByText("3.1 mi")).toBeTruthy();
  expect(preview().getByText("31.5 in")).toBeTruthy();
});

// ── Default stats range ───────────────────────────────────────────────────────

describe("the default stats range", () => {
  it("offers every range, starting on Automatic", () => {
    const screen = renderSettings();

    expect(groupRadios(screen, "Default stats range")).toHaveLength(STATS_RANGES.length);
    expect(selectedIn(screen, "Default stats range")[0]).toHaveTextContent(
      new RegExp(`^${STATS_RANGE_LABELS.auto}`),
    );
  });

  it("publishes the choice and remembers it across a reload", () => {
    function Probe() {
      return <Text>range:{useFitnessPrefs().prefs.defaultRange}</Text>;
    }
    const first = renderSettings(<Probe />);
    fireEvent.press(first.getByText(STATS_RANGE_LABELS["12w"]));
    expect(first.getByText("range:12w")).toBeTruthy();
    first.unmount();

    const second = renderSettings();
    expect(selectedIn(second, "Default stats range")[0]).toHaveTextContent(
      new RegExp(`^${STATS_RANGE_LABELS["12w"]}`),
    );
  });
});

// ── Morning nudges ────────────────────────────────────────────────────────────

describe("morning nudges", () => {
  const STATE: FitnessServerSettings = {
    nudges: { enabled: true, time: "07:00", triggers: [...NUDGE_TRIGGERS], timezone: "Asia/Manila" },
    calculations: { e1rm_formula: "epley", week_start: "monday" },
  };

  const withNudges = (patch: Partial<NudgeSettings>): FitnessServerSettings => ({
    ...STATE,
    nudges: { ...STATE.nudges, ...patch },
  });

  const loaded = async () => {
    const screen = renderSettings();
    await screen.findByTestId("nudges-toggle");
    return screen;
  };

  beforeEach(() => {
    mockApi.getFitnessSettings.mockResolvedValue(STATE);
  });

  it("draws what the server holds, on the user's clock", async () => {
    mockApi.getFitnessSettings.mockResolvedValue(withNudges({ time: "06:30", triggers: ["layoff"] }));
    const screen = await loaded();

    expect(screen.getByTestId("nudges-toggle")).toHaveProp("value", true);
    expect(screen.getByTestId("nudges-time")).toHaveProp("value", "06:30");
    expect(screen.getByText(/On Asia\/Manila time/)).toBeTruthy();
    expect(screen.getByTestId("nudge-trigger-layoff")).toHaveProp("value", true);
    expect(screen.getByTestId("nudge-trigger-muscle_gap")).toHaveProp("value", false);
  });

  it("reads nothing until the tab is arrived at", () => {
    render(
      <UnitsProvider>
        <FitnessPrefsProvider>
          <FitnessSettings active={false} />
        </FitnessPrefsProvider>
      </UnitsProvider>,
    );
    expect(mockApi.getFitnessSettings).not.toHaveBeenCalled();
  });

  it("says so when the settings cannot be read", async () => {
    mockApi.getFitnessSettings.mockRejectedValue(new Error("Can't reach the API."));
    const screen = renderSettings();

    expect(await screen.findByText("Can't reach the API.")).toBeTruthy();
    expect(screen.queryByTestId("nudges-toggle")).toBeNull();
  });

  it("switches nudges off and redraws from the answer", async () => {
    mockApi.patchFitnessSettings.mockResolvedValue(withNudges({ enabled: false }));
    const screen = await loaded();

    fireEvent(screen.getByTestId("nudges-toggle"), "valueChange", false);

    await waitFor(() => expect(screen.getByTestId("nudges-toggle")).toHaveProp("value", false));
    expect(mockApi.patchFitnessSettings).toHaveBeenCalledWith({ nudges: { enabled: false } });
  });

  it("sends the whole trigger list, in priority order", async () => {
    mockApi.getFitnessSettings.mockResolvedValue(withNudges({ triggers: ["new_pr"] }));
    mockApi.patchFitnessSettings.mockResolvedValue(withNudges({ triggers: ["layoff", "new_pr"] }));
    const screen = await loaded();

    fireEvent(screen.getByTestId("nudge-trigger-layoff"), "valueChange", true);

    await waitFor(() => expect(screen.getByTestId("nudge-trigger-layoff")).toHaveProp("value", true));
    expect(mockApi.patchFitnessSettings).toHaveBeenCalledWith({ nudges: { triggers: ["layoff", "new_pr"] } });
  });

  it("saves a time on blur, padding a single-digit hour", async () => {
    mockApi.patchFitnessSettings.mockResolvedValue(withNudges({ time: "06:15" }));
    const screen = await loaded();
    const input = screen.getByTestId("nudges-time");

    fireEvent.changeText(input, "6:15");
    fireEvent(input, "blur");

    await waitFor(() => expect(mockApi.patchFitnessSettings).toHaveBeenCalledWith({ nudges: { time: "06:15" } }));
    await waitFor(() => expect(screen.getByTestId("nudges-time")).toHaveProp("value", "06:15"));
  });

  it("refuses a time that is not one, and sends nothing", async () => {
    const screen = await loaded();
    const input = screen.getByTestId("nudges-time");

    fireEvent.changeText(input, "25:00");
    fireEvent(input, "blur");

    expect(screen.getByText("Use a 24-hour time, like 07:00.")).toBeTruthy();
    expect(mockApi.patchFitnessSettings).not.toHaveBeenCalled();
  });

  // The same rule the automations' time field keeps: a cleared picker is a
  // clear, so the stored time comes back and nothing is sent.
  it("puts the stored time back when the field is cleared", async () => {
    const screen = await loaded();
    const input = screen.getByTestId("nudges-time");

    fireEvent.changeText(input, "");
    fireEvent(input, "blur");

    expect(screen.getByTestId("nudges-time")).toHaveProp("value", "07:00");
    expect(mockApi.patchFitnessSettings).not.toHaveBeenCalled();
  });

  it("does not write a time that did not change", async () => {
    const screen = await loaded();
    fireEvent(screen.getByTestId("nudges-time"), "blur");
    expect(mockApi.patchFitnessSettings).not.toHaveBeenCalled();
  });

  it("keeps the saved state when a write is refused", async () => {
    mockApi.patchFitnessSettings.mockRejectedValue(new Error("The server said no."));
    const screen = await loaded();

    fireEvent(screen.getByTestId("nudges-toggle"), "valueChange", false);

    expect(await screen.findByText("The server said no.")).toBeTruthy();
    expect(screen.getByTestId("nudges-toggle")).toHaveProp("value", true);
  });
});

// ── Calculations ──────────────────────────────────────────────────────────────

describe("calculations", () => {
  const STATE: FitnessServerSettings = {
    nudges: { enabled: true, time: "07:00", triggers: [...NUDGE_TRIGGERS], timezone: "Asia/Manila" },
    calculations: { e1rm_formula: "epley", week_start: "monday" },
  };

  const radio = (screen: Screen, group: string, label: string) =>
    within(screen.getByLabelText(group)).getByRole("radio", { name: new RegExp(`^${label}`) });

  const loaded = async () => {
    const screen = renderSettings();
    await screen.findByLabelText("Week starts on");
    return screen;
  };

  beforeEach(() => {
    mockApi.getFitnessSettings.mockResolvedValue(STATE);
  });

  it("draws what the server holds", async () => {
    mockApi.getFitnessSettings.mockResolvedValue({
      ...STATE,
      calculations: { e1rm_formula: "brzycki", week_start: "sunday" },
    });
    const screen = await loaded();

    expect(radio(screen, "Estimated 1RM formula", "Brzycki").props.accessibilityState.selected).toBe(true);
    expect(radio(screen, "Estimated 1RM formula", "Epley").props.accessibilityState.selected).toBe(false);
    expect(radio(screen, "Week starts on", "Sunday").props.accessibilityState.selected).toBe(true);
  });

  it("sends only the choice that changed, and redraws from the answer", async () => {
    mockApi.patchFitnessSettings.mockResolvedValue({
      ...STATE,
      calculations: { e1rm_formula: "epley", week_start: "sunday" },
    });
    const screen = await loaded();

    fireEvent.press(radio(screen, "Week starts on", "Sunday"));

    expect(mockApi.patchFitnessSettings).toHaveBeenCalledWith({ calculations: { week_start: "sunday" } });
    await waitFor(() => expect(radio(screen, "Week starts on", "Sunday").props.accessibilityState.selected).toBe(true));
  });

  it("writes nothing when the chosen option is already saved", async () => {
    const screen = await loaded();
    fireEvent.press(radio(screen, "Estimated 1RM formula", "Epley"));
    expect(mockApi.patchFitnessSettings).not.toHaveBeenCalled();
  });

  it("keeps a refused write's error beside this section, not the nudges", async () => {
    mockApi.patchFitnessSettings.mockRejectedValue(new Error("The server said no."));
    const screen = await loaded();

    fireEvent.press(radio(screen, "Estimated 1RM formula", "Brzycki"));

    const note = await screen.findByText("The server said no.");
    expect(within(screen.getByTestId("fitness-calculations")).getByText("The server said no.")).toBe(note);
    expect(within(screen.getByTestId("fitness-nudges")).queryByText("The server said no.")).toBeNull();
    expect(radio(screen, "Estimated 1RM formula", "Epley").props.accessibilityState.selected).toBe(true);
  });
});

describe("normaliseTime", () => {
  it.each([
    ["07:00", "07:00"],
    ["7:05", "07:05"],
    [" 23:59 ", "23:59"],
    ["24:00", null],
    ["7:5", null],
    ["07:60", null],
    ["seven", null],
  ])("%j → %j", (input, expected) => {
    expect(normaliseTime(input)).toBe(expected);
  });
});
