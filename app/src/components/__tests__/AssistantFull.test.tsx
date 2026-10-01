import React from "react";
import { useWindowDimensions } from "react-native";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import AssistantFull from "../AssistantFull";
import AssistantOrb from "../AssistantOrb";
import {
  AgentAction,
  AgentRun,
  ApiError,
  ChatMessage,
  ContentBlock,
  Conversation,
  MessageAccepted,
  RunEvent,
  api,
} from "../../api";
import { WatchOptions, watchRun } from "../../runWatcher";
import { useConversation } from "../../useConversation";

jest.mock("../../api", () => ({
  ...jest.requireActual("../../api"),
  api: {
    listConversations: jest.fn(),
    createConversation: jest.fn(),
    getConversation: jest.fn(),
    deleteConversation: jest.fn(),
    sendMessage: jest.fn(),
    decideAction: jest.fn(),
    getRun: jest.fn(),
  },
}));

// The watcher is mocked rather than the transport beneath it: what this screen
// has to get right is what it *does* with a run's events, and driving them by
// hand is the only way to hold a half-finished run still and look at it.
jest.mock("../../runWatcher", () => ({ watchRun: jest.fn() }));

jest.mock("react-native/Libraries/Utilities/useWindowDimensions");
const mockDimensions = useWindowDimensions as jest.MockedFunction<typeof useWindowDimensions>;

const mockApi = api as jest.Mocked<typeof api>;
const mockWatch = watchRun as jest.MockedFunction<typeof watchRun>;

// ── fixtures ─────────────────────────────────────────────────────────────────

let nextId = 1;
let seq = 0;

/** The run the screen is currently watching, so a test can feed it events. */
let watching: { runId: string; options: WatchOptions; stopped: boolean } | null = null;

function message(role: "user" | "assistant", content: ContentBlock[]): ChatMessage {
  return {
    id: nextId++,
    role,
    content,
    text: content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("\n\n"),
    stop_reason: null,
    created_at: null,
  };
}

const text = (t: string): ContentBlock => ({ type: "text", text: t });
const call = (id: string, name: string, input: Record<string, unknown> = {}): ContentBlock =>
  ({ type: "tool_use", id, name, input });

function conversation(id: number, title: string | null): Conversation {
  return { id, title, last_message_at: "2026-09-05T09:00:00+00:00", created_at: "2026-09-05T09:00:00+00:00" };
}

function pendingAction(id: number, tool = "log_workout"): AgentAction {
  return {
    id,
    tool,
    input: { title: "Push Day" },
    requires_confirmation: true,
    status: "pending",
    result: null,
    is_error: false,
    decided_at: null,
    created_at: null,
  };
}

function runRow(over: Partial<AgentRun> = {}): AgentRun {
  return {
    id: "run-1",
    conversation_id: 1,
    trigger: "message",
    status: "queued",
    finished: false,
    error: null,
    created_at: null,
    ...over,
  };
}

function accepted(over: Partial<MessageAccepted> = {}): MessageAccepted {
  return {
    run: runRow(),
    conversation: conversation(1, "how was last week?"),
    message: message("user", [text("how was last week?")]),
    ...over,
  };
}

function event(type: string, data: Record<string, unknown> = {}): RunEvent {
  return { seq: ++seq, type, data };
}

/** Push events into the run the screen is watching. */
async function emit(...events: RunEvent[]) {
  await act(async () => {
    watching!.options.onEvents(events);
  });
}

/**
 * End the run the way the watcher does: the closing event, then the callback
 * that makes the screen re-read the thread.
 */
async function finishRun(status = "completed", data: Record<string, unknown> = {}) {
  await act(async () => {
    watching!.options.onEvents([event("run.finished", { status, ...data })]);
    await watching!.options.onDone();
  });
}

function httpError(status: number, message: string): ApiError {
  const e = new Error(message) as ApiError;
  e.status = status;
  return e;
}

/**
 * The owner `AssistantFull` no longer is.
 *
 * 8.2 took the conversation out of this view and made it a prop, so that "open
 * the full Assistant" continues *the thread the HUD's panel was showing* rather
 * than quietly opening a different one. That is the only change of substance,
 * and the proof it was behaviour-preserving is that every assertion below this
 * line passes unchanged — the same proof the conversation's extraction was
 * given in 7.2.
 */
