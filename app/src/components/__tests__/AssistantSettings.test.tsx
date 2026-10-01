import React from "react";
import { fireEvent, render, waitFor, within } from "@testing-library/react-native";
import AssistantSettings from "../AssistantSettings";
import { AssistantPrefsProvider } from "../../AssistantPrefsProvider";
import { AssistantHealth, AssistantServerSettings, Health, api } from "../../api";
import { ASSISTANT_PREFS_STORAGE_KEY } from "../../assistantPrefs";
import { Polled } from "../../polling";

/**
 * The view reads the assistant's state out of the shell's health poll rather
 * than fetching anything itself, so a reading is all it takes to render. It
 * lives in the Assistant overlay's Settings tab; what the overlay does is `Hud`'s.
 */
const health = (
  assistant: AssistantHealth | null,
  extra: Partial<Polled<Health>> = {},
): Polled<Health> => ({
  data: assistant
    ? ({
        ok: true,
        checked_at: "2026-09-06T09:00:00+00:00",
        database: { state: "up" },
        queue: { state: "up", last_beat_at: null, age_seconds: 0, pending: 0 },
        scheduler: { state: "up", last_beat_at: null, age_seconds: 0 },
        assistant,
      } as Health)
    : null,
  error: null,
  loading: false,
  latencyMs: 42,
  refresh: jest.fn(),
  ...extra,
});

const ON: AssistantHealth = {
  state: "up",
  enabled: true,
  configured: true,
  model: "claude-sonnet-5",
};


const renderView = (polled: Polled<Health> = health(ON), active = true) =>
  render(
    <AssistantPrefsProvider>
      <AssistantSettings active={active} health={polled} />
    </AssistantPrefsProvider>,
  );

// The server half waits forever unless a test says otherwise, so the switch and
// the chat preferences can be drawn without it.
let getSettings: jest.SpyInstance;
let patchSettings: jest.SpyInstance;
let getCredits: jest.SpyInstance;
beforeEach(() => {
  getSettings = jest.spyOn(api, "getAssistantSettings").mockReturnValue(new Promise(() => {}));
  patchSettings = jest.spyOn(api, "patchAssistantSettings");
  getCredits = jest.spyOn(api, "getVoiceCredits").mockReturnValue(new Promise(() => {}));
});
afterEach(() => {
  getSettings.mockRestore();
  patchSettings.mockRestore();
  getCredits.mockRestore();
});

// ── The Anthropic switch ──────────────────────────────────────────────────────

const OFF: AssistantHealth = { state: "off", enabled: false, configured: true, model: "claude-sonnet-5" };

it("draws the switch from the health poll rather than a fetch of its own", () => {
  const q = renderView(health(ON));

  expect(q.getByTestId("anthropic-toggle").props.value).toBe(true);
  expect(q.getByText("On — using claude-sonnet-5.")).toBeTruthy();
});

it("says plainly when it is off", () => {
  const q = renderView(health(OFF));

  expect(q.getByTestId("anthropic-toggle").props.value).toBe(false);
  expect(q.getByText("Off — nothing in this app will call Anthropic.")).toBeTruthy();
});

it("separates a switch that is on from a machine with no key", () => {
  // Two different problems with two different fixes, so they never share a
  // sentence — one is a toggle and the other is a line in .env.
  const q = renderView(health({ ...ON, state: "down", configured: false }));

  expect(q.getByText("On, but there's no ANTHROPIC_API_KEY in backend/.env.")).toBeTruthy();
});

it("says when Anthropic is refusing calls for credit, and how it clears", () => {
  const q = renderView(
    health({ ...ON, credit: { exhausted: true, since: "2026-09-29T08:00:00+00:00", last_refused_at: "2026-09-29T09:00:00+00:00" } }),
  );

  expect(q.getByText(/refusing calls for lack of credit/)).toHaveTextContent(/clears on the next call that goes through/);
});

it("refuses to guess while there is no reading", () => {
  const q = renderView(health(null));

  expect(q.getByTestId("anthropic-toggle").props.disabled).toBe(true);
  expect(q.getByText("Can't reach the API, so this is unknown.")).toBeTruthy();
});

it("writes the new state and shows it without waiting for the next poll", async () => {
  const setAnthropicEnabled = jest
    .spyOn(api, "setAnthropicEnabled")
    .mockResolvedValue({ ...ON, state: "off", enabled: false });
  const polled = health(ON);

  const q = renderView(polled);
  fireEvent(q.getByTestId("anthropic-toggle"), "valueChange", false);

  await waitFor(() =>
    expect(q.getByText("Off — nothing in this app will call Anthropic.")).toBeTruthy(),
  );
  expect(setAnthropicEnabled).toHaveBeenCalledWith(false);
  // So the chip in the chrome bar changes with the switch rather than up to
  // fifteen seconds later.
  expect(polled.refresh).toHaveBeenCalled();

  setAnthropicEnabled.mockRestore();
});

