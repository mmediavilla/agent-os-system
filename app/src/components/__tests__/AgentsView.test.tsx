import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react-native";
import AgentsView, { defaultGuardrail, deleteMessage, effect } from "../AgentsView";
import { ApiError, AssistantAgent, CapabilityGroup, api } from "../../api";

/**
 * Assistant → Agents: which kinds of work the assistant may do.
 *
 * What matters is that the switch says what it does from the server's reading
 * rather than guessing, that a built-in agent's groups are shown and never
 * editable, that every guardrail is a field whose blank is the default, that
 * nothing is drawn as saved before the server says so,
 * and that only Delete asks first — and only a created agent has one.
 */

jest.mock("../../api", () => ({
  ...jest.requireActual("../../api"),
  api: {
    listAgents: jest.fn(),
    createAgent: jest.fn(),
    updateAgent: jest.fn(),
    deleteAgent: jest.fn(),
  },
}));

const mockApi = api as jest.Mocked<typeof api>;

const GROUPS: CapabilityGroup[] = [
  { value: "fitness", label: "the training log", guardrail: "You are not a physician.", tools: ["get_fitness_stats", "log_workout"] },
  { value: "calendar", label: "the calendars", guardrail: "Say what the calendars hold.", tools: ["list_events"] },
  { value: "documents", label: "filed documents", guardrail: "An organiser, never an advisor.", tools: ["search_documents"] },
  { value: "deadlines", label: "deadlines", guardrail: "A tracker, never an advisor.", tools: ["list_deadlines"] },
  { value: "machine", label: "opening things on this machine", guardrail: null, tools: [] },
];

const coach = (extra: Partial<AssistantAgent> = {}): AssistantAgent => ({
  id: 1,
  name: "Fitness coach",
  purpose: "Keep track of my training.",
  capabilities: ["fitness"],
  enabled: true,
  seeded: true,
  guardrail: "You are not a physician.",
  default_guardrail: "You are not a physician.",
  withholds: [],
  created_at: null,
  ...extra,
});

const accountant = (extra: Partial<AssistantAgent> = {}): AssistantAgent => ({
  id: 3,
  name: "Accountant",
  purpose: "Keep my receipts in order.",
  capabilities: ["documents"],
  enabled: true,
  seeded: false,
  guardrail: "An organiser, never an advisor.",
  default_guardrail: "An organiser, never an advisor.",
  withholds: [],
  created_at: null,
  ...extra,
});

const list = (data: AssistantAgent[]) => ({ data, groups: GROUPS });

const apiError = (status: number, message: string) => Object.assign(new Error(message), { status }) as ApiError;

beforeEach(() => {
  jest.resetAllMocks();
  mockApi.listAgents.mockResolvedValue(list([coach(), accountant()]));
  mockApi.updateAgent.mockResolvedValue(coach());
  mockApi.createAgent.mockResolvedValue(accountant({ id: 4 }));
  mockApi.deleteAgent.mockResolvedValue(undefined);
});

it("reads on arrival and not before", async () => {
  const view = render(<AgentsView active={false} />);
  expect(mockApi.listAgents).not.toHaveBeenCalled();

  view.rerender(<AgentsView active />);
  await waitFor(() => expect(mockApi.listAgents).toHaveBeenCalledTimes(1));
});

it("shows a built-in agent's groups as readouts, with no Delete", async () => {
  render(<AgentsView active />);
  await screen.findByTestId("agent-1");

  expect(screen.getByTestId("agent-1-guardrail-input").props.value).toBe("You are not a physician.");
  expect(screen.getByTestId("agent-1-group-fitness")).toHaveTextContent(/The training log/);
  // A readout, not a switch: the built-in rows keep every guarded group owned.
  expect(within(screen.getByTestId("agent-1-groups")).queryByRole("switch")).toBeNull();
  expect(screen.queryByTestId("agent-1-delete")).toBeNull();
});

it("gives a created agent a switch per group, and a Delete", async () => {
  render(<AgentsView active />);
  await screen.findByTestId("agent-3");

  expect(screen.getByTestId("agent-3-group-documents").props.value).toBe(true);
  expect(screen.getByTestId("agent-3-group-fitness").props.value).toBe(false);
  expect(screen.getByTestId("agent-3-delete")).toBeTruthy();
  // Created, and guarded all the same: the rule comes with what it owns.
  expect(screen.getByTestId("agent-3-guardrail-input").props.value).toBe("An organiser, never an advisor.");
});

it("rewords a guardrail on blur, and puts an emptied default back unsent", async () => {
  render(<AgentsView active />);
  await screen.findByTestId("agent-1");
  const field = screen.getByTestId("agent-1-guardrail-input");

  // Blank is the default, and it already is the default: nothing to write.
  fireEvent.changeText(field, "  ");
  fireEvent(field, "blur");
  expect(mockApi.updateAgent).not.toHaveBeenCalled();
  expect(screen.getByTestId("agent-1-guardrail-input").props.value).toBe("You are not a physician.");
  expect(screen.queryByTestId("agent-1-guardrail-reset")).toBeNull();

  fireEvent.changeText(field, "Never prescribe a programme. ");
  await act(async () => {
    fireEvent(field, "blur");
  });
  expect(mockApi.updateAgent).toHaveBeenCalledWith(1, { guardrail: "Never prescribe a programme." });
});

