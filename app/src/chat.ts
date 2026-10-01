import { ChatMessage, ChatRole, ContentBlock } from "./api";

/**
 * Turning a stored transcript into something a chat screen can render.
 *
 * The transcript is shaped for the API, not for a reader, and the two disagree
 * in one way that decides this whole module: **the tool loop writes user
 * messages that no user typed.** Every turn the assistant spends calling tools
 * is answered by a `user` message made entirely of `tool_result` blocks, which
 * is what the Messages API requires and what a chat bubble must never show.
 * Rendering `messages` directly puts a wall of JSON on the right-hand side of
 * the screen, attributed to the person reading it.
 *
 * So the transcript is flattened into items, and a `tool_result` never becomes
 * one. It is folded into the call it answers instead — matched on
 * `tool_use_id`, which is why the results are collected before anything is
 * emitted: a call and its result live in different messages, and the result
 * always arrives later.
 *
 * Runs are contiguous, not per-message. One assistant turn can say something,
 * call two tools and say something else, and that is three items in that
 * order — collapsing it to "text, then tools" would put the model's summary
 * before the work it is summarising.
 */

/** One tool call, with whatever came back from it. */
export type ToolCall = {
  /** The wire id (`toolu_…`) — how a result finds the call it belongs to. */
  useId: string;
  name: string;
  input: Record<string, unknown>;
  /**
   * Null while nothing has come back: the call is parked awaiting confirmation,
   * or the run is still in flight. A failure is an outcome, not an absence —
   * `isError` carries it, because that is how the model was told too.
   */
  outcome: { text: string; isError: boolean } | null;
};

export type ChatItem =
  | { key: string; kind: "said"; role: ChatRole; text: string }
  | { key: string; kind: "tools"; calls: ToolCall[] }
  /**
   * A camera snapshot, as its own item rather than folded into the bubble
   * under it.
   *
   * The stored turn puts the picture before the words — that is the API's own
   * advice and reads the way the question was asked — so the picture is an item
   * that comes first and the text is the ordinary `said` after it. Merging the
   * two would mean a bubble that is sometimes a bubble and sometimes a frame,
   * which is more shape than one component wants.
   */
  | { key: string; kind: "image"; role: ChatRole; url: string; pending?: boolean };

/** Every `tool_result` in the thread, keyed by the call it answers. */
function outcomes(messages: ChatMessage[]): Map<string, { text: string; isError: boolean }> {
  const map = new Map<string, { text: string; isError: boolean }>();

  for (const message of messages) {
    for (const block of message.content ?? []) {
      if (block.type !== "tool_result") continue;
      const id = (block as { tool_use_id?: unknown }).tool_use_id;
      if (typeof id !== "string") continue;

      const content = (block as { content?: unknown }).content;
      map.set(id, {
        text: typeof content === "string" ? content : JSON.stringify(content ?? ""),
        isError: (block as { is_error?: unknown }).is_error === true,
      });
    }
  }

  return map;
}

function isText(block: ContentBlock): block is { type: "text"; text: string } {
  return block.type === "text" && typeof (block as { text?: unknown }).text === "string";
}

function isToolUse(
  block: ContentBlock,
): block is { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } {
  return block.type === "tool_use" && typeof (block as { name?: unknown }).name === "string";
}

/**
 * An image block a client can actually draw.
 *
 * The `url` is what separates a snapshot from the image blocks the API itself
 * defines, which carry base64 or a remote URL and never reach this side — the
 * server rewrites its own into a link to `/api/agent/snapshots/{id}` on the way
 * out. A block with no `url` is therefore something this app did not write, and
 * is left alone like any other unrecognised type.
 */
function isImage(block: ContentBlock): block is { type: "image"; url: string } {
  return block.type === "image" && typeof (block as { url?: unknown }).url === "string";
}

/**
 * The whole thread as a flat list of things to draw, oldest first.
 *
 * Blank runs are dropped rather than emitted empty — an assistant turn that
 * only called a tool has a `text` of `""`, and a bubble with nothing in it
 * reads as a message that failed to load.
 */
