/**
 * The rules of a spoken session, with none of the wiring.
 *
 * `useAgentSession` holds the handles — a WebRTC connection, a microphone, an
 * animation frame — and this file holds every decision that can be made without
 * one, which is the split `camera.ts` and `useCamera.ts` use and for the same
 * reason: a rule with a test on it is worth more than a rule buried in an
 * effect.
 *
 * **What is actually happening here is worth stating once.** ElevenLabs runs
 * the agent — it hears the room, decides when a turn has ended, and speaks. It
 * holds no knowledge: its prompt says that anything about the user, their
 * training, their calendar or this machine goes to a **client tool**, which
 * runs in this page and posts to `POST /api/voice/turn`. So the brain is still
 * Laravel's tool loop, the transcript is still `conversation_messages`, and the
 * only thing that changed is that the question arrived as a sound.
 *
 * That is also why the tool runs *here* rather than as a webhook on their side:
 * a webhook needs a publicly reachable endpoint, and `projectmc.test` is
 * Herd-only DNS. A client tool reaches the API exactly the way the HUD does, so
 * nothing is exposed and no tunnel exists. The cost is stated rather than
 * hidden — voice works only with the app open in a browser on this machine.
 */
import { inlineSpans } from "./chat";

/**
 * The one tool the ElevenLabs agent is given, and the whole of its reach into
 * this app.
 *
 * It has to match the tool's name in the dashboard exactly. The SDK dispatches
 * on the string, and a mismatch is silent in the worst way: the agent calls
 * something, nothing answers, and it apologises in a perfectly natural voice.
 */
export const ASK_TOOL = "ask_life_os";

/** How the connection to ElevenLabs stands. */
export type SessionStatus = "disconnected" | "connecting" | "connected";

/** Who is talking, while connected. */
export type SessionMode = "listening" | "speaking";

/**
 * The question out of a client-tool call, or null if there was not one.
 *
 * The argument is chosen by *their* model rather than ours, which is the reason
 * this is defensive at all: a router LLM having a bad turn can call the tool
 * with an empty string, with the parameter under another name, or with no
 * parameters at all. Returning null lets the handler answer with a sentence the
 * agent can read out instead of putting an empty message through the loop and
 * paying Anthropic to be asked nothing.
 */
export function spokenQuestion(params: unknown): string | null {
  if (typeof params !== "object" || params === null) return null;

  const question = (params as Record<string, unknown>).question;
  if (typeof question !== "string") return null;

  const trimmed = question.trim();

  return trimmed === "" ? null : trimmed;
}

/** What the agent is told when its tool call carried no question. */
export const NO_QUESTION =
  "I did not catch a question there. Ask the user to say it again.";

/**
 * A written answer, turned into something worth hearing.
 *
 * The one thing a session is ever *given* words for is the spoken greeting: a
 * scheduled conversation has already been written into the transcript by the
 * time anyone sits down, and the override below makes the agent open the call by
 * reading it out. Those words were written to be *read* — the loop marks emphasis
 * with `**` and code with backticks, and prose that came back as a list carries
 * its bullets — and a text-to-speech engine says all of it. "Double star you
 * trained four times double star" is the failure, and it is silent in the only
 * place it matters, which is out loud.
 *
 * So the markers come off and nothing else does. `inlineSpans` is what the
 * transcript already parses emphasis with, so there is one answer to "what is a
 * marker here" rather than two that can drift.
 *
 * **The words themselves are never edited** — not shortened, not summarised, not
 * cut at a sentence. What is spoken has to be what is on file, because the same
 * text is sitting in the thread the user can open, and a spoken version that
 * quietly stopped halfway would disagree with it. A greeting that is too long to
 * hear is a greeting whose automation asked for too much, and that is a knob in
 * the Automations overlay, not a trim here.
 */
export function spokenText(text: string): string {
  const plain = text
    .split("\n")
    .map((line) =>
      inlineSpans(line.replace(LIST_MARKER, "").replace(HEADING, ""))
        .map((span) => span.text)
        .join(""),
    )
    .join("\n");

  // Three or more blank lines carry nothing a voice can say, and the engine
  // reads the gap as a pause it has no reason to take.
  return plain.replace(/\n{3,}/g, "\n\n").trim();
}

/** `- `, `* `, `1. ` at the head of a line: structure for the eye, noise for a voice. */
const LIST_MARKER = /^\s*(?:[-*+]|\d+\.)\s+/;
const HEADING = /^\s*#{1,6}\s+/;

type SessionWindow = {
  RTCPeerConnection?: unknown;
  navigator?: { mediaDevices?: { getUserMedia?: unknown } };
};

/**
 * Whether this browser can hold a session at all.
 *
 * Two capabilities, and both are load-bearing rather than a formality: the
 * session is carried over **WebRTC**, and it needs a **microphone**. They are
 * checked together because failing either produces the same button — absent,
 * with a line saying why — and checking only one would let the other fail as a
 * console error under a control that looked perfectly fine.
 */
export function sessionSupported(win: SessionWindow | undefined): boolean {
  if (!win) return false;

  return (
    typeof win.RTCPeerConnection === "function" &&
    typeof win.navigator?.mediaDevices?.getUserMedia === "function"
  );
}

