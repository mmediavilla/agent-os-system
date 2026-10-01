import { useCallback, useEffect, useRef, useState } from "react";
import { OrbState } from "./components/AssistantOrb";
import {
  AgentAction,
  AgentRun,
  ChatMessage,
  Conversation,
  RunStatus,
  api,
  errorMessage,
} from "./api";
import { CapturedFrame } from "./camera";
import { ChatItem, chatItems } from "./chat";
import { LiveRun, applyRunEvents, emptyRun } from "./run";
import { RunWatch, watchRun } from "./runWatcher";
import { AgentSessionController, useAgentSession } from "./useAgentSession";
import { useRefreshOnActivate } from "./useRefreshOnActivate";

/**
 * Talking to the assistant, without drawing anything.
 *
 * All of this was inside `Chat.tsx` and is unchanged in substance; what forced
 * it out is that the HUD's drawer needs the same conversation and the screen it
 * came from is a different shape. Copying two hundred lines of run-watching and
 * 409 handling into a second component would have produced one copy that gets
 * exercised daily and one that quietly rots — and the one that rots would be
 * the HUD's, which is the screen this phase is about.
 *
 * Four properties of `/api/agent/*` shape everything here, and they are the
 * reason this is a hook rather than a fetch:
 *
 * **A message returns before it is answered.** `sendMessage` stores the turn and
 * hands back a run id; the loop happens on a worker. So this watches the run and
 * exposes what it has reported so far.
 *
 * **The live view is a preview and never the record.** Every event duplicates
 * something the server writes to the transcript anyway, so when a run ends the
 * preview is dropped and the thread is re-read. `LiveRun` is shaped like
 * `chatItems` precisely so that swap is invisible.
 *
 * **A proposed write stops everything.** While an action is pending the
 * transcript ends with an unanswered tool call and sending anything else is a
 * 409 — hence `busy`, which closes the composer rather than letting it be
 * optimistic.
 *
 * **Errors are resolved by re-reading, not by guessing.** A failed send may or
 * may not have stored the user's turn and the response does not say, so the
 * thread is re-fetched and the draft comes back only when the server turns out
 * not to be holding it.
 *
 * **Voice belongs here rather than beside it.** The spoken session is composed
 * in rather than hung off the composer — which is what let the Talk button
 * leave the composer for the HUD's microphone without anything moving here:
 * `orb` still reports `listening` and `speaking` the way it reports everything
 * else, and a spoken turn still lands in the thread this hook is holding, which
 * is the one the full Assistant shows when it is opened.
 */
export type ConversationController = {
  conversations: Conversation[];
  activeId: number | null;
  /** The stored transcript, flattened for drawing. */
  items: ChatItem[];
  pending: AgentAction[];
  /** How the last run ended, until something else starts. */
  status: RunStatus | null;
  /** The run in progress, folded from its events. Null when nothing is going. */
  live: LiveRun | null;
  draft: string;
  /**
   * The camera frame waiting on the composer, if there is one.
   *
   * Staged rather than sent on capture, because a picture on its own is rarely
   * the whole question and pressing a shutter is not pressing send. It lives
   * here rather than on the HUD for the reason everything else in this hook
   * does: the panel that takes it and the composer that carries it are two
   * different components, and the Assistant screen shares the second one.
   */
  snapshot: CapturedFrame | null;
  loadingThread: boolean;
  decidingId: number | null;
  error: string | null;

  /** A write is parked and nothing else may be sent until it is decided. */
  awaiting: boolean;
  /** Something is in flight — a send, a run, a decision. */
  working: boolean;
  /** Either of the above: what closes the composer. */
  busy: boolean;
  /** What the orb and the holographic core are told to do. */
  orb: OrbState;
  /** The live spoken conversation — the HUD's microphone, and everything behind it. */
  session: AgentSessionController;

  setDraft: (text: string) => void;
  /** Put a captured frame on the composer, replacing whatever was there. */
  attachSnapshot: (frame: CapturedFrame) => void;
  /** Take it off again without sending it. */
  discardSnapshot: () => void;
  send: () => Promise<void>;
  decide: (action: AgentAction, decision: "approve" | "reject") => Promise<void>;
  openThread: (id: number | null) => void;
  startNewThread: () => void;
  deleteThread: (conversation: Conversation) => Promise<void>;
  refreshThreads: () => void;
};

