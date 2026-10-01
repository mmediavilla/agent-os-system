import { LiveRun, emptyRun } from "../run";
import { orbState } from "../useConversation";

/**
 * Which of the six states the assistant is in.
 *
 * Pure, and worth testing on its own because the *order* of the checks is the
 * whole design and every one of them has a case where it looks harmless to
 * reorder. It is also the one place `responding` is decided, and that state is
 * hard to catch on a screen — a run spends a second or two in it.
 */

function run(items: LiveRun["items"]): LiveRun {
  return { ...emptyRun("running"), items };
}

const idle = { awaiting: false, working: false, live: null, status: null } as const;

it("stands by when there is nothing to do", () => {
  expect(orbState(idle)).toBe("idle");
});

it("works while a run has only called tools", () => {
  expect(
    orbState({
      ...idle,
      working: true,
      live: run([{ kind: "tools", calls: [] }]),
    }),
  ).toBe("working");
});

it("answers once the model is writing rather than calling", () => {
  // The distinction has been in the streamed events since Phase 5 with nowhere
  // to show it: the last thing the run produced being text *is* the model
  // answering.
  expect(
    orbState({
      ...idle,
      working: true,
      live: run([{ kind: "tools", calls: [] }, { kind: "said", text: "Two sessions" }]),
    }),
  ).toBe("responding");
});

it("goes back to working when the answer is interrupted by another tool", () => {
  expect(
    orbState({
      ...idle,
      working: true,
      live: run([{ kind: "said", text: "Let me check" }, { kind: "tools", calls: [] }]),
    }),
  ).toBe("working");
});

it("works with no live run at all, which is the gap before the first event", () => {
  expect(orbState({ ...idle, working: true })).toBe("working");
});

it("holds still for a decision even while the run is technically going", () => {
  // Awaiting wins over working, deliberately: motion beside an approval card
  // says the job is going ahead anyway, which is the opposite of what the card
  // is asking.
  expect(
    orbState({
      awaiting: true,
      working: true,
      live: run([{ kind: "said", text: "I'd like to log this" }]),
      status: null,
    }),
  ).toBe("awaiting");
});

it("reports a failed run once it has stopped", () => {
  expect(orbState({ ...idle, status: "failed" })).toBe("failed");
});

it("does not report the previous failure while the retry is running", () => {
  expect(orbState({ ...idle, working: true, status: "failed" })).toBe("working");
});

it("listens once there is a microphone open, which 7.3 is what made reachable", () => {
  expect(orbState({ ...idle, listening: true })).toBe("listening");
});

it("shows the answer rather than the microphone when both are somehow true", () => {
  // The composer is closed while a run is going, so the only way here is to
  // have started talking as the answer arrived. A flat ring is a smaller loss
  // than a sphere claiming to be idle while a reply is being written.
  expect(orbState({ ...idle, working: true, listening: true })).toBe("working");
  expect(orbState({ ...idle, awaiting: true, listening: true })).toBe("awaiting");
});

it("does not report a stale failure over a live microphone", () => {
  expect(orbState({ ...idle, status: "failed", listening: true })).toBe("listening");
});

// ── The spoken conversation ──────────────────────────────────────────────────

it("speaks when the assistant has the floor", () => {
  // Two states rather than one, because the same ring is driven from the
  // speaker here and from the microphone in `listening` — and a screen that
  // could not tell them apart would be drawing the wrong end of the call.
  expect(orbState({ ...idle, speaking: true })).toBe("speaking");
});

it("sweeps while a spoken question is in the loop", () => {
  // There is no run to watch on this path, so nothing distinguishes tools from
  // prose and `working` is the honest one of the two.
  expect(orbState({ ...idle, asking: true })).toBe("working");
});

it("shows the loop running rather than the filler phrase covering it", () => {
  // These genuinely overlap: the ElevenLabs agent is configured to say "let me
  // check" *and* run the tool at once. Of the two facts, the one worth drawing
  // is that the loop is going — and it is the steadier reading, since the
  // alternative flips speaking → working → speaking inside one answer. The cost
  // is a couple of seconds of a flat ring under the filler.
  expect(orbState({ ...idle, asking: true, speaking: true })).toBe("working");
});

it("keeps a parked write above everything the session reports", () => {
  expect(orbState({ ...idle, awaiting: true, speaking: true })).toBe("awaiting");
  expect(orbState({ ...idle, awaiting: true, asking: true })).toBe("awaiting");
});

// ── Whether it can answer at all ─────────────────────────────────────────────

it("says it is switched off rather than standing by", () => {
  expect(orbState({ ...idle, off: true })).toBe("off");
});

it("fails, at rest, when it is on and cannot answer", () => {
  // No key, no database, no worker, no API: the red, still core is what says
  // so from across the room.
  expect(orbState({ ...idle, unavailable: true })).toBe("failed");
});

it("lets the switch win over what the switch makes unreachable", () => {
  expect(orbState({ ...idle, off: true, unavailable: true })).toBe("off");
  expect(orbState({ ...idle, off: true, status: "failed" })).toBe("off");
});

it("never hides anything actually happening behind either", () => {
  // A parked write can still be decided with the switch off, and a live
  // microphone is proof that talking works whatever the worker is doing.
  expect(orbState({ ...idle, off: true, awaiting: true })).toBe("awaiting");
  expect(orbState({ ...idle, off: true, working: true })).toBe("working");
  expect(orbState({ ...idle, unavailable: true, listening: true })).toBe("listening");
  expect(orbState({ ...idle, unavailable: true, asking: true })).toBe("working");
});

it("prefers the assistant's own voice to the open microphone under it", () => {
  // The caller derives these from one `mode`, so they cannot both be true
  // today. Pinned anyway, because the microphone genuinely stays open while the
  // assistant talks — that is what interrupting it is — and the first thing
  // anyone will do here is report the two separately.
  expect(orbState({ ...idle, listening: true, speaking: true })).toBe("speaking");
});
