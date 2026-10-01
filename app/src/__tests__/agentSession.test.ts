import {
  CREDITS_NOTE,
  NO_QUESTION,
  SESSION_FLOOR,
  disconnectNote,
  sessionLevel,
  sessionNote,
  sessionSupported,
  spokenQuestion,
  spokenText,
  talkLabel,
  voiceFailure,
} from "../agentSession";

/**
 * The rules of a spoken session, away from the WebRTC connection that carries
 * one.
 *
 * Same split, and same argument, as `voice.test.ts`: everything asserted here
 * is a decision, and every one of them would otherwise only be reachable
 * through a live microphone, a live account and somebody talking into it.
 */

describe("the question out of a client-tool call", () => {
  it("takes the question the agent asked", () => {
    expect(spokenQuestion({ question: "How many sets last week?" })).toBe(
      "How many sets last week?",
    );
  });

  it("trims it, because a transcription arrives padded", () => {
    expect(spokenQuestion({ question: "  how was last week?  " })).toBe("how was last week?");
  });

  /**
   * The parameters are chosen by *their* router model, not ours, which is the
   * whole reason this function is defensive. Each of these is a bad turn rather
   * than an impossibility, and every one of them would otherwise put an empty
   * message through the tool loop and pay Anthropic to be asked nothing.
   */
  it.each([
    ["no parameters at all", undefined],
    ["null", null],
    ["a string instead of an object", "how was last week?"],
    ["the parameter under another name", { text: "how was last week?" }],
    ["a number", { question: 4 }],
    ["an empty string", { question: "" }],
    ["nothing but whitespace", { question: "   " }],
  ])("refuses %s", (_label, params) => {
    expect(spokenQuestion(params)).toBeNull();
  });

  it("has a sentence to say instead, because the agent reads what it is given", () => {
    // Not an empty string and not a thrown error: an unanswered client tool
    // leaves the model to improvise an answer about someone's training.
    expect(NO_QUESTION).toMatch(/did not catch/i);
  });
});

describe("whether this browser can hold a session", () => {
  const ok = {
    RTCPeerConnection: function () {},
    navigator: { mediaDevices: { getUserMedia: () => {} } },
  };

  it("needs WebRTC and a microphone together", () => {
    expect(sessionSupported(ok)).toBe(true);
  });

  it("refuses a browser with no WebRTC", () => {
    expect(sessionSupported({ navigator: ok.navigator })).toBe(false);
  });

  it("refuses a browser with no microphone", () => {
    expect(sessionSupported({ RTCPeerConnection: ok.RTCPeerConnection })).toBe(false);
    expect(
      sessionSupported({ RTCPeerConnection: ok.RTCPeerConnection, navigator: {} }),
    ).toBe(false);
  });

  it("survives having no window at all", () => {
    expect(sessionSupported(undefined)).toBe(false);
  });
});

describe("the level the voice ring scales by", () => {
  /**
   * The half of this that matters most. A ring that shimmers in a silent room
   * is the CSS clock 7.3 replaced, quieter — it looks exactly as alive when
   * nothing is being said as when something is.
   */
  it("collapses to a hard zero below the floor", () => {
    expect(sessionLevel(SESSION_FLOOR - 0.001, 0)).toBe(0);
  });

  it("rises faster than it falls, because a voice is mostly gaps", () => {
    const up = sessionLevel(0.35, 0);
    const down = sessionLevel(0, 1);

    expect(up).toBeGreaterThan(1 - down);
  });

  it("stays inside the range whatever the input", () => {
    // The SDK clamps its own volume to 0-1, so anything outside that is a
    // change at their end rather than a loud room — and a transform of NaN
    // silently removes all 56 bars.
    for (const volume of [-1, 0, 0.5, 1, 40, NaN, Infinity]) {
      const next = sessionLevel(volume, 0.5);
      expect(Number.isFinite(next)).toBe(true);
      expect(next).toBeGreaterThanOrEqual(0);
      expect(next).toBeLessThanOrEqual(1);
    }
  });

  it("climbs toward the top of the scale as the room gets louder", () => {
    let quiet = 0;
    let loud = 0;

    for (let i = 0; i < 20; i++) {
      quiet = sessionLevel(0.08, quiet);
      loud = sessionLevel(0.35, loud);
    }

    expect(quiet).toBeLessThan(loud);
    expect(loud).toBeGreaterThan(0.9);
  });
});

describe("the microphone button's name", () => {
  it("offers to talk when there is no line open", () => {
    expect(talkLabel("disconnected")).toBe("Talk to the assistant");
  });

  /**
   * End while *connecting* as well, which is the same rule the microphone
   * button has always had: the only way out of a permission prompt you have
   * decided against must not be to answer it.
   */
  it("offers to end it from the press onward", () => {
    expect(talkLabel("connecting")).toBe("End the spoken conversation");
    expect(talkLabel("connected")).toBe("End the spoken conversation");
  });
});