function Host({ assistantOff = false }: { assistantOff?: boolean }) {
  const chat = useConversation({ active: true });

  return (
    <>
      {/* The chrome, standing in for the overlay's: an owner holds the
          conversation, draws the state light and frames the rest. The orb used
          to be inside this view's own header and moved out with the title, so
          the assertions below reach it the way the real caller presents it. */}
      <AssistantOrb state={chat.orb} />
      <AssistantFull chat={chat} assistantOff={assistantOff} />
    </>
  );
}

/** Render wide enough that the thread rail and the transcript are both on screen. */
function renderChat(width = 1200) {
  mockDimensions.mockReturnValue({ width, height: 900, scale: 1, fontScale: 1 });
  return render(<Host />);
}

async function type(q: ReturnType<typeof render>, value: string) {
  fireEvent.changeText(q.getByLabelText("Message"), value);
}

/** Open the screen, type, send — and stop with the run queued and unanswered. */
async function sendAndWait(q: ReturnType<typeof render>, prompt: string) {
  await type(q, prompt);
  fireEvent.press(q.getByLabelText("Send"));
  await waitFor(() => expect(watching).not.toBeNull());
}

beforeEach(() => {
  nextId = 1;
  seq = 0;
  watching = null;
  jest.clearAllMocks();

  mockWatch.mockImplementation((runId, options) => {
    watching = { runId, options, stopped: false };
    return {
      stop: () => {
        if (watching?.runId === runId) watching.stopped = true;
      },
    };
  });

  mockApi.listConversations.mockResolvedValue({ data: [] });
  mockApi.getConversation.mockResolvedValue({
    conversation: conversation(1, "how was last week?"),
    messages: [],
    pending_actions: [],
    run: null,
  });
  mockApi.createConversation.mockResolvedValue(conversation(1, null));
});

// ── the empty state ──────────────────────────────────────────────────────────

it("offers openers before there is anything to read", async () => {
  const q = renderChat();

  await waitFor(() => expect(q.getByText("Ask about your training.")).toBeTruthy());
  expect(q.getByText("What are my recent PRs?")).toBeTruthy();
});

it("loads an opener into the composer", async () => {
  const q = renderChat();
  await waitFor(() => expect(q.getByText("What are my recent PRs?")).toBeTruthy());

  fireEvent.press(q.getByText("What are my recent PRs?"));

  expect(q.getByLabelText("Message").props.value).toBe("What are my recent PRs?");
});

it("shows the assistant as idle until there is something to do", async () => {
  const q = renderChat();

  await waitFor(() => expect(q.getByLabelText("Assistant idle")).toBeTruthy());
});

// ── sending ──────────────────────────────────────────────────────────────────

it("creates a thread on the first message rather than on arrival", async () => {
  const q = renderChat();
  await waitFor(() => expect(mockApi.listConversations).toHaveBeenCalled());

  // Opening the screen must not litter the database with empty threads.
  expect(mockApi.createConversation).not.toHaveBeenCalled();

  mockApi.sendMessage.mockResolvedValue(accepted());
  await sendAndWait(q, "how was last week?");

  expect(mockApi.createConversation).toHaveBeenCalledTimes(1);
  // The third argument is the camera frame, and this screen has no camera on
  // it: capture lives on the HUD, and the composer only carries what it is
  // handed.
  expect(mockApi.sendMessage).toHaveBeenCalledWith(1, "how was last week?", null);
});

it("starts watching the run the message queued", async () => {
  const q = renderChat();
  await waitFor(() => expect(mockApi.listConversations).toHaveBeenCalled());

  mockApi.sendMessage.mockResolvedValue(accepted({ run: runRow({ id: "run-42" }) }));
  await sendAndWait(q, "how was last week?");

  expect(watching!.runId).toBe("run-42");
  expect(q.getByLabelText("Assistant working")).toBeTruthy();
});

it("shows the typed message while the run has said nothing yet", async () => {
  const q = renderChat();
  await waitFor(() => expect(mockApi.listConversations).toHaveBeenCalled());

  mockApi.sendMessage.mockResolvedValue(accepted());
  await sendAndWait(q, "how was last week?");

  expect(q.getByText("how was last week?")).toBeTruthy();
  // Queued, so there is nothing to draw but the fact that something is
  // happening. An empty screen is not a state.
  expect(q.getByText("Working…")).toBeTruthy();
});