it("offers Reset only on a reworded guardrail, and clearing one sends the blank", async () => {
  mockApi.listAgents.mockResolvedValue(list([coach({ guardrail: "Mine." }), accountant()]));
  render(<AgentsView active />);
  await screen.findByTestId("agent-1");

  expect(screen.getByTestId("agent-1-guardrail-note")).toHaveTextContent(/Reworded by you/);
  await act(async () => {
    fireEvent.press(screen.getByTestId("agent-1-guardrail-reset"));
  });
  expect(mockApi.updateAgent).toHaveBeenLastCalledWith(1, { guardrail: null });

  // Clearing it is the same request in the field's own words: the server puts the default back.
  const field = screen.getByTestId("agent-1-guardrail-input");
  fireEvent.changeText(field, "");
  await act(async () => {
    fireEvent(field, "blur");
  });
  expect(mockApi.updateAgent).toHaveBeenLastCalledWith(1, { guardrail: "" });
});

it("will not switch off the last group a saved agent owns", async () => {
  render(<AgentsView active />);
  await screen.findByTestId("agent-3");

  // An agent that owns nothing is a 422; a switch that springs back would lie.
  expect(screen.getByTestId("agent-3-group-documents").props.disabled).toBe(true);
  expect(screen.getByTestId("agent-3-group-fitness").props.disabled).toBe(false);
});

it("writes a new set of groups in the server's order", async () => {
  mockApi.updateAgent.mockResolvedValue(accountant({ capabilities: ["documents", "deadlines"] }));
  render(<AgentsView active />);
  await screen.findByTestId("agent-3");

  await act(async () => {
    fireEvent(screen.getByTestId("agent-3-group-deadlines"), "valueChange", true);
  });

  expect(mockApi.updateAgent).toHaveBeenCalledWith(3, { capabilities: ["documents", "deadlines"] });
});

it("switches an agent off and redraws from the answer, not from the press", async () => {
  render(<AgentsView active />);
  await screen.findByTestId("agent-1");

  mockApi.listAgents.mockResolvedValue(list([coach({ enabled: false, withholds: ["fitness"] }), accountant()]));
  await act(async () => {
    fireEvent(screen.getByTestId("agent-1-enabled"), "valueChange", false);
  });

  expect(mockApi.updateAgent).toHaveBeenCalledWith(1, { enabled: false });
  expect(screen.getByTestId("agent-1-enabled").props.value).toBe(false);
  expect(screen.getByTestId("agent-1-effect")).toHaveTextContent(
    "The assistant is not offered the training log, and says so when asked.",
  );
});

it("keeps the switch where it was when the write is refused, and says why", async () => {
  render(<AgentsView active />);
  await screen.findByTestId("agent-1");

  mockApi.updateAgent.mockRejectedValue(apiError(500, "Server error."));
  await act(async () => {
    fireEvent(screen.getByTestId("agent-1-enabled"), "valueChange", false);
  });

  expect(screen.getByTestId("agent-1-enabled").props.value).toBe(true);
  expect(screen.getByText("Server error.")).toBeTruthy();
});

it("commits a renamed purpose on blur, and puts an emptied one back unsent", async () => {
  render(<AgentsView active />);
  await screen.findByTestId("agent-1");
  const purpose = screen.getByTestId("agent-1-purpose");

  fireEvent.changeText(purpose, "   ");
  fireEvent(purpose, "blur");
  expect(mockApi.updateAgent).not.toHaveBeenCalled();
  expect(screen.getByTestId("agent-1-purpose").props.value).toBe("Keep track of my training.");

  fireEvent.changeText(purpose, "Push me harder. ");
  await act(async () => {
    fireEvent(purpose, "blur");
  });
  expect(mockApi.updateAgent).toHaveBeenCalledWith(1, { purpose: "Push me harder." });
});

it("adds an agent switched on, only once it has a name, a purpose and a group", async () => {
  render(<AgentsView active />);
  await screen.findByTestId("agent-new");

  fireEvent.changeText(screen.getByTestId("agent-new-name"), "Tracker");
  fireEvent.changeText(screen.getByTestId("agent-new-purpose"), "Chase my renewals.");
  expect(screen.getByTestId("agent-new-submit").props.accessibilityState.disabled).toBe(true);

  fireEvent(screen.getByTestId("agent-new-group-deadlines"), "valueChange", true);
  await act(async () => {
    fireEvent.press(screen.getByTestId("agent-new-submit"));
  });

  expect(mockApi.createAgent).toHaveBeenCalledWith({
    name: "Tracker",
    purpose: "Chase my renewals.",
    capabilities: ["deadlines"],
    enabled: true,
  });
  expect(screen.getByTestId("agent-new-name").props.value).toBe("");
});

