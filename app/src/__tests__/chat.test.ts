import { ChatMessage, ContentBlock } from "../api";
import { chatItems, describeInput, inlineSpans, lastSaidKey, lastSaidText, toolLabel } from "../chat";

let nextId = 1;

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
const result = (id: string, content: string, isError = false): ContentBlock =>
  ({ type: "tool_result", tool_use_id: id, content, ...(isError ? { is_error: true } : {}) });

beforeEach(() => {
  nextId = 1;
});

describe("chatItems", () => {
  it("renders a plain exchange as two bubbles", () => {
    const items = chatItems([
      message("user", [text("how was last week?")]),
      message("assistant", [text("Four sessions.")]),
    ]);

    expect(items).toEqual([
      { key: "1:0", kind: "said", role: "user", text: "how was last week?" },
      { key: "2:0", kind: "said", role: "assistant", text: "Four sessions." },
    ]);
  });

  it("never renders the loop's own user turns as messages", () => {
    // The whole reason this module exists: a turn spent calling tools is
    // answered by a `user` message of tool_result blocks that nobody typed.
    const items = chatItems([
      message("user", [text("how many workouts?")]),
      message("assistant", [call("toolu_1", "list_workouts")]),
      message("user", [result("toolu_1", '{"total":12}')]),
      message("assistant", [text("Twelve.")]),
    ]);

    expect(items.filter((i) => i.kind === "said" && i.role === "user")).toHaveLength(1);
  });

  it("folds a result into the call it answers", () => {
    const items = chatItems([
      message("assistant", [call("toolu_1", "get_fitness_stats", { range: "4w" })]),
      message("user", [result("toolu_1", "12 sessions")]),
    ]);

    expect(items).toEqual([
      {
        key: "1:0",
        kind: "tools",
        calls: [
          {
            useId: "toolu_1",
            name: "get_fitness_stats",
            input: { range: "4w" },
            outcome: { text: "12 sessions", isError: false },
          },
        ],
      },
    ]);
  });

  it("carries a failed call's error through", () => {
    const items = chatItems([
      message("assistant", [call("toolu_1", "log_workout")]),
      message("user", [result("toolu_1", "The started_at field is required.", true)]),
    ]);

    expect((items[0] as any).calls[0].outcome).toEqual({
      text: "The started_at field is required.",
      isError: true,
    });
  });

  it("leaves a call with no result yet unresolved", () => {
    // What a parked write looks like: proposed, and waiting on the user.
    const items = chatItems([message("assistant", [call("toolu_1", "log_workout")])]);

    expect((items[0] as any).calls[0].outcome).toBeNull();
  });

  it("keeps parallel calls from one turn in a single group", () => {
    const items = chatItems([
      message("assistant", [call("toolu_1", "list_workouts"), call("toolu_2", "list_equipment")]),
    ]);

    expect(items).toHaveLength(1);
    expect((items[0] as any).calls.map((c: any) => c.name)).toEqual([
      "list_workouts",
      "list_equipment",
    ]);
  });

  it("keeps text and calls in the order they were emitted", () => {
    // Collapsing this to "text, then tools" would put the model's summary above
    // the work it is summarising.
    const items = chatItems([
      message("assistant", [
        text("Let me check."),
        call("toolu_1", "list_workouts"),
        text("Twelve sessions."),
      ]),
    ]);

    expect(items.map((i) => i.kind)).toEqual(["said", "tools", "said"]);
    expect(items.map((i) => i.key)).toEqual(["1:0", "1:1", "1:2"]);
  });

  it("drops a turn that said nothing", () => {
    const items = chatItems([message("assistant", [text("   ")])]);

    expect(items).toEqual([]);
  });

  it("skips block types it cannot draw", () => {
    const items = chatItems([
      message("assistant", [
        { type: "thinking", thinking: "", signature: "sig" },
        text("Four sessions."),
      ]),
    ]);

    expect(items).toEqual([
      { key: "1:0", kind: "said", role: "assistant", text: "Four sessions." },
    ]);
  });

  it("draws a snapshot before the question it was asked with", () => {
    // The stored turn puts the picture first — the API's own advice, and how
    // the question actually reads.
    const items = chatItems([
      message("user", [
        { type: "image", snapshot_id: 7, media_type: "image/jpeg", url: "/api/agent/snapshots/7" },
        text("what is this?"),
      ]),
    ]);

    expect(items).toEqual([
      { key: "1:0", kind: "image", role: "user", url: "/api/agent/snapshots/7", pending: false },
      { key: "1:1", kind: "said", role: "user", text: "what is this?" },
    ]);
  });

  it("marks the composer's own copy as pending", () => {
    // A negative id is the optimistic turn, drawn from a local `data:` URL
    // before the server has the frame.
    const local: ChatMessage = {
      id: -1,
      role: "user",
      content: [{ type: "image", url: "data:image/jpeg;base64,QUJD" }],
      text: "",
      stop_reason: null,
      created_at: null,
    };

    expect(chatItems([local])).toEqual([
      { key: "-1:0", kind: "image", role: "user", url: "data:image/jpeg;base64,QUJD", pending: true },
    ]);
  });

  it("leaves an image block it cannot draw alone", () => {
    // The API's own image blocks carry base64 or a remote source and never
    // reach this side; one that did is something this app did not write.
    const items = chatItems([
      message("user", [
        { type: "image", source: { type: "base64", data: "QUJD" } },
        text("what is this?"),
      ]),
    ]);

    expect(items).toEqual([{ key: "1:0", kind: "said", role: "user", text: "what is this?" }]);
  });

  it("handles an empty thread", () => {
    expect(chatItems([])).toEqual([]);
  });
});