export function useConversation({
  active = true,
  off = false,
  unavailable = false,
}: {
  active?: boolean;
  /** The Anthropic switch is off, as the last health reading said. */
  off?: boolean;
  /** It is on, but something it needs is not answering. See `orbState`. */
  unavailable?: boolean;
} = {}): ConversationController {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pending, setPending] = useState<AgentAction[]>([]);
  const [status, setStatus] = useState<RunStatus | null>(null);

  /** The run being watched, and what it has said so far. Both null when idle. */
  const [run, setRun] = useState<AgentRun | null>(null);
  const [live, setLive] = useState<LiveRun | null>(null);

  const [draft, setDraft] = useState("");
  const [snapshot, setSnapshot] = useState<CapturedFrame | null>(null);
  const [loadingThread, setLoadingThread] = useState(false);
  /** The POST itself, which is brief — the wait that matters is the run. */
  const [sending, setSending] = useState(false);
  const [decidingId, setDecidingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Held in a ref rather than in state because stopping a watcher is not a
  // rendering concern and must happen synchronously — on a thread change, or an
  // unmount, before the next one is started.
  const watch = useRef<RunWatch | null>(null);

  // A thread this hook created a moment ago, to keep the effect below from
  // reading it. Selecting a thread means "fetch it", and that is right for
  // every thread but the one `send` just made: it is empty by construction, and
  // the fetch would land after the run it was created for and replace the
  // answer with nothing.
  const justCreated = useRef<number | null>(null);

  /**
   * Re-read the open thread without taking it off the screen first.
   *
   * The effect below does the same fetch and is the wrong instrument here: it
   * raises `loadingThread`, which blanks the transcript for a spinner. That is
   * right when you have asked for a *different* thread and wrong when a turn
   * has just landed in the one you are reading — the transcript would flicker
   * empty every time something was said out loud.
   */
  const absorbThread = useCallback(async (id: number) => {
    try {
      const detail = await api.getConversation(id);
      setMessages(detail.messages);
      setPending(detail.pending_actions);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  /**
   * The spoken conversation, which lands in the thread on screen.
   *
   * Nothing about the transcript is mirrored or duplicated for it: a spoken
   * question goes through `POST /api/voice/turn`, which runs the same runner
   * over the same tools and writes the same `conversation_messages` rows — so
   * the exchange *is* the thread, and all this has to do is re-read it. That is
   * the whole payoff of keeping the brain in Laravel rather than giving the
   * voice a transcript of its own.
   *
   * When no thread is open the server makes one and names it after the first
   * thing said, exactly as a typed message does; the id comes back with the
   * answer and is selected here, which is what puts the conversation you are
   * having out loud in front of you rather than behind whatever was there.
   */
  const session = useAgentSession({
    active,
    conversationId: activeId,
    onTurn: (id) => {
      if (id === activeId) {
        absorbThread(id);

        return;
      }

      setActiveId(id);
      loadConversations();
    },
  });

  const loadConversations = useCallback(async (select?: "first") => {
    try {
      const { data } = await api.listConversations();
      setConversations(data);
      if (select === "first") setActiveId((prev) => prev ?? data[0]?.id ?? null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    loadConversations("first");
  }, [loadConversations]);

  // Threads can also grow from outside this screen — a proactive nudge does not
  // create one, but a second tab or an MCP host might — so the list is re-read
  // on re-entry rather than trusted from the last visit.
  useRefreshOnActivate(
    active,
    useCallback(() => {
      loadConversations();
    }, [loadConversations]),
  );

  const stopWatching = () => {
    watch.current?.stop();
    watch.current = null;
  };

  // Nothing should outlive the screen: a watcher left running is a poll loop
  // against a thread nobody is looking at.
  useEffect(() => stopWatching, []);

  /**
   * Follow a run, and put the thread back in step with the server when it ends.
   *
   * The re-read at the end is not belt and braces — it is where the truth comes
   * from. The live preview is assembled from events that carry no ids and no
   * results, so what replaces it is the stored transcript, which has both.
   */
  const startWatching = (queued: AgentRun) => {
    stopWatching();

    setRun(queued);
    setLive(emptyRun(queued.status));

    watch.current = watchRun(queued.id, {
      streamUrl: queued.stream_url,
      onEvents: (events) => {
        setLive((prev) => applyRunEvents(prev ?? emptyRun(), events));

        const ended = events.find((e) => e.type === "run.finished");
        if (!ended) return;

        const ending = (ended.data?.status as RunStatus) ?? "completed";
        setStatus(ending);

        // The one thing the transcript cannot tell the user afterwards: a run
        // that failed wrote no turn at all, so the reason lives only here.
        if (ending === "failed") {
          setError(String(ended.data?.error ?? "The assistant could not finish that."));
        }
      },
      onDone: async () => {
        watch.current = null;

        try {
          const detail = await api.getConversation(queued.conversation_id);
          setMessages(detail.messages);
          setPending(detail.pending_actions);
        } catch (e) {
          setError(errorMessage(e));
        } finally {
          setRun(null);
          setLive(null);
        }
      },
    });
  };

  // Whenever the selected thread changes, read it whole. Cheap enough to do
  // every time: thinking blocks are dropped server-side, which is most of what
  // a transcript weighs.
  useEffect(() => {
    if (activeId === null) {
      stopWatching();
      setMessages([]);
      setPending([]);
      setStatus(null);
      setRun(null);
      setLive(null);
      return;
    }

    if (justCreated.current === activeId) {
      justCreated.current = null;
      return;
    }

    stopWatching();
    setRun(null);
    setLive(null);

    let cancelled = false;
    setLoadingThread(true);
    setError(null);

    api
      .getConversation(activeId)
      .then((detail) => {
        if (cancelled) return;
        setMessages(detail.messages);
        setPending(detail.pending_actions);
        setStatus(detail.pending_actions.length ? "awaiting_confirmation" : null);

        // Something is still going in this thread — another tab, or this one
        // before a reload. Rejoining is the difference between watching it
        // finish and staring at a transcript that stops mid-question.
        if (detail.run && !detail.run.finished) startWatching(detail.run);
      })
      .catch((e) => {
        if (!cancelled) setError(errorMessage(e));
      })
      .finally(() => {
        if (!cancelled) setLoadingThread(false);
      });

    return () => {
      cancelled = true;
    };
  }, [activeId]);

  const openThread = (id: number | null) => {
    setActiveId(id);
    setError(null);
  };

  const startNewThread = () => {
    // No request yet: an empty thread with nothing in it is not worth a row in
    // the database, and `send` creates one the moment there is something to say.
    openThread(null);
    setDraft("");
    // The frame was captured to ask something in the thread being left. It goes
    // with the words it was going to be asked with.
    setSnapshot(null);
  };

  /**
   * Put the screen back in step with the server after a failed send.
   *
   * Whether the message survived depends on how the request failed — a 502 is
   * raised after the user turn is stored, a 409 before — and the response does
   * not say. Re-reading the thread settles it, and the draft comes back only
   * when the server turns out not to be holding it.
   */
  const resync = async (id: number | null, text: string, frame: CapturedFrame | null = null) => {
    // The frame goes back on the composer with the words, and for the same
    // reason: a send that may not have landed must not silently throw away
    // something the user cannot retype.
    const restore = () => {
      setDraft(text);
      setSnapshot(frame);
    };

    if (id === null) {
      setMessages((prev) => prev.filter((m) => m.id > 0));
      restore();
      return;
    }

    try {
      const detail = await api.getConversation(id);
      setMessages(detail.messages);
      setPending(detail.pending_actions);
      setStatus(detail.pending_actions.length ? "awaiting_confirmation" : null);

      const last = detail.messages[detail.messages.length - 1];
      const held =
        !!last &&
        last.role === "user" &&
        last.text === text &&
        // An image-only turn has no text to compare, and two of them in a row
        // would otherwise look identical. Asking whether the stored turn
        // carries a picture is what tells them apart.
        (!frame || last.content.some((block) => block.type === "image"));

      if (!held) restore();
    } catch {
      // The thread could not be re-read either. Keep the typed message rather
      // than the optimistic bubble, which is now claiming something that may
      // not have happened.
      setMessages((prev) => prev.filter((m) => m.id > 0));
      restore();
    }
  };

  /**
   * Send what is in the composer, creating a thread first if there isn't one.
   *
   * The local turn is keyed with a negative id so it can be told apart from
   * anything the server sent, which is what lets it be swapped out cleanly for
   * the real thing rather than leaving a duplicate behind.
   */
  const send = async () => {
    const text = draft.trim();
    const frame = snapshot;

    // A snapshot with nothing typed is a whole question — "what is this?" is
    // implied by pointing a camera at something — so an empty composer is only
    // empty when there is no picture on it either.
    if ((!text && !frame) || sending || run !== null || pending.length) return;

    setError(null);
    setStatus(null);
    setSending(true);
    setDraft("");
    setSnapshot(null);
    setMessages((prev) => [...prev, localTurn(text, frame)]);

    let id = activeId;

    try {
      if (id === null) {
        const created = await api.createConversation();
        id = created.id;
        justCreated.current = created.id;
        setActiveId(created.id);
      }

      const accepted = await api.sendMessage(
        id,
        text,
        frame ? { data: frame.data, media_type: frame.mediaType } : null,
      );

      // The server's copy of the turn the user just typed, so the optimistic
      // bubble goes away now rather than when the run finishes.
      setMessages((prev) => [...prev.filter((m) => m.id > 0), accepted.message]);
      // The thread was probably just named after this message, and its position
      // in the list has certainly changed.
      loadConversations();

      startWatching(accepted.run);
    } catch (e) {
      setError(errorMessage(e));
      await resync(id, text, frame);
    } finally {
      setSending(false);
    }
  };

  /**
   * Approve or decline one proposed write; the last decision resumes the run.
   *
   * The write itself has already happened by the time this resolves — the
   * server runs it inside the decision request — and only the continuation is
   * queued, which is what `decision.run` is for. It is null while other writes
   * from the same turn are still waiting, and then the cards simply stay up.
   */
  const decide = async (action: AgentAction, decision: "approve" | "reject") => {
    setDecidingId(action.id);
    setError(null);

    try {
      const decided = await api.decideAction(action.id, decision);
      setPending(decided.pending_actions);

      if (decided.run) {
        setStatus(null);
        startWatching(decided.run);
      } else {
        setStatus("awaiting_confirmation");
      }
    } catch (e) {
      setError(errorMessage(e));
      if (activeId !== null) await resync(activeId, "");
    } finally {
      setDecidingId(null);
    }
  };

  const deleteThread = async (target: Conversation) => {
    try {
      await api.deleteConversation(target.id);
      setConversations((prev) => prev.filter((c) => c.id !== target.id));
      if (activeId === target.id) openThread(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const awaiting = pending.length > 0;
  const working = sending || run !== null || decidingId !== null;

  return {
    conversations,
    activeId,
    items: chatItems(messages),
    pending,
    status,
    live,
    draft,
    snapshot,
    loadingThread,
    decidingId,
    error,
    awaiting,
    working,
    busy: working || awaiting,
    orb: orbState({
      awaiting,
      working,
      live,
      status,
      listening: session.status === "connected" && session.mode === "listening",
      speaking: session.mode === "speaking",
      asking: session.asking,
      off,
      unavailable,
    }),
    session,
    setDraft,
    attachSnapshot: setSnapshot,
    discardSnapshot: () => setSnapshot(null),
    send,
    decide,
    openThread,
    startNewThread,
    deleteThread,
    refreshThreads: () => {
      loadConversations();
    },
  };
}

/**
 * Which of the eight states the assistant is in.
 *
 * The order is the whole of it. **Awaiting wins over working**, deliberately:
 * while an approval card is up, neither the orb nor the holographic core may
 * suggest that anything is still in progress — motion beside a card asking you
 * to decide says the job is going ahead anyway.
 *
 * `responding` came from the streamed events: a run writing prose looks
 * different from one calling tools, that distinction has been in the events
 * since Phase 5, and the last thing a run produced being text *is* the model
 * answering.
 *
 * **`listening` is reachable as of 7.3** and sits below `working`, which reads
 * backwards until you notice the two cannot honestly overlap: the composer is
 * closed while a run is going, so the only way to hold a live microphone into
 * one is to have started talking as the answer arrived. Showing the answer wins
 * — the ring going flat is a smaller loss than the sphere claiming to be idle
 * while a reply is being written.
 *
 * **9.1 adds two, and where they sit is the only interesting part.** `asking`
 * is a spoken question inside our tool loop, and it is deliberately *above*
 * `speaking`: the two genuinely overlap, because the ElevenLabs agent is
 * configured to say "let me check" and run the tool at the same time, and of
 * the two facts the one worth drawing is that the loop is running. It is also
 * the steadier reading — the alternative flips speaking → working → speaking
 * inside one answer. The cost is a couple of seconds of a flat ring under a
 * filler phrase, which is the smaller lie.
 *
 * `speaking` then sits above `listening` for the reason they are two states at
 * all: the session reports a mode, both ends of the call move the same ring,
 * and only this tells the ring which volume it is following.
 *
 * **`off` and `unavailable` replace `idle`, and nothing else** — they are what
 * the resting state is, not what is happening. Anything actually going on
 * outranks them: a parked write can still be decided with the switch off, and a
 * live microphone is proof enough that talking works. `off` is amber and keeps
 * turning, at the owner's call — a decision, not a fault, so it must not look like
 * `failed`. `unavailable` *is* `failed`, still and red: the switch is on and the
 * assistant cannot answer anyway, which is the thing to see from across the room.
 */
export function orbState({
  awaiting,
  working,
  live,
  status,
  listening = false,
  speaking = false,
  asking = false,
  off = false,
  unavailable = false,
}: {
  awaiting: boolean;
  working: boolean;
  live: LiveRun | null;
  status: RunStatus | null;
  listening?: boolean;
  speaking?: boolean;
  asking?: boolean;
  off?: boolean;
  unavailable?: boolean;
}): OrbState {
  if (awaiting) return "awaiting";

  if (working) {
    const last = live?.items[live.items.length - 1];
    return last?.kind === "said" ? "responding" : "working";
  }

  // No run to watch on this path — the voice turn is answered inside the client
  // tool's own await — so there is nothing to distinguish tools from prose and
  // `working` is the honest one of the two.
  if (asking) return "working";

  if (speaking) return "speaking";

  if (listening) return "listening";

  if (off) return "off";

  return unavailable || status === "failed" ? "failed" : "idle";
}

/**
 * The turn the user just typed, before the server has one of its own.
 *
 * A negative id, because ids from the server are always positive: that is what
 * lets the optimistic turn be filtered back out when the real transcript
 * arrives, without matching on text.
 */
function localTurn(text: string, snapshot: CapturedFrame | null): ChatMessage {
  return {
    id: -1,
    role: "user",
    content: [
      // The frame the composer is holding, drawn from the `data:` URL it was
      // captured into — there is no server copy to link to yet, and waiting for
      // one would make the picture appear a second after the question did.
      ...(snapshot ? [{ type: "image" as const, url: snapshot.dataUrl }] : []),
      // Dropped when empty, exactly as the server drops it: a snapshot on its
      // own is a whole question, and an empty bubble under it would read as a
      // message that failed to load.
      ...(text ? [{ type: "text" as const, text }] : []),
    ],
    text,
    stop_reason: null,
    created_at: null,
  };
}
