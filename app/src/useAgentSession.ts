import { useCallback, useEffect, useRef, useState } from "react";
import {
  ASK_TOOL,
  Disconnect,
  NO_QUESTION,
  SessionMode,
  SessionStatus,
  disconnectNote,
  sessionLevel,
  sessionNote,
  sessionSupported,
  spokenQuestion,
  spokenText,
  voiceFailure,
} from "./agentSession";
import { api, errorMessage } from "./api";
import { loadConversationSdk } from "./elevenlabsSdk";

/** The property the voice ring's 56 bars scale by. One writer, one reader. */
export const VOICE_LEVEL_PROPERTY = "--h-voice";

/**
 * A live spoken conversation, held by the browser and answered by our own loop.
 *
 * The handles are a WebRTC connection to ElevenLabs, a microphone, and an
 * animation frame; every decision that does not need one of those is in
 * `agentSession.ts` with a test on it. It replaced 7.3's `useVoice`, which
 * dictated into a text box through Chrome's recogniser and read replies back
 * with `speechSynthesis` — two half-features either side of a keyboard. This
 * is one conversation.
 *
 * **The brain did not move.** ElevenLabs hears the room, decides when a turn
 * ended, and speaks; for anything about the user it calls a client tool, and
 * that tool — `ask` below — posts to `POST /api/voice/turn`, which runs the same
 * `AgentRunner` a typed message runs, over the same tools, into the same
 * transcript. So the audit log, the confirmation gate and the persona are all
 * exactly where they were, and voice is a client of this app rather than a
 * second version of it.
 *
 * **The SDK is loaded when the button is pressed, not when the app loads** —
 * see `elevenlabsSdk.ts`, which is the whole of that decision and the reason it
 * is a module rather than an `import()` on the line below.
 *
 * **`@elevenlabs/client` rather than `@elevenlabs/react`**, which the plan for
 * this phase named. Their React hook now has to sit under a
 * `ConversationProvider`, and the consumer here is `useConversation`, which is
 * called by the component that would have to render that provider — so the
 * provider would have to go at the root of `App`, wrapping eight screens in a
 * third-party context to serve one button. The class underneath is the same
 * object their hook drives, and wrapping a browser API in a hook of our own is
 * what `useCamera` already does.
 */
export type AgentSessionController = {
  /** WebRTC and a microphone. Without both, there is no button. */
  supported: boolean;
  status: SessionStatus;
  /** Who is talking, while connected. Null when there is no session. */
  mode: SessionMode | null;
  error: string | null;
  /** What the voice has to say under the core, if anything — see `sessionNote`. */
  note: string | null;
  /** True from the press until the line is open, so a second press is a cancel. */
  connecting: boolean;
  /**
   * A spoken question is in our loop right now.
   *
   * Nothing else on screen would say so. A typed message is answered by a
   * queued run the screen watches, so `working` comes off the run events; a
   * spoken one is answered inside the client tool's own await, where there is
   * no run to watch and the only thing that knows is this hook. Without it the
   * sphere sits listening through the five to fifteen seconds the tool loop
   * takes, which is the one stretch of a spoken conversation where somebody
   * most wants to see that something is happening.
   */
  asking: boolean;
  /**
   * Open the line, optionally with the first thing the agent should say.
   *
   * The words are a **delivered greeting** and nothing else — see `spokenText`.
   * Everything about the session is otherwise the agent's own configuration;
   * this is the one value this app ever sends into it.
   */
  start: (firstMessage?: string) => Promise<void>;
  stop: () => void;
  toggle: (firstMessage?: string) => void;
};

/**
 * The minimum of the SDK this hook touches, named here so the dynamic import
 * does not drag a type dependency into the bundle.
 */
type LiveSession = {
  endSession: () => Promise<void>;
  getInputVolume: () => number;
  getOutputVolume: () => number;
};