it("keeps the old state and says why when the write fails", async () => {
  const setAnthropicEnabled = jest
    .spyOn(api, "setAnthropicEnabled")
    .mockRejectedValue(new Error("Network request failed"));

  const q = renderView(health(ON));
  fireEvent(q.getByTestId("anthropic-toggle"), "valueChange", false);

  await waitFor(() => expect(q.getByText("Network request failed")).toBeTruthy());
  expect(q.getByTestId("anthropic-toggle").props.value).toBe(true);

  setAnthropicEnabled.mockRestore();
});

// ── Chat preferences ──────────────────────────────────────────────────────────

describe("the chat preferences", () => {
  const stored = () => JSON.parse(localStorage.getItem(ASSISTANT_PREFS_STORAGE_KEY) ?? "null");

  it("announces replies and continues the last thread by default", () => {
    const q = renderView();

    expect(q.getByTestId("assistant-unread-toggle").props.value).toBe(true);
    const selected = within(q.getByLabelText("Opening the Assistant shows"))
      .getAllByRole("radio")
      .filter((r) => r.props.accessibilityState?.selected);
    expect(selected).toHaveLength(1);
    expect(within(selected[0]).getByText("Where you left off")).toBeTruthy();
  });

  it("keeps each choice in this browser", () => {
    const q = renderView();

    fireEvent(q.getByTestId("assistant-unread-toggle"), "valueChange", false);
    fireEvent.press(q.getByText("A new chat"));

    expect(q.getByTestId("assistant-unread-toggle").props.value).toBe(false);
    expect(stored()).toEqual({ unreadSignal: false, openOn: "new" });
  });

  it("reads what was stored before", () => {
    localStorage.setItem(ASSISTANT_PREFS_STORAGE_KEY, JSON.stringify({ unreadSignal: false, openOn: "new" }));
    const q = renderView();

    expect(q.getByTestId("assistant-unread-toggle").props.value).toBe(false);
  });

  it("puts the switch and this browser's choices in separate columns", () => {
    const q = renderView();

    expect(within(q.getByTestId("assistant-settings-left")).getByTestId("anthropic-toggle")).toBeTruthy();
    expect(within(q.getByTestId("assistant-settings-right")).getByTestId("assistant-unread-toggle")).toBeTruthy();
  });
});

// ── The server half ───────────────────────────────────────────────────────────

const STATE: AssistantServerSettings = {
  models: { chat: "claude-sonnet-5", insight: "claude-opus-5" },
  reasoning: { effort: "high", thinking_display: "summarized" },
  limits: { max_iterations: 12, snapshot_replay: 3 },
  voice: { configured: true, agent_configured: false, local_actions: true },
};

const selectedIn = (q: ReturnType<typeof renderView>, group: string) =>
  within(q.getByLabelText(group))
    .getAllByRole("radio")
    .filter((r) => r.props.accessibilityState?.selected)
    .map((r) => within(r).getAllByText(/./)[0].props.children);

