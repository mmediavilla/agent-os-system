import { RunEvent } from "../api";
import { LiveItem, applyRunEvents, emptyRun, isRunning } from "../run";

/**
 * Folding a run's events into something drawable.
 *
 * Pure, so all of it is array literals — which is the point of having the
 * reducer separate from the watcher that feeds it. What is worth checking is
 * **ordering and contiguity**, because those are what make the live preview
 * look like the transcript that replaces it, and a preview that reorders itself
 * at the moment of the swap is worse than no preview at all.
 */

let seq = 0;

function ev(type: string, data: Record<string, unknown> = {}): RunEvent {
  return { seq: ++seq, type, data };
}

function fold(...events: RunEvent[]) {
  return applyRunEvents(emptyRun(), events);
}

beforeEach(() => {
  seq = 0;
});

const said = (item: LiveItem) => (item.kind === "said" ? item.text : null);

it("collects text into one running paragraph", () => {
  const run = fold(
    ev("run.started"),
    ev("text", { delta: "You trained " }),
    ev("text", { delta: "four times." }),
  );

  expect(run.items).toEqual([{ kind: "said", text: "You trained four times." }]);
  expect(run.status).toBe("running");
});

it("keeps prose, tools and prose in the order they happened", () => {
  const run = fold(
    ev("run.started"),
    ev("text", { delta: "Let me check." }),
    ev("tool.started", { tool_use_id: "t1", tool: "list_workouts", input: { limit: 5 } }),
    ev("tool.finished", { tool_use_id: "t1", is_error: false }),
    ev("text", { delta: "Four sessions." }),
  );

  // Three items, not "all the text then all the tools" — collapsing it would
  // put the model's summary above the work it is summarising.
  expect(run.items.map((i) => i.kind)).toEqual(["said", "tools", "said"]);
  expect(said(run.items[0])).toBe("Let me check.");
  expect(said(run.items[2])).toBe("Four sessions.");
});

it("puts two calls from one turn in a single row of chips", () => {
  const run = fold(
    ev("tool.started", { tool_use_id: "t1", tool: "list_workouts" }),
    ev("tool.started", { tool_use_id: "t2", tool: "get_fitness_stats" }),
  );

  expect(run.items).toHaveLength(1);
  expect(run.items[0].kind === "tools" && run.items[0].calls).toHaveLength(2);
});

it("marks a read as running and a proposed write as waiting", () => {
  const run = fold(
    ev("tool.started", { tool_use_id: "t1", tool: "list_workouts" }),
    ev("tool.started", { tool_use_id: "t2", tool: "log_workout", requires_confirmation: true }),
  );

  const calls = run.items[0].kind === "tools" ? run.items[0].calls : [];

  // A write is not in flight, it is about to be asked about — and showing it as
  // running beside its own approval card says the opposite.
  expect(calls.map((c) => c.state)).toEqual(["running", "waiting"]);
});

it("settles a call by its own id and leaves the others alone", () => {
  const run = fold(
    ev("tool.started", { tool_use_id: "t1", tool: "list_workouts" }),
    ev("tool.started", { tool_use_id: "t2", tool: "get_fitness_stats" }),
    ev("tool.finished", { tool_use_id: "t2", is_error: true }),
  );

  const calls = run.items[0].kind === "tools" ? run.items[0].calls : [];

  expect(calls.map((c) => c.state)).toEqual(["running", "failed"]);
});

it("drops the reasoning as soon as the answer starts", () => {
  const run = fold(
    ev("thinking", { delta: "Checking the last four weeks." }),
    ev("text", { delta: "Four." }),
  );

  // A summary of how an answer was reached, left above the answer, is noise.
  expect(run.thinking).toBe("");
});

it("keeps the reasoning while it is the only thing happening", () => {
  const run = fold(ev("thinking", { delta: "Checking " }), ev("thinking", { delta: "the numbers." }));

  expect(run.thinking).toBe("Checking the numbers.");
  expect(run.items).toEqual([]);
});

it("takes its final status and error from the closing event", () => {
  const run = fold(
    ev("text", { delta: "Half an answer." }),
    ev("run.finished", { status: "failed", error: "Claude call failed: overloaded" }),
  );

  expect(run.status).toBe("failed");
  expect(run.error).toBe("Claude call failed: overloaded");
  expect(isRunning(run.status)).toBe(false);
});

it("stops looking busy once a write is parked", () => {
  const run = fold(
    ev("tool.started", { tool_use_id: "t1", tool: "log_workout", requires_confirmation: true }),
    ev("awaiting", { action_ids: [7] }),
  );

  expect(run.status).toBe("awaiting_confirmation");
});

it("clears anything a previous run left behind", () => {
  const first = fold(ev("text", { delta: "Old." }), ev("run.finished", { status: "completed" }));
  const second = applyRunEvents(first, [ev("run.started")]);

  // Whatever was here belongs to a run that has finished, and is now in the
  // transcript proper.
  expect(second.items).toEqual([]);
  expect(second.status).toBe("running");
});

it("ignores an event it has already folded in", () => {
  const once = fold(ev("run.started"), ev("text", { delta: "Four." }));
  const twice = applyRunEvents(once, [{ seq: 2, type: "text", data: { delta: "Four." } }]);

  // A reconnecting stream can replay the last event it sent; printing it twice
  // is worse than missing it.
  expect(twice).toBe(once);
  expect(said(twice.items[0])).toBe("Four.");
});

it("consumes the sequence of an event it does not understand", () => {
  const run = fold(ev("something.new"), ev("text", { delta: "Fine." }));

  // The seq still advances, so a resume does not ask for the unknown event
  // again and stall behind it.
  expect(run.seq).toBe(2);
  expect(said(run.items[0])).toBe("Fine.");
});

it("treats a queued run as still going", () => {
  expect(isRunning("queued")).toBe(true);
  expect(isRunning("running")).toBe(true);
  expect(isRunning("awaiting_confirmation")).toBe(false);
  expect(isRunning("completed")).toBe(false);
});