it("writes the answer out as it arrives", async () => {
  const q = renderChat();
  await waitFor(() => expect(mockApi.listConversations).toHaveBeenCalled());

  mockApi.sendMessage.mockResolvedValue(accepted());
  await sendAndWait(q, "how was last week?");

  await emit(event("run.started"), event("text", { delta: "You trained " }));
  expect(q.getByText("You trained")).toBeTruthy();

  await emit(event("text", { delta: "four times." }));
  expect(q.getByText("You trained four times.")).toBeTruthy();

  // The spinner goes the moment there is anything real to read.
  expect(q.queryByText("Working…")).toBeNull();
});

it("shows the model's reasoning only until it starts answering", async () => {
  const q = renderChat();
  await waitFor(() => expect(mockApi.listConversations).toHaveBeenCalled());

  mockApi.sendMessage.mockResolvedValue(accepted());
  await sendAndWait(q, "how was last week?");

  await emit(event("run.started"), event("thinking", { delta: "Checking the last four weeks." }));
  expect(q.getByText("Checking the last four weeks.")).toBeTruthy();

  await emit(event("text", { delta: "Four sessions." }));
  expect(q.queryByText("Checking the last four weeks.")).toBeNull();
});

it("names the tools as they are called, and marks them as they come back", async () => {
  const q = renderChat();
  await waitFor(() => expect(mockApi.listConversations).toHaveBeenCalled());

  mockApi.sendMessage.mockResolvedValue(accepted());
  await sendAndWait(q, "how am I doing?");

  await emit(
    event("run.started"),
    event("tool.started", { tool_use_id: "toolu_1", tool: "get_fitness_stats", input: { range: "4w" } }),
  );

  expect(q.getByText("Get fitness stats")).toBeTruthy();
  // Running, not done: a tick here would claim a result nobody has yet.
  expect(q.getByText("…")).toBeTruthy();

  await emit(event("tool.finished", { tool_use_id: "toolu_1", tool: "get_fitness_stats", is_error: false }));
  expect(q.getByText("✓")).toBeTruthy();
});

it("replaces the live preview with the stored transcript when the run ends", async () => {
  const q = renderChat();
  await waitFor(() => expect(mockApi.listConversations).toHaveBeenCalled());

  mockApi.sendMessage.mockResolvedValue(accepted());
  await sendAndWait(q, "how was last week?");
  await emit(event("run.started"), event("text", { delta: "Four sessions." }));

  mockApi.getConversation.mockResolvedValue({
    conversation: conversation(1, "how was last week?"),
    messages: [
      message("user", [text("how was last week?")]),
      message("assistant", [call("toolu_1", "get_fitness_stats", { range: "4w" })]),
      message("user", [{ type: "tool_result", tool_use_id: "toolu_1", content: "12 sessions" }]),
      message("assistant", [text("Four sessions.")]),
    ],
    pending_actions: [],
    run: null,
  });

  await finishRun();

  // Not duplicated — the preview is gone and the stored turns are what is left
  // — and now carrying the results the events never had.
  expect(q.getAllByText("Four sessions.")).toHaveLength(1);
  fireEvent.press(q.getByLabelText("Get fitness stats"));
  expect(q.getByText("12 sessions")).toBeTruthy();
  expect(q.getByLabelText("Assistant idle")).toBeTruthy();
});

// ── the confirmation gate ────────────────────────────────────────────────────