export function useAgentSession({
  active = true,
  conversationId,
  onTurn,
}: {
  active?: boolean;
  /** The thread a spoken question should land in, or null to have one made. */
  conversationId: number | null;
  /** Called after every answered turn, with the thread it landed in. */
  onTurn?: (conversationId: number) => void;
} = { conversationId: null }): AgentSessionController {
  const supported = sessionSupported(typeof window === "undefined" ? undefined : (window as never));

  const [status, setStatus] = useState<SessionStatus>("disconnected");
  const [mode, setMode] = useState<SessionMode | null>(null);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const session = useRef<LiveSession | null>(null);
  const frame = useRef<number | null>(null);
  const level = useRef(0);

  /**
   * Which `start()` is the current one.
   *
   * Opening a session is two awaits deep — a token, then a connection — and a
   * second press, or leaving the tab, can happen in either gap. Without a token
   * the loser resolves last and installs a live microphone that nothing on
   * screen accounts for, which is `useCamera`'s bug with a worse consequence.
   */
  const attempt = useRef(0);

  /**
   * The thread to put the next spoken question in.
   *
   * A ref because the client tool below is handed to the SDK once, at connect,
   * and then called minutes later: a captured value would be whichever thread
   * was open when Talk was pressed, so switching threads mid-session would
   * silently keep answering into the old one.
   */
  const thread = useRef(conversationId);
  thread.current = conversationId;

  const turned = useRef(onTurn);
  turned.current = onTurn;

  /**
   * `asking`, for the visibility listener, which is bound once and would
   * otherwise see the value from whichever render bound it.
   */
  const inLoop = useRef(false);

  const setLevel = (value: number) => {
    level.current = value;
    document?.documentElement?.style?.setProperty(VOICE_LEVEL_PROPERTY, value.toFixed(3));
  };

  /**
   * Release everything, in an order that does not depend on any of it existing.
   *
   * Reached from `stop`, from the SDK's own `onDisconnect` — which fires when
   * the agent ends the call as well as when we do — from leaving the tab, and
   * from unmount. So it has to be safe to run twice, and it is the only place
   * the level property is removed.
   */
  const teardown = useCallback(() => {
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current);
      frame.current = null;
    }

    level.current = 0;
    document?.documentElement?.style?.removeProperty(VOICE_LEVEL_PROPERTY);

    session.current = null;
    inLoop.current = false;
    setStatus("disconnected");
    setMode(null);
    setAsking(false);
  }, []);

  /**
   * Drive the voice ring from whichever end of the call is making noise.
   *
   * The ring has had exactly one writer since 7.3 and this replaces it rather
   * than joining it: one `setProperty` per frame on `<html>`, inherited by all
   * 56 bars, because passing the number through React would re-render the whole
   * sphere sixty times a second inside a bloom filter — the precise cost
   * `HolographicCore` was written to avoid.
   *
   * What is new is that there are two sources now. Listening follows the
   * microphone; **answering follows the speaker**, so the ring moves with the
   * assistant's own voice instead of going flat the moment it starts talking.
   */
  const follow = useCallback((speaking: boolean) => {
    const live = session.current;
    if (!live) return;

    const raw = speaking ? live.getOutputVolume() : live.getInputVolume();
    setLevel(sessionLevel(raw, level.current));

    frame.current = requestAnimationFrame(() => follow(speaking));
  }, []);

  const watchLevel = useCallback(
    (speaking: boolean) => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(() => follow(speaking));
    },
    [follow],
  );

  /**
   * The client tool, and the whole of the agent's reach into this app.
   *
   * It returns a **string**, which the agent reads out. Nothing here throws: a
   * failure has to come back as words, because the alternative is an unhandled
   * tool call and a model improvising an answer about someone's training.
   */
  const ask = useCallback(async (params: unknown): Promise<string> => {
    const question = spokenQuestion(params);
    if (question === null) return NO_QUESTION;

    inLoop.current = true;
    setAsking(true);

    try {
      const answer = await api.voiceTurn(question, thread.current);

      // The thread the server used, which is the one it made if we named none.
      // Reported upward so the transcript on screen becomes the conversation
      // being had out loud, rather than a different one sitting behind it.
      thread.current = answer.conversation_id;
      turned.current?.(answer.conversation_id);

      return answer.text;
    } catch (e) {
      // Read aloud by the agent, so it is a sentence rather than a status. The
      // server writes these deliberately — a parked write, a busy thread, the
      // switch being off — and passing them through is what lets the assistant
      // explain itself instead of apologising vaguely.
      return errorMessage(e);
    } finally {
      inLoop.current = false;
      setAsking(false);
    }
  }, []);

  const stop = useCallback(() => {
    attempt.current += 1;

    const live = session.current;
    session.current = null;

    // Not awaited: the caller is a button, and the disconnect is reported
    // through `onDisconnect` anyway. A rejection here means the line was
    // already gone, which is the state being asked for.
    live?.endSession().catch(() => {});

    teardown();
  }, [teardown]);

  const start = useCallback(async (firstMessage?: string) => {
    if (!supported) return;
    if (session.current) return;

    // Guarded rather than trusted, because the caller is a button: RN-Web hands
    // `onPress` a gesture event, so a handler wired as `onPress={start}` would
    // put an object here. A blank string is dropped too — an override set to ""
    // is the agent's own "say nothing and wait", which is what it does anyway,
    // and sending it would look like a greeting that failed to arrive.
    const opening = typeof firstMessage === "string" ? spokenText(firstMessage) : "";

    const token = ++attempt.current;

    setError(null);
    setStatus("connecting");
    setMode(null);

    try {
      // Permission to open the session. The key that mints this never leaves
      // the server — see `api.voiceToken`.
      const { token: conversationToken } = await api.voiceToken();

      if (token !== attempt.current) return;

      const { Conversation } = await loadConversationSdk();

      if (token !== attempt.current) return;

      const live = (await Conversation.startSession({
        conversationToken,
        connectionType: "webrtc",
        // The only thing this app ever overrides on the agent, and only when it
        // has something to open with. **An override is silently ignored unless
        // the agent allows that field** in its security settings on ElevenLabs'
        // side (`platform_settings.overrides…agent.first_message`, enabled for
        // this agent in 15.5) — no error, no warning, just a call that opens in
        // silence. So a greeting that arrives on screen and is not spoken is
        // that flag, not this code.
        ...(opening === "" ? {} : { overrides: { agent: { firstMessage: opening } } }),
        clientTools: { [ASK_TOOL]: ask },
        onConnect: () => {
          if (token !== attempt.current) return;
          setStatus("connected");
          setMode("listening");
          watchLevel(false);
        },
        onModeChange: ({ mode: next }: { mode: string }) => {
          if (token !== attempt.current) return;
          const speaking = next === "speaking";
          setMode(speaking ? "speaking" : "listening");
          watchLevel(speaking);
        },
        onDisconnect: (details?: Disconnect) => {
          // The agent hanging up, ElevenLabs cutting the call and a network
          // failure all arrive here; `disconnectNote` decides which of them
          // is worth putting on screen.
          const note = disconnectNote(details);
          if (note) setError(note);
          teardown();
        },
        onError: (message: unknown) => {
          setError(typeof message === "string" ? voiceFailure(message) : "The voice session failed.");
        },
      })) as unknown as LiveSession;

      // A stop, or a second press, landed while the line was opening. This
      // session belongs to nobody, so it is closed rather than installed —
      // without this it stays connected with a live microphone and no button
      // anywhere that would end it.
      if (token !== attempt.current) {
        live.endSession().catch(() => {});

        return;
      }

      session.current = live;
    } catch (e) {
      if (token !== attempt.current) return;

      setError(voiceFailure(errorMessage(e)));
      teardown();
    }
  }, [ask, supported, teardown, watchLevel]);

  const toggle = useCallback(
    (firstMessage?: string) => {
      if (session.current || status !== "disconnected") {
        stop();

        return;
      }

      start(firstMessage);
    },
    [start, status, stop],
  );

  /**
   * Leaving this screen ends the call.
   *
   * 7.3's rule, taken as written for the microphone and inherited by the camera
   * in 7.4: *a microphone that reopened itself when you came back is one nobody
   * pressed anything to start.* An open session is a stronger version of the
   * same bargain — it is billed by the minute and it answers out loud — so it
   * ends rather than pausing, and coming back does not reopen it.
   */
  useEffect(() => {
    if (active) return;
    stop();
  }, [active, stop]);

  /**
   * Leaving the tab ends the call too — unless the assistant is what took the
   * tab away.
   *
   * `show_google_calendar` opens Google Calendar in a new tab, and Chrome puts
   * a tab opened from outside it *in front*; there is no way to ask for one
   * behind. So the HUD goes hidden in the middle of the very turn that asked
   * for the calendar, and hanging up there would cut the call off before the
   * answer is spoken. The owner's call: the calendar comes to the front and the call
   * carries on; you click back to the HUD yourself.
   *
   * The exemption is exactly the stretch a spoken question is in our loop,
   * because that tool only ever runs inside `POST /api/voice/turn` — so a hide
   * that lands then is one the assistant caused. A tab *you* switch to at any
   * other moment still ends the call, and so does leaving again after coming
   * back. The cost is that switching tabs yourself during those few seconds
   * is excused as well, since the two cannot be told apart; what bounds a call
   * left running behind the calendar is the agent's own silence timeout, which
   * hangs up once nobody has spoken for a while.
   */
  useEffect(() => {
    if (typeof document === "undefined") return;

    const onVisibility = () => {
      if (document.visibilityState === "hidden" && !inLoop.current) stop();
    };

    document.addEventListener("visibilitychange", onVisibility);

    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [stop]);

  // Nothing may outlive the screen: an open session is a hot microphone with
  // nothing left on screen to explain it.
  useEffect(() => stop, [stop]);

  return {
    supported,
    status,
    mode,
    error,
    note: sessionNote({ supported, status, error }),
    connecting: status === "connecting",
    asking,
    start,
    stop,
    toggle,
  };
}