/**
 * Below this the room is quiet and the ring has to be flat.
 *
 * These are **not** the floor and full scale 7.3's analyser used, and swapping
 * those back in would pin the ring open on the first syllable. That followed an
 * RMS amplitude off an `AnalyserNode`; this follows what the ElevenLabs client
 * calls a volume, which is the *mean magnitude of the 100-8000Hz bins* already
 * normalised to 0-1 — a different quantity that happens to share a range.
 *
 * The pair is a **first calibration**: reasoned from how that average behaves
 * rather than measured against a live session, because measuring it needed an
 * account that could open one. If the ring pins wide open or barely moves, this
 * is the pair to change.
 */
export const SESSION_FLOOR = 0.03;
const SESSION_FULL = 0.35;

/**
 * Rise fast, fall slow. A voice is mostly gaps — between words, inside stops —
 * and a symmetric follower flickers the ring off and on through every
 * syllable. Rising in ~3 frames and falling over ~15 tracks the envelope of
 * speech rather than its waveform.
 */
const ATTACK = 0.55;
const RELEASE = 0.12;

/**
 * The next value of the ring's level, from this frame's volume and the last.
 *
 * Three shaping decisions, each of which is visible if it is missing:
 *
 * - **A hard zero under the floor**, not a small number. The whole point of
 *   driving these bars off real audio is that a silent room collapses them; a
 *   floor that leaks 0.04 is 7.1's CSS clock again, quieter.
 * - **Attack faster than release** — see above.
 * - **A square root**, because loudness is perceived logarithmically and a
 *   linear map spends most of its range on shouting: normal speech would move
 *   the bars a fifth of the way and no further.
 */
export function sessionLevel(volume: number, previous: number): number {
  const clamped = Number.isFinite(volume) ? Math.max(0, volume) : 0;
  const target =
    clamped < SESSION_FLOOR ? 0 : Math.min(1, Math.sqrt(clamped / SESSION_FULL));
  const rate = target > previous ? ATTACK : RELEASE;

  return previous + (target - previous) * rate;
}

/**
 * What the microphone button is called.
 *
 * It is an icon and nothing else, so this is the only name it has — the one a
 * screen reader announces, and the one the tests find it by.
 *
 * "End" while connecting as well as while connected, for the reason the
 * microphone button always had it: the only way out of a permission prompt you
 * have decided against must not be to answer it. The icon follows the same
 * rule, turning into a stop square on the press rather than on the connect.
 */
export function talkLabel(status: SessionStatus): string {
  return status === "disconnected" ? "Talk to the assistant" : "End the spoken conversation";
}

/** What `onDisconnect` is handed — the SDK's three shapes, flattened. */
export type Disconnect = {
  reason?: string;
  message?: string;
  closeCode?: number;
  closeReason?: string;
};

/** ElevenLabs' words for an account with no minutes left, at start and mid-call. */
const OUT_OF_CREDITS = /quota|out of credits/i;

export const CREDITS_NOTE =
  "ElevenLabs is out of credits, so the call was cut. Top up or wait for the plan to reset — ⌘K to type meanwhile.";

/**
 * A voice failure in words someone can act on.
 *
 * One translation, applied wherever the SDK hands us a reason: the credits
 * case arrives as "[quota_exceeded] You've run out of credits…" when a call
 * cannot start and as "This request exceeds your quota limit." when one is cut
 * halfway, and neither says that typing still works.
 */
export function voiceFailure(message: string): string {
  return OUT_OF_CREDITS.test(message) ? CREDITS_NOTE : message;
}

/**
 * Why the line closed, or null when closing it was the point.
 *
 * **ElevenLabs cutting a call arrives as `reason: "agent"`**, the same as the
 * agent hanging up on purpose — the silence timeout, the duration cap. So
 * "agent" alone says nothing, and treating every one as a failure would put an
 * error under the core after every ordinary goodbye. What separates them is the
 * close: a normal one is code 1000 or none at all, and a cut carries its reason.
 * Before this the reason was dropped, and a call that ran out of credits halfway
 * through an answer simply went quiet — "listening stops prematurely", with
 * nothing on screen to say why.
 */
export function disconnectNote(details: Disconnect | undefined): string | null {
  if (!details) return null;

  if (details.reason === "error") {
    return voiceFailure(details.message || details.closeReason || "The voice session failed.");
  }

  if (details.reason !== "agent") return null;

  const reason = details.closeReason?.trim() ?? "";

  if (OUT_OF_CREDITS.test(reason)) return CREDITS_NOTE;

  const abnormal = details.closeCode !== undefined && details.closeCode !== 1000;

  return abnormal && reason !== "" ? `The call was cut: ${reason}` : null;
}

/**
 * What the voice has to say under the core that the core's own state cannot.
 *
 * The line under the sphere normally follows the orb — listening, speaking,
 * working — and the orb already knows about the call. Three things it has no
 * state for: a line that is still **opening** (the orb must not claim to hear
 * anything yet), a **failure** (the session is torn down and the orb is back to
 * idle, so without this the reason would vanish with it), and a browser that
 * **cannot** hold a session at all, where the idle sentence would be pointing
 * at a microphone button that is not there.
 *
 * Null means "let the orb speak". It is read only while the core is idle: once
 * a run is going, what the run is doing is the more useful sentence.
 *
 * This was the line under the composer until the Talk button left it for the
 * HUD. The sentence about where the audio goes did not go with it — it is the
 * core's idle and listening captions now, which are read by exactly the person
 * about to press the microphone.
 */
export function sessionNote({
  supported,
  status,
  error,
}: {
  supported: boolean;
  status: SessionStatus;
  error: string | null;
}): string | null {
  if (error) return error;

  if (!supported) return "Talking needs a browser with WebRTC and a microphone. ⌘K to type.";

  if (status === "connecting") return "Opening the line…";

  return null;
}