describe("when the assistant proposes a write", () => {
  async function proposeAWrite() {
    const q = renderChat();
    await waitFor(() => expect(mockApi.listConversations).toHaveBeenCalled());

    mockApi.sendMessage.mockResolvedValue(accepted({ message: message("user", [text("log push day")]) }));
    await sendAndWait(q, "log push day");

    await emit(
      event("run.started"),
      event("tool.started", {
        tool_use_id: "toolu_1",
        tool: "log_workout",
        input: { title: "Push Day" },
        requires_confirmation: true,
      }),
      event("awaiting", { action_ids: [7] }),
    );

    mockApi.getConversation.mockResolvedValue({
      conversation: conversation(1, "log push day"),
      messages: [
        message("user", [text("log push day")]),
        message("assistant", [call("toolu_1", "log_workout", { title: "Push Day" })]),
      ],
      pending_actions: [pendingAction(7)],
      run: null,
    });

    await finishRun("awaiting_confirmation");
    await waitFor(() => expect(q.getByText("Approve")).toBeTruthy());

    return q;
  }

  it("shows exactly what is about to be written", async () => {
    const q = await proposeAWrite();

    // Named twice on purpose: the call in the transcript, and the card asking
    // about it. Only the card spells the arguments out.
    expect(q.getAllByText("Log workout")).toHaveLength(2);
    expect(q.getByText(/"title": "Push Day"/)).toBeTruthy();
  });

  it("does not mark the parked call as having run", async () => {
    const q = await proposeAWrite();

    // A tick beside a write that is still waiting for a decision says the
    // opposite of what the card below it is asking.
    expect(q.queryByText("✓")).toBeNull();
    expect(q.getByText("·")).toBeTruthy();
  });

  it("holds the orb still rather than showing work in progress", async () => {
    const q = await proposeAWrite();

    // Motion beside an approval card says the job is still going, which is
    // exactly the wrong thing to say to someone being asked to decide.
    expect(q.getByLabelText("Assistant waiting for you")).toBeTruthy();
  });

  it("closes the composer until it is decided", async () => {
    const q = await proposeAWrite();

    // Not politeness: the transcript now ends with an unanswered tool call, and
    // sending anything else is a 409.
    expect(q.getByLabelText("Message").props.editable).toBe(false);
    expect(q.getByText("Approve or decline the change above to carry on.")).toBeTruthy();
  });

  it("approves, then watches the continuation it queued", async () => {
    const q = await proposeAWrite();

    mockApi.decideAction.mockResolvedValue({
      action: { ...pendingAction(7), status: "approved" },
      conversation: conversation(1, "log push day"),
      pending_actions: [],
      run: runRow({ id: "run-2", trigger: "resume" }),
    });

    fireEvent.press(q.getByText("Approve"));

    await waitFor(() => expect(mockApi.decideAction).toHaveBeenCalledWith(7, "approve"));
    await waitFor(() => expect(watching!.runId).toBe("run-2"));

    await emit(event("run.started"), event("text", { delta: "Logged Push Day." }));

    expect(q.getByText("Logged Push Day.")).toBeTruthy();
    expect(q.queryByText("Approve")).toBeNull();
  });

  it("declines without writing anything", async () => {
    const q = await proposeAWrite();

    mockApi.decideAction.mockResolvedValue({
      action: { ...pendingAction(7), status: "rejected" },
      conversation: conversation(1, "log push day"),
      pending_actions: [],
      run: runRow({ id: "run-2", trigger: "resume" }),
    });

    fireEvent.press(q.getByText("Decline"));

    await waitFor(() => expect(mockApi.decideAction).toHaveBeenCalledWith(7, "reject"));
    await waitFor(() => expect(watching!.runId).toBe("run-2"));

    await emit(event("run.started"), event("text", { delta: "Left it alone." }));
    expect(q.getByText("Left it alone.")).toBeTruthy();
  });

  it("keeps the remaining cards up when another write is still undecided", async () => {
    const q = await proposeAWrite();

    // Nothing to resume yet, so no run comes back and the composer stays shut.
    mockApi.decideAction.mockResolvedValue({
      action: { ...pendingAction(7), status: "approved" },
      conversation: conversation(1, "log push day"),
      pending_actions: [pendingAction(8, "update_workout")],
      run: null,
    });

    fireEvent.press(q.getByText("Approve"));

    await waitFor(() => expect(q.getByText("Update workout")).toBeTruthy());
    expect(q.getByLabelText("Message").props.editable).toBe(false);
  });

  it("reopens the composer once nothing is pending", async () => {
    const q = await proposeAWrite();

    mockApi.decideAction.mockResolvedValue({
      action: { ...pendingAction(7), status: "approved" },
      conversation: conversation(1, "log push day"),
      pending_actions: [],
      run: runRow({ id: "run-2", trigger: "resume" }),
    });

    mockApi.getConversation.mockResolvedValue({
      conversation: conversation(1, "log push day"),
      messages: [message("assistant", [text("Logged Push Day.")])],
      pending_actions: [],
      run: null,
    });

    fireEvent.press(q.getByText("Approve"));
    await waitFor(() => expect(watching!.runId).toBe("run-2"));
    await finishRun();

    await waitFor(() => expect(q.getByLabelText("Message").props.editable).toBe(true));
  });
});