describe("the server settings", () => {
  it("reads nothing until the tab is arrived at", () => {
    renderView(health(ON), false);

    expect(getSettings).not.toHaveBeenCalled();
  });

  it("draws what the server holds", async () => {
    getSettings.mockResolvedValue(STATE);
    const q = renderView();

    await waitFor(() => expect(q.getByLabelText("Chat and voice")).toBeTruthy());
    expect(selectedIn(q, "Chat and voice")).toEqual(["Sonnet 5"]);
    expect(selectedIn(q, "Weekly assessment and morning nudges")).toEqual(["Opus 5"]);
    expect(selectedIn(q, "Effort")).toEqual(["High"]);
    expect(selectedIn(q, "While it thinks")).toEqual(["Summarized"]);
    expect(selectedIn(q, "Model calls per message")).toEqual(["12"]);
    expect(selectedIn(q, "Camera pictures re-sent")).toEqual(["3"]);

    const voice = within(q.getByTestId("assistant-voice"));
    expect(voice.getByText("ElevenLabs key")).toBeTruthy();
    expect(voice.getAllByText("Set")).toHaveLength(1);
    expect(voice.getByText("Not set")).toBeTruthy();
    expect(voice.getByText("On")).toBeTruthy();
  });

  it("sends only the value that changed and redraws from the answer", async () => {
    getSettings.mockResolvedValue(STATE);
    patchSettings.mockResolvedValue({ ...STATE, models: { ...STATE.models, chat: "claude-opus-5" } });
    const q = renderView();

    await waitFor(() => expect(q.getByLabelText("Chat and voice")).toBeTruthy());
    fireEvent.press(within(q.getByLabelText("Chat and voice")).getByText("Opus 5"));

    await waitFor(() => expect(selectedIn(q, "Chat and voice")).toEqual(["Opus 5"]));
    expect(patchSettings).toHaveBeenCalledTimes(1);
    expect(patchSettings).toHaveBeenCalledWith({ models: { chat: "claude-opus-5" } });
  });

  it("sends a limit as the number the server holds", async () => {
    getSettings.mockResolvedValue(STATE);
    patchSettings.mockResolvedValue({ ...STATE, limits: { ...STATE.limits, max_iterations: 20 } });
    const q = renderView();

    await waitFor(() => expect(q.getByLabelText("Model calls per message")).toBeTruthy());
    fireEvent.press(within(q.getByLabelText("Model calls per message")).getByText("20"));

    await waitFor(() => expect(selectedIn(q, "Model calls per message")).toEqual(["20"]));
    expect(patchSettings).toHaveBeenCalledWith({ limits: { max_iterations: 20 } });
  });

  it("sends nothing for the choice already stored, or while a write is out", async () => {
    getSettings.mockResolvedValue(STATE);
    patchSettings.mockReturnValue(new Promise(() => {}));
    const q = renderView();

    await waitFor(() => expect(q.getByLabelText("Effort")).toBeTruthy());
    fireEvent.press(within(q.getByLabelText("Effort")).getByText("High"));
    expect(patchSettings).not.toHaveBeenCalled();

    fireEvent.press(within(q.getByLabelText("Effort")).getByText("Low"));
    fireEvent.press(within(q.getByLabelText("Effort")).getByText("Medium"));
    expect(patchSettings).toHaveBeenCalledTimes(1);
  });

  it("keeps the stored choice and says why beside the section whose write failed", async () => {
    getSettings.mockResolvedValue(STATE);
    patchSettings.mockRejectedValue(new Error("The selected reasoning.effort is invalid."));
    const q = renderView();

    await waitFor(() => expect(q.getByLabelText("Effort")).toBeTruthy());
    fireEvent.press(within(q.getByLabelText("Effort")).getByText("Low"));

    await waitFor(() =>
      expect(within(q.getByTestId("assistant-reasoning")).getByText("The selected reasoning.effort is invalid.")).toBeTruthy(),
    );
    expect(within(q.getByTestId("assistant-models")).queryByText("The selected reasoning.effort is invalid.")).toBeNull();
    expect(selectedIn(q, "Effort")).toEqual(["High"]);
  });

  it("says once when the settings cannot be read", async () => {
    getSettings.mockRejectedValue(new Error("Network request failed"));
    const q = renderView();

    await waitFor(() => expect(q.getAllByText("Network request failed")).toHaveLength(1));
  });

  it("selects nothing for a model from .env outside the choices", async () => {
    getSettings.mockResolvedValue({ ...STATE, models: { ...STATE.models, chat: "claude-opus-4-8" } });
    const q = renderView();

    await waitFor(() => expect(q.getByLabelText("Chat and voice")).toBeTruthy());
    expect(selectedIn(q, "Chat and voice")).toEqual([]);
  });
});

describe("the voice credits", () => {
  const AVAILABLE = {
    state: "available" as const,
    used: 22_500,
    limit: 30_000,
    remaining: 7_500,
    resets_at: "2026-10-14T00:00:00+00:00",
    tier: "starter",
    message: null,
    checked_at: "2026-09-29T09:00:00+00:00",
  };

  it("reads nothing until the tab is arrived at", () => {
    renderView(health(ON), false);

    expect(getCredits).not.toHaveBeenCalled();
  });

  it("shows what is left of the plan and when it resets", async () => {
    getSettings.mockResolvedValue(STATE);
    getCredits.mockResolvedValue(AVAILABLE);
    const q = renderView();

    const voice = () => within(q.getByTestId("assistant-voice"));
    await waitFor(() => expect(voice().getByText("Credits left")).toBeTruthy());
    expect(voice().getByText(`${(7_500).toLocaleString()} of ${(30_000).toLocaleString()}`)).toBeTruthy();
    expect(voice().getByText("Resets")).toBeTruthy();
  });

  it("draws a dash and the reason when the plan cannot be read", async () => {
    getSettings.mockResolvedValue(STATE);
    getCredits.mockResolvedValue({
      ...AVAILABLE,
      state: "unavailable",
      used: null,
      limit: null,
      remaining: null,
      resets_at: null,
      message: "The ElevenLabs key is missing the user_read permission.",
    });
    const q = renderView();

    await waitFor(() => expect(q.getByTestId("voice-credits-note")).toHaveTextContent(/user_read/));
    expect(within(q.getByTestId("assistant-voice")).getByText("—")).toBeTruthy();
  });

  it("says why beside the card when the read itself fails", async () => {
    getSettings.mockResolvedValue(STATE);
    getCredits.mockRejectedValue(new Error("Network request failed"));
    const q = renderView();

    await waitFor(() => expect(within(q.getByTestId("assistant-voice")).getByText("Network request failed")).toBeTruthy());
  });
});