describe("what the voice says under the core", () => {
  const base = { supported: true, status: "disconnected" as const, error: null };

  it("puts a failure above everything else, because it is the only one asking for something", () => {
    expect(sessionNote({ ...base, status: "connected", error: "No microphone found." })).toBe(
      "No microphone found.",
    );
  });

  it("says so where the browser cannot do this at all", () => {
    // Otherwise the idle caption points at a microphone button that is not
    // drawn.
    expect(sessionNote({ ...base, supported: false })).toMatch(/WebRTC/);
  });

  it("does not claim to be listening while the line is still opening", () => {
    // The same lie the ring's CSS clock told, one layer up: nothing is being
    // heard until the session says it is.
    const note = sessionNote({ ...base, status: "connecting" });

    expect(note).toBe("Opening the line…");
    expect(note).not.toMatch(/listening/i);
  });

  it("leaves the core's own caption alone the rest of the time", () => {
    // Idle, listening and speaking are all states the orb already has words
    // for — including where the audio goes, which is the core's to say.
    expect(sessionNote(base)).toBeNull();
    expect(sessionNote({ ...base, status: "connected" })).toBeNull();
  });
});

/**
 * Why a call closed. Found live: ElevenLabs ran out of credits halfway through
 * an answer, the SDK reported it as the agent hanging up, and the HUD dropped
 * the reason — the call just stopped, with nothing on screen to say why.
 */
describe("why the line closed", () => {
  it("says a call cut for want of credits was cut, and that typing still works", () => {
    // Exactly what the 16:27 session was closed with.
    expect(
      disconnectNote({ reason: "agent", closeCode: 1002, closeReason: "This request exceeds your quota limit." }),
    ).toBe(CREDITS_NOTE);
    expect(CREDITS_NOTE).toMatch(/out of credits/);
    expect(CREDITS_NOTE).toMatch(/⌘K/);
  });

  it("says the same when a call cannot start for the same reason", () => {
    expect(
      voiceFailure("[quota_exceeded] You've run out of credits. Add credits or upgrade your plan to start a new conversation."),
    ).toBe(CREDITS_NOTE);
    expect(voiceFailure("No microphone found.")).toBe("No microphone found.");
  });

  it("stays quiet for an ordinary goodbye", () => {
    // The silence timeout and the duration cap are the agent hanging up on
    // purpose, and an error under the core after each would teach people to
    // stop reading it.
    expect(disconnectNote({ reason: "agent" })).toBeNull();
    expect(disconnectNote({ reason: "agent", closeCode: 1000, closeReason: "Conversation ended" })).toBeNull();
    expect(disconnectNote({ reason: "user" })).toBeNull();
    expect(disconnectNote(undefined)).toBeNull();
  });

  it("passes any other abnormal close on in its own words", () => {
    expect(disconnectNote({ reason: "agent", closeCode: 1011, closeReason: "Internal error" })).toBe(
      "The call was cut: Internal error",
    );
  });

  it("still reports a failure the SDK calls an error", () => {
    expect(disconnectNote({ reason: "error", message: "Connection lost" })).toBe("Connection lost");
  });
});

/**
 * What the agent is handed to open a call with.
 *
 * The one place this app puts words into the agent's mouth, and the one place
 * markdown written for a screen would be read out as punctuation.
 */
describe("a greeting, out loud", () => {
  it("takes off the markers and leaves the words", () => {
    expect(spokenText("**Good morning, sir.** You trained `4` times last week.")).toBe(
      "Good morning, sir. You trained 4 times last week.",
    );
  });

  it("reads a list as its items, not as its bullets", () => {
    // Prose that came back as a list is still prose to a voice; "dash dentist
    // at three" is the failure, and it is only ever heard.
    expect(spokenText("Two things today:\n- Dentist at 15:00\n- Legs\n* And rain later\n1. Then bed")).toBe(
      "Two things today:\nDentist at 15:00\nLegs\nAnd rain later\nThen bed",
    );
  });

  it("drops heading hashes and trims the run of blank lines", () => {
    expect(spokenText("## Today\n\n\n\nRain at four.\n")).toBe("Today\n\nRain at four.");
  });

  it("changes nothing else", () => {
    // Not shortened, not summarised, not cut at a sentence: the same words are
    // sitting in the thread, and a spoken version that quietly stopped halfway
    // would disagree with what is on file.
    const long = "One. ".repeat(400).trim();
    expect(spokenText(long)).toBe(long);

    // An asterisk that is not a marker is a word, and hyphens inside a line are
    // not bullets.
    expect(spokenText("3 * 4 sets, push-ups and sit-ups")).toBe("3 * 4 sets, push-ups and sit-ups");
  });

  it("is empty when there is nothing to say", () => {
    expect(spokenText("   \n\n  ")).toBe("");
  });
});