// ── failures ─────────────────────────────────────────────────────────────────

it("gives the message back when the server never took it", async () => {
  const q = renderChat();
  await waitFor(() => expect(mockApi.listConversations).toHaveBeenCalled());

  // A 409 is raised before the user turn is stored, so the re-read finds no
  // trace of it and the composer must not have swallowed it.
  mockApi.sendMessage.mockRejectedValue(httpError(409, "A proposed change is waiting."));

  await type(q, "log push day");
  fireEvent.press(q.getByLabelText("Send"));

  await waitFor(() => expect(q.getByText("A proposed change is waiting.")).toBeTruthy());
  expect(q.getByLabelText("Message").props.value).toBe("log push day");
});

it("keeps the message on screen when the server did take it", async () => {
  const q = renderChat();
  await waitFor(() => expect(mockApi.listConversations).toHaveBeenCalled());

  // The connection dropped after the turn was stored. Re-sending would
  // duplicate it, so the composer stays empty and the stored turn is what
  // shows.
  mockApi.sendMessage.mockRejectedValue(new Error("Network request failed"));
  mockApi.getConversation.mockResolvedValue({
    conversation: conversation(1, "log push day"),
    messages: [message("user", [text("log push day")])],
    pending_actions: [],
    run: null,
  });

  await type(q, "log push day");
  fireEvent.press(q.getByLabelText("Send"));

  await waitFor(() => expect(q.getByText("Network request failed")).toBeTruthy());
  expect(q.getByLabelText("Message").props.value).toBe("");
  expect(q.getAllByText("log push day")).toHaveLength(1);
});

it("reports a run that failed, which no transcript can", async () => {
  const q = renderChat();
  await waitFor(() => expect(mockApi.listConversations).toHaveBeenCalled());

  mockApi.sendMessage.mockResolvedValue(accepted());
  await sendAndWait(q, "how was last week?");

  // Nothing was written, so the reason exists only on the run — and the screen
  // is the only place it will ever be seen.
  await finishRun("failed", { error: "Claude call failed: overloaded" });

  expect(q.getByText("Claude call failed: overloaded")).toBeTruthy();
  expect(q.getByLabelText("Assistant failed")).toBeTruthy();
});

it("says when the assistant ran out of steps", async () => {
  const q = renderChat();
  await waitFor(() => expect(mockApi.listConversations).toHaveBeenCalled());

  mockApi.sendMessage.mockResolvedValue(accepted());
  await sendAndWait(q, "compare every month this year");
  await finishRun("max_iterations");

  await waitFor(() => expect(q.getByText(/reached its step limit/)).toBeTruthy());
});

// ── threads ──────────────────────────────────────────────────────────────────

it("opens the most recent thread on arrival", async () => {
  mockApi.listConversations.mockResolvedValue({
    data: [conversation(9, "Newer"), conversation(8, "Older")],
  });
  mockApi.getConversation.mockResolvedValue({
    conversation: conversation(9, "Newer"),
    messages: [message("assistant", [text("From the newer thread.")])],
    pending_actions: [],
    run: null,
  });

  const q = renderChat();

  await waitFor(() => expect(q.getByText("From the newer thread.")).toBeTruthy());
  expect(mockApi.getConversation).toHaveBeenCalledWith(9);
});

it("rejoins a run that is still going in the thread it opens", async () => {
  mockApi.listConversations.mockResolvedValue({ data: [conversation(9, "Newer")] });
  mockApi.getConversation.mockResolvedValue({
    conversation: conversation(9, "Newer"),
    messages: [message("user", [text("how was last week?")])],
    pending_actions: [],
    // Left running by another tab, or by this one before a reload. Without
    // this the transcript just stops mid-question.
    run: runRow({ id: "run-live", conversation_id: 9, status: "running" }),
  });

  const q = renderChat();

  await waitFor(() => expect(watching!.runId).toBe("run-live"));
  await emit(event("text", { delta: "Four sessions." }));
  expect(q.getByText("Four sessions.")).toBeTruthy();
});