export function chatItems(messages: ChatMessage[]): ChatItem[] {
  const results = outcomes(messages);
  const items: ChatItem[] = [];

  for (const message of messages) {
    let said: string[] = [];
    let calls: ToolCall[] = [];
    let runIndex = 0;

    const flushSaid = () => {
      const text = said.join("\n\n").trim();
      if (text) items.push({ key: `${message.id}:${runIndex++}`, kind: "said", role: message.role, text });
      said = [];
    };

    const flushCalls = () => {
      if (calls.length) items.push({ key: `${message.id}:${runIndex++}`, kind: "tools", calls });
      calls = [];
    };

    for (const block of message.content ?? []) {
      if (isText(block)) {
        flushCalls();
        said.push(block.text);
        continue;
      }

      if (isImage(block)) {
        flushSaid();
        flushCalls();
        items.push({
          key: `${message.id}:${runIndex++}`,
          kind: "image",
          role: message.role,
          url: block.url,
          // A negative id is the optimistic turn the composer drew before the
          // server had the frame — see `localTurn`. Its URL is a local `data:`
          // one and is replaced the moment the real message comes back.
          pending: message.id < 0,
        });
        continue;
      }

      if (isToolUse(block)) {
        flushSaid();
        calls.push({
          useId: block.id,
          name: block.name,
          input: (block.input ?? {}) as Record<string, unknown>,
          outcome: results.get(block.id) ?? null,
        });
        continue;
      }

      // Anything else — a thinking block that somehow survived, a block type
      // added to the API after this was written — is skipped rather than
      // guessed at. There is nothing here that knows how to draw it.
    }

    flushSaid();
    flushCalls();
  }

  return items;
}

/**
 * The key of the last thing the *assistant* said, or null if it has not spoken.
 *
 * This is the HUD's unread signal, and a key rather than a count is the whole
 * of it: a count moves when the thread is switched, when a tool chip lands,
 * and when an optimistic turn is swapped for the server's copy — none of which
 * is the assistant having said something while nobody was looking. The user's
 * own turns are skipped for the same reason: a spoken question is written into
 * the thread as a user turn, and a dot advertising your own words back to you
 * says nothing.
 */
export function lastSaidKey(items: ChatItem[]): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.kind === "said" && item.role === "assistant") return item.key;
  }

  return null;
}

/**
 * The words of the assistant's last turn, or null if it has not spoken.
 *
 * `lastSaidKey`'s sibling, and it skips exactly what that skips: a turn that
 * only called a tool carries no `said` item at all, and the user's own turns are
 * not the assistant talking. What reads it is the spoken greeting, which needs
 * the text of a delivered conversation rather than a marker that it changed —
 * so the two cannot be one function returning one thing.
 */
export function lastSaidText(items: ChatItem[]): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.kind === "said" && item.role === "assistant") return item.text;
  }

  return null;
}

/** `log_workout` → `Log workout`. The tool names are the model's vocabulary, not the user's. */
export function toolLabel(name: string): string {
  const words = name.replace(/_/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : name;
}

/**
 * A proposed write, spelled out for the person deciding it.
 *
 * Pretty-printed JSON rather than a per-tool renderer: every tool would need
 * its own summary before that pays off, and a summary that omits a field is
 * worse than no summary at all when the whole point of the screen is to show
 * exactly what is about to be written.
 */
export function describeInput(input: Record<string, unknown> | null): string {
  if (!input || Object.keys(input).length === 0) return "No arguments.";
  return JSON.stringify(input, null, 2);
}

/**
 * One stretch of a message with a single emphasis.
 *
 * @see inlineSpans — nothing else builds these.
 */
export type Span = { text: string; bold?: boolean; code?: boolean };

/**
 * `**this**` and `` `this` ``, split out so a bubble can draw them.
 *
 * Deliberately not a markdown renderer. The system prompt asks for plain prose,
 * and a model mostly complies — but "mostly" is the operative word: bold and
 * inline code leak out of every model, in every prompt, and a chat window that
 * prints the asterisks looks broken in a way that no amount of prompting
 * reliably fixes. Everything else (headers, tables, links, block quotes) is left
 * to the prompt, because each one needs a block-level renderer to be worth
 * having and none of them leak the way emphasis does.
 *
 * Order matters in the pattern: `**bold**` is tried before a lone backtick run,
 * so the double markers are consumed as a pair rather than as two singles.
 */
export function inlineSpans(text: string): Span[] {
  const pattern = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  const spans: Span[] = [];
  let last = 0;

  for (let m = pattern.exec(text); m !== null; m = pattern.exec(text)) {
    if (m.index > last) spans.push({ text: text.slice(last, m.index) });
    if (m[1] !== undefined) spans.push({ text: m[1], bold: true });
    else spans.push({ text: m[2], code: true });
    last = m.index + m[0].length;
  }

  if (last < text.length) spans.push({ text: text.slice(last) });

  // One span, unmarked, for the overwhelmingly common case of no emphasis at
  // all — including the empty string, which must still render something.
  return spans.length ? spans : [{ text }];
}
