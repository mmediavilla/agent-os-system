import React from "react";
import { render } from "@testing-library/react-native";
import AssistantOrb, { OrbState } from "../AssistantOrb";
import { colors } from "../../theme";

/**
 * The orb, as a state display.
 *
 * What is worth asserting is not the animation itself — a rotation cannot be
 * read out of a tree — but the three things the state actually decides: what
 * the orb is called, what colour it is, and *whether it moves at all*. The
 * label is the only part a screen reader ever gets, and the stillness is a
 * deliberate message: an orb turning beside an approval card says the work is
 * still going, which is the wrong thing to say to someone being asked to
 * decide.
 *
 * The ring geometry gets one test of its own, because `dashes()` derives a
 * pattern that a hand-written pair of numbers would get subtly wrong.
 */

type Node = { type: string; props: Record<string, any>; children?: (Node | string)[] };

/** Every SVG shape in the drawing, in document order. */
function shapes(state?: OrbState): Node[] {
  const tree = render(<AssistantOrb state={state} />).toJSON() as unknown as Node;
  const found: Node[] = [];

  (function walk(node: Node | string | null) {
    if (!node || typeof node === "string") return;
    if (node.type === "circle") found.push(node);
    (node.children ?? []).forEach(walk);
  })(tree);

  return found;
}

/** The colours the state chose. The glow is painted from a gradient, not a
 *  token, so it names no colour of its own here. */
function tints(state?: OrbState): string[] {
  return shapes(state)
    .map((c) => c.props.stroke ?? c.props.fill)
    .filter((c: string) => c && !c.startsWith("url("));
}

it("names its state, because that is all a screen reader gets", () => {
  expect(render(<AssistantOrb state="idle" />).getByLabelText("Assistant idle")).toBeTruthy();
  expect(render(<AssistantOrb state="working" />).getByLabelText("Assistant working")).toBeTruthy();
  expect(
    render(<AssistantOrb state="awaiting" />).getByLabelText("Assistant waiting for you"),
  ).toBeTruthy();
  expect(render(<AssistantOrb state="failed" />).getByLabelText("Assistant failed")).toBeTruthy();
});

it("is idle by default", () => {
  expect(render(<AssistantOrb />).getByLabelText("Assistant idle")).toBeTruthy();
});

it("keeps the accent while it is working", () => {
  expect(tints("working").every((c) => c === colors.accent)).toBe(true);
});

it("goes amber when it is waiting on a decision", () => {
  // The same amber as the approval card below it, so the two read as one
  // request rather than two unrelated warnings.
  expect(tints("awaiting").every((c) => c === colors.amber)).toBe(true);
});

it("goes red when the run failed", () => {
  expect(tints("failed").every((c) => c === colors.error)).toBe(true);
});

it("holds completely still in the states that must not suggest activity", () => {
  for (const state of ["awaiting", "failed"] as OrbState[]) {
    const animated = shapes(state).filter((c) => c.props.style?.animation);

    expect(animated).toEqual([]);
  }
});

it("goes amber and keeps drifting when it is switched off", () => {
  const animated = shapes("off")
    .map((c) => c.props.style?.animation as string | undefined)
    .filter(Boolean)
    .map((a) => a!.split(" ")[0]);

  expect(render(<AssistantOrb state="off" />).getByLabelText("Assistant switched off")).toBeTruthy();
  expect(tints("off").every((c) => c === colors.amber)).toBe(true);
  // Idle's motion, not working's: the switch being off is a resting state.
  expect(animated.sort()).toEqual(["hud-breathe", "hud-spin"]);
});

it("turns while it is working, and only breathes while it is not", () => {
  const moving = (state: OrbState) =>
    shapes(state)
      .map((c) => c.props.style?.animation as string | undefined)
      .filter(Boolean)
      .map((a) => a!.split(" ")[0]);

  // Idle: the graticule drifts and the core breathes. Nothing spins.
  expect(moving("idle").sort()).toEqual(["hud-breathe", "hud-spin"]);

  // Working: both directions, so the motion reads as activity rather than as
  // one spinner.
  expect(moving("working")).toContain("hud-spin-reverse");
  expect(moving("working").length).toBeGreaterThan(moving("idle").length);
});

it("spaces its ticks evenly all the way round", () => {
  // The failure this guards is a dash pattern written for one radius and
  // reused at another: the marks stay the right size and the last gap before
  // twelve o'clock comes out short.
  const ticks = shapes("idle").find((c) => c.props.strokeWidth === 4)!;
  const [mark, gap] = String(ticks.props.strokeDasharray).split(" ").map(Number);

  expect((mark + gap) * 36).toBeCloseTo(2 * Math.PI * ticks.props.r, 1);
});

it("gives each orb its own gradient, because two share a document", () => {
  // `fill="url(#id)"` resolves against the first matching id in the page, so a
  // fixed one would hand the big orb the small one's colour — visible only when
  // the two disagree, which is exactly when the state matters.
  const idOf = (state: OrbState) =>
    shapes(state).find((c) => String(c.props.fill).startsWith("url("))!.props.fill;

  expect(idOf("idle")).not.toBe(idOf("failed"));
});