it("shows the default for what is ticked on a new agent, and sends its own words only if written", async () => {
  render(<AgentsView active />);
  await screen.findByTestId("agent-new");
  const field = () => screen.getByTestId("agent-new-guardrail-input");

  fireEvent(screen.getByTestId("agent-new-group-deadlines"), "valueChange", true);
  fireEvent(screen.getByTestId("agent-new-group-documents"), "valueChange", true);
  expect(field().props.placeholder).toBe("An organiser, never an advisor. A tracker, never an advisor.");

  fireEvent.changeText(screen.getByTestId("agent-new-name"), "Accountant");
  fireEvent.changeText(screen.getByTestId("agent-new-purpose"), "Receipts.");
  fireEvent.changeText(field(), " Never estimate what I owe. ");
  await act(async () => {
    fireEvent.press(screen.getByTestId("agent-new-submit"));
  });

  expect(mockApi.createAgent).toHaveBeenCalledWith({
    name: "Accountant",
    purpose: "Receipts.",
    capabilities: ["documents", "deadlines"],
    guardrail: "Never estimate what I owe.",
    enabled: true,
  });
});

it("asks before deleting a created agent", async () => {
  render(<AgentsView active />);
  await screen.findByTestId("agent-3");

  fireEvent.press(screen.getByTestId("agent-3-delete"));
  expect(mockApi.deleteAgent).not.toHaveBeenCalled();
  expect(screen.getByText("Delete Accountant?")).toBeTruthy();

  await act(async () => {
    // The card's own button and the dialog's both say Delete; this is the dialog's.
    fireEvent.press(screen.getAllByText("Delete").at(-1)!);
  });
  expect(mockApi.deleteAgent).toHaveBeenCalledWith(3);
});

it("says so when the list cannot be read", async () => {
  mockApi.listAgents.mockRejectedValue(apiError(500, "Server error."));
  render(<AgentsView active />);

  expect(await screen.findByTestId("agents-error")).toHaveTextContent(/Server error\./);
  expect(screen.queryByTestId("agent-new")).toBeNull();
});

describe("defaultGuardrail", () => {
  it("joins the chosen groups' rules in the groups' order, skipping groups with none", () => {
    expect(defaultGuardrail(GROUPS, ["deadlines", "machine", "fitness"])).toBe(
      "You are not a physician. A tracker, never an advisor.",
    );
  });

  it("is null when nothing chosen has a rule", () => {
    expect(defaultGuardrail(GROUPS, ["machine"])).toBeNull();
    expect(defaultGuardrail(GROUPS, [])).toBeNull();
  });
});

describe("effect", () => {
  it("names what an agent that is on offers", () => {
    expect(effect(accountant({ capabilities: ["documents", "deadlines"] }), GROUPS)).toBe(
      "The assistant is offered filed documents and deadlines.",
    );
  });

  it("says an agent that is off changes nothing when another agent holds its groups", () => {
    expect(effect(accountant({ enabled: false, withholds: [] }), GROUPS)).toBe(
      "Changes nothing right now — another agent that is on holds what this one owns.",
    );
  });

  it("names only what is actually withheld", () => {
    const secretary = accountant({
      enabled: false,
      capabilities: ["calendar", "documents", "deadlines"],
      withholds: ["documents", "deadlines"],
    });
    expect(effect(secretary, GROUPS)).toBe(
      "The assistant is not offered filed documents and deadlines, and says so when asked.",
    );
  });
});

describe("deleteMessage", () => {
  const NEWS: CapabilityGroup = { value: "news", label: "the news", guardrail: "Name the source.", tools: ["get_news"] };
  const all = [...GROUPS, NEWS];
  const desk = accountant({ id: 5, name: "News desk", capabilities: ["news"] });

  it("says a guarded group nobody else owns is taken away, and that it cannot be undone", () => {
    const text = deleteMessage(desk, [coach(), desk], all);

    expect(text).toMatch(/cannot be undone/);
    expect(text).toMatch(/No other agent owns the news, so the assistant stops being offered it until you make one that does\./);
    // Not the old promise that what it owns goes back to being offered.
    expect(text).not.toMatch(/goes back to being offered/);
  });

  it("says the interests and pins are kept when it owns the news", () => {
    expect(deleteMessage(desk, [desk], all)).toMatch(/interests and pinned articles are kept on 08 News/);
    expect(deleteMessage(accountant(), [accountant()], all)).not.toMatch(/pinned/);
  });

  it("takes nothing away when another agent owns the same groups", () => {
    const second = accountant({ id: 9, name: "Sports desk", capabilities: ["news"] });
    const text = deleteMessage(desk, [desk, second], all);

    expect(text).toMatch(/The assistant keeps everything it owns/);
    expect(text).not.toMatch(/stops being offered/);
  });

  it("does not count a group with no rule as taken away", () => {
    const opener = accountant({ id: 7, name: "Opener", capabilities: ["machine"] });
    expect(deleteMessage(opener, [opener], all)).toMatch(/The assistant keeps everything it owns/);
  });
});