describe("lastSaidKey", () => {
  it("names the last thing the assistant said", () => {
    const key = lastSaidKey(
      chatItems([
        message("user", [text("how was last week?")]),
        message("assistant", [text("Four sessions.")]),
      ]),
    );

    expect(key).toBe("2:0");
  });

  it("ignores the user's own turns, which are not a reply", () => {
    // The full-window overlay can be typed into while the popover is shut, and
    // a dot advertising your own message back to you is worse than no dot.
    const items = chatItems([
      message("assistant", [text("Four sessions.")]),
      message("user", [text("and this week?")]),
    ]);

    expect(lastSaidKey(items)).toBe("1:0");
  });

  it("ignores a turn that only called a tool", () => {
    // A tool chip landing is the assistant working, not the assistant
    // answering — and the run it belongs to has not finished.
    const items = chatItems([
      message("assistant", [text("Checking.")]),
      message("assistant", [call("t1", "get_fitness_stats")]),
    ]);

    expect(lastSaidKey(items)).toBe("1:0");
  });

  it("has nothing to name in a conversation that has not started", () => {
    expect(lastSaidKey([])).toBeNull();
    expect(lastSaidKey(chatItems([message("user", [text("hello")])]))).toBeNull();
  });
});

describe("lastSaidText", () => {
  it("is the words of that same turn, for reading out loud", () => {
    const items = chatItems([
      message("user", [text("how was last week?")]),
      message("assistant", [text("Four sessions, sir.")]),
    ]);

    expect(lastSaidText(items)).toBe("Four sessions, sir.");
  });

  it("skips what its sibling skips", () => {
    // A tool chip is not an answer, and the user's own words are not the
    // assistant's — the same two rules, because a spoken greeting reading either
    // one back would be absurd in a way a dot merely is not.
    const items = chatItems([
      message("assistant", [text("Good morning.")]),
      message("assistant", [call("t1", "list_events")]),
      message("user", [text("thanks")]),
    ]);

    expect(lastSaidText(items)).toBe("Good morning.");
  });

  it("is null in a thread nothing has been said in", () => {
    // What a delivered greeting whose run failed leaves behind: a conversation
    // with nothing in it to speak.
    expect(lastSaidText([])).toBeNull();
    expect(lastSaidText(chatItems([message("user", [text("hello")])]))).toBeNull();
  });
});

describe("toolLabel", () => {
  it("reads a tool name as a phrase", () => {
    expect(toolLabel("log_workout")).toBe("Log workout");
    expect(toolLabel("get_fitness_stats")).toBe("Get fitness stats");
  });
});

describe("describeInput", () => {
  it("pretty-prints the arguments", () => {
    expect(describeInput({ title: "Push Day" })).toBe('{\n  "title": "Push Day"\n}');
  });

  it("says so when there are none", () => {
    expect(describeInput({})).toBe("No arguments.");
    expect(describeInput(null)).toBe("No arguments.");
  });
});

describe("inlineSpans", () => {
  it("leaves plain prose in one piece", () => {
    expect(inlineSpans("Four sessions.")).toEqual([{ text: "Four sessions." }]);
  });

  it("pulls bold out of a sentence", () => {
    expect(inlineSpans("Your **Bench Press** is up.")).toEqual([
      { text: "Your " },
      { text: "Bench Press", bold: true },
      { text: " is up." },
    ]);
  });

  it("pulls inline code out", () => {
    expect(inlineSpans("Use `log_workout`.")).toEqual([
      { text: "Use " },
      { text: "log_workout", code: true },
      { text: "." },
    ]);
  });

  it("reads a double marker as one pair, not two singles", () => {
    expect(inlineSpans("**Bold**")).toEqual([{ text: "Bold", bold: true }]);
  });

  it("leaves an unclosed marker alone", () => {
    // Better a stray asterisk than half a sentence swallowed by a greedy match.
    expect(inlineSpans("2 * 3 sets")).toEqual([{ text: "2 * 3 sets" }]);
  });

  it("always returns something to render", () => {
    expect(inlineSpans("")).toEqual([{ text: "" }]);
  });
});