it("switches threads", async () => {
  mockApi.listConversations.mockResolvedValue({
    data: [conversation(9, "Newer"), conversation(8, "Older")],
  });
  const q = renderChat();
  await waitFor(() => expect(q.getByText("Older")).toBeTruthy());

  fireEvent.press(q.getByText("Older"));

  await waitFor(() => expect(mockApi.getConversation).toHaveBeenCalledWith(8));
});

it("deletes a thread only after confirming", async () => {
  mockApi.listConversations.mockResolvedValue({ data: [conversation(9, "Newer")] });
  mockApi.deleteConversation.mockResolvedValue(undefined);

  const q = renderChat();
  await waitFor(() => expect(q.getByText("Newer")).toBeTruthy());

  fireEvent.press(q.getByLabelText("Delete Newer"));
  expect(mockApi.deleteConversation).not.toHaveBeenCalled();

  // The wording matters: the transcript goes, the workouts it wrote do not.
  expect(q.getByText(/anything the assistant already wrote/)).toBeTruthy();
  fireEvent.press(q.getByText("Delete"));

  await waitFor(() => expect(mockApi.deleteConversation).toHaveBeenCalledWith(9));
  await waitFor(() => expect(q.queryByText("Newer")).toBeNull());
});

// ── narrow viewports ─────────────────────────────────────────────────────────

describe("on a narrow viewport", () => {
  it("shows the transcript, not the thread list", async () => {
    mockApi.listConversations.mockResolvedValue({ data: [conversation(9, "Newer")] });
    const q = renderChat(600);

    await waitFor(() => expect(mockApi.listConversations).toHaveBeenCalled());
    expect(q.queryByText("Newer")).toBeNull();
    expect(q.getByLabelText("Message")).toBeTruthy();
  });

  it("swaps to the thread list from the toggle", async () => {
    mockApi.listConversations.mockResolvedValue({ data: [conversation(9, "Newer")] });
    const q = renderChat(600);
    await waitFor(() => expect(mockApi.listConversations).toHaveBeenCalled());

    fireEvent.press(q.getByLabelText("Conversations"));

    expect(q.getByText("Newer")).toBeTruthy();
    expect(q.queryByLabelText("Message")).toBeNull();
  });

  it("goes back to the transcript once a thread is picked", async () => {
    mockApi.listConversations.mockResolvedValue({ data: [conversation(9, "Newer")] });
    const q = renderChat(600);
    await waitFor(() => expect(mockApi.listConversations).toHaveBeenCalled());

    fireEvent.press(q.getByLabelText("Conversations"));
    fireEvent.press(q.getByText("Newer"));

    await waitFor(() => expect(q.getByLabelText("Message")).toBeTruthy());
  });
});

// ── Typed, and only typed ────────────────────────────────────────────────────
//
// The Talk button lived in this composer from 9.1 until the HUD's microphone
// replaced the ASK pill. A spoken conversation is started from the HUD now —
// the tests for it are in `Hud.test.tsx`, beside the button — and what is left
// to assert here is that it is gone from this view rather than duplicated.

it("offers no microphone, because talking is the HUD's button", async () => {
  const q = renderChat();
  await waitFor(() => expect(q.getByLabelText("Message")).toBeTruthy());

  expect(q.queryByLabelText("Talk to the assistant")).toBeNull();
  expect(q.queryByText(/ElevenLabs/)).toBeNull();
});

// ── The Anthropic switch ──────────────────────────────────────────────────────

it("closes the composer and says why while the API is switched off", async () => {
  mockDimensions.mockReturnValue({ width: 1200, height: 900, scale: 1, fontScale: 1 });
  const q = render(<Host assistantOff />);

  await waitFor(() => expect(q.getByLabelText("Message")).toBeTruthy());

  // Said before the send rather than after it: the server refuses cleanly
  // either way, but "type a paragraph, press enter, read an error" is a worse
  // way to find out.
  expect(
    q.getByText("The Anthropic API is switched off under Settings, so the assistant can't answer."),
  ).toBeTruthy();
  expect(q.getByLabelText("Message").props.editable).toBe(false);
});

it("leaves the composer open while the API is on", async () => {
  const q = renderChat();
  await waitFor(() => expect(q.getByLabelText("Message")).toBeTruthy());

  expect(q.queryByText(/switched off under Settings/)).toBeNull();
  expect(q.getByLabelText("Message").props.editable).toBe(true);
});
