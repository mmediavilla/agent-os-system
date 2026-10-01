import React, { useId } from "react";
import { StyleSheet, View } from "react-native";
import { colors } from "../theme";

/**
 * The assistant, as a state.
 *
 * It landed in Phase 5 because that is when there was finally something to
 * display — a blocking request is either in flight or it is not, and an orb
 * built against a spinner is decoration, whereas a queued run has real
 * material: queued, working, parked on a decision, failed.
 *
 * Four states, and the difference between two of them is the point:
 *
 * - **idle** breathes, slowly. It says the thing is on, and nothing more.
 * - **working** turns. Two rings, opposite directions, different periods, so
 *   the motion reads as activity rather than as a loading spinner.
 * - **awaiting** goes amber and **holds completely still**. There is an
 *   approval card below it, and anything moving beside that card says work is
 *   still going on — which is exactly the wrong thing to say to someone being
 *   asked to decide.
 * - **failed** goes red, and is equally still.
 *
 * ── Why this is SVG now ─────────────────────────────────────────────────────
 *
 * The first version was built from `View`s with border radii and a transparent
 * top border, driven by `Animated`, and said so in its own docstring: SVG would
 * have made it web-only, and that trade is fine for a picture but not for the
 * thing that tells you whether the assistant is doing anything.
 *
 * Phase 7.0 deleted the native target, so the trade is gone, and two things
 * that were out of reach are now the whole design. A **tick ring** —
 * `stroke-dasharray` on a circle — is one attribute here and forty
 * absolutely-positioned views otherwise; it is what makes the thing read as an
 * instrument rather than as a progress spinner. And the rotation moves to
 * **CSS keyframes** (declared in `theme.ts` beside the palette), so a turning
 * ring costs the compositor a transform instead of costing React a
 * `setState` per frame through the JS thread — which is also why the act()
 * warnings the old orb generated in every test that mounted a screen are gone.
 *
 * The reduced-motion opt-out rides along with the keyframes: the states are
 * named in the accessibility label as well as danced, so there is nothing lost
 * by holding still.
 *
 * One thing here was measured rather than assumed, because the received wisdom
 * is that it does not work: `stroke={colors.accent}` puts a `var(--c-accent)`
 * into an SVG **presentation attribute**, not a CSS declaration. Chromium
 * resolves it — checked in the browser, both spellings give the same computed
 * stroke — which is what lets the tints come from the same tokens as
 * everything else and re-theme inside `data-hud` for free. If a target ever
 * appears that does not, the fix is to move each `stroke` into `style`.
 */

/**
 * What the assistant is doing, as far as the screen is concerned.
 *
 * Four of these come out of the run machinery today. `listening` waits on the
 * microphone in 7.3; `responding` is the stretch of a run where the model is
 * writing its answer rather than calling tools, which the streamed run events
 * already distinguish and 7.2 will start reporting. Both are reachable for real
 * now; the HUD's preview row, which showed them before that, went in Phase 11.
 *
 * **`speaking` arrives with the spoken conversation in 9.1**, and it is the
 * only one of these that is about sound coming *out*. `listening` and
 * `responding` between them nearly cover it and neither is right: the first
 * says the room is being heard while the assistant is talking over it, and the
 * second is a model composing prose, which by then has already happened. It
 * matters because the voice ring is driven from the speaker in this state and
 * from the microphone in the other, so a screen that could not tell them apart
 * would draw the wrong end of the call.
 *
 * **`off` is the Anthropic switch**, and it borrows `awaiting`'s amber without
 * its stillness: amber because the switch is something true you should know
 * (the `AI OFF` chip's colour), moving because a decision is not a fault and
 * there is no approval card beside it for motion to contradict.
 */
export type OrbState =
  | "idle"
  | "listening"
  | "speaking"
  | "working"
  | "responding"
  | "awaiting"
  | "failed"
  | "off";

const LABELS: Record<OrbState, string> = {
  idle: "Assistant idle",
  listening: "Assistant listening",
  speaking: "Assistant speaking",
  working: "Assistant working",
  responding: "Assistant answering",
  awaiting: "Assistant waiting for you",
  failed: "Assistant failed",
  off: "Assistant switched off",
};

/** How long one full turn of each ring takes. Coprime-ish, so they rarely align. */
const OUTER_MS = 3400;
const TICKS_MS = 8600;
const INNER_MS = 2300;
const BREATH_MS = 2600;

/** Everything is drawn in this square and scaled by the viewBox. */
const VB = 100;
const C = VB / 2;

const R_OUTER = 46;
const R_TICKS = 38;
const R_INNER = 28;
const R_CORE = 11;

/**
 * A dash pattern that puts `count` marks of length `mark` evenly around a
 * circle of radius `r`. Derived rather than written out: a hand-tuned pair of
 * numbers is right for exactly one radius, and silently wrong — a half-width
 * gap at twelve o'clock — for every other.
 */
function dashes(r: number, count: number, mark: number): string {
  const step = (2 * Math.PI * r) / count;

  return `${mark} ${(step - mark).toFixed(3)}`;
}

/** An arc covering `fraction` of the circle, with the rest left open. */
function arc(r: number, fraction: number): string {
  const circumference = 2 * Math.PI * r;

  return `${(circumference * fraction).toFixed(3)} ${(circumference * (1 - fraction)).toFixed(3)}`;
}

function spin(ms: number, reverse = false): React.CSSProperties {
  return {
    animation: `${reverse ? "hud-spin-reverse" : "hud-spin"} ${ms}ms linear infinite`,
    transformOrigin: "50% 50%",
  };
}

export default function AssistantOrb({
  state = "idle",
  size = 34,
  decorative = false,
}: {
  state?: OrbState;
  size?: number;
  /**
   * Draw it, but do not announce it. For the second orb on a screen that has
   * two — the HUD puts a small one in the top bar beside the wordmark and a
   * large one on the stage, both showing the same run — where naming both
   * means a screen reader reads the assistant's state twice and finds two
   * images with identical labels.
   */
  decorative?: boolean;
}) {
  // Every state that is *doing* something turns at the quick rate. The chip is
  // 28px; a third and fourth speed there is a distinction nobody can see.
  const working = state === "working" || state === "responding" || state === "listening";
  const still = state === "awaiting" || state === "failed";

  // Two orbs share a document — the HUD has one in the bar and one on the
  // stage — and `fill="url(#id)"` resolves against the *first* matching id in
  // the page. A fixed id would give the stage orb the bar orb's gradient, which
  // shows only when the two disagree: the big one would stay cyan while it
  // claimed to be waiting.
  //
  // Everything but letters and digits is stripped out of React's id rather
  // than any one punctuation mark, because the punctuation is React's to
  // choose — 18 used colons, 19 uses guillemets — and `url(#…)` is a poor
  // place to discover the next change.
  const glowId = `orb-glow-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;

  const tint =
    state === "failed"
      ? colors.error
      : state === "awaiting" || state === "off"
        ? colors.amber
        : colors.accent;

  // Still states hold their rings *and* their core. A parked run that keeps
  // pulsing looks like a run that is still going.
  const breathe: React.CSSProperties = still
    ? {}
    : { animation: `hud-breathe ${working ? BREATH_MS / 2 : BREATH_MS}ms ease-in-out infinite` };

  return (
    <View
      accessibilityRole={decorative ? "none" : "image"}
      accessibilityLabel={decorative ? undefined : LABELS[state]}
      accessibilityElementsHidden={decorative}
      importantForAccessibility={decorative ? "no-hide-descendants" : undefined}
      testID="assistant-orb"
      style={[s.root, { width: size, height: size }]}
    >
      {/* The whole drawing is decorative; the View above it carries the name. */}
      <svg
        viewBox={`0 0 ${VB} ${VB}`}
        width={size}
        height={size}
        aria-hidden="true"
        focusable="false"
      >
        {/* The glow. A gradient rather than a flat disc: at 34px the two are
            indistinguishable, and at the 560px the HUD gives it a flat circle
            reads as a solid ball with a hard edge rather than as light coming
            off the core. Tinted from the state, so it goes amber and red with
            everything else. */}
        <defs>
          <radialGradient id={glowId}>
            <stop offset="0%" stopColor={tint} stopOpacity={still ? 0.3 : 0.45} />
            <stop offset="55%" stopColor={tint} stopOpacity={0.12} />
            <stop offset="100%" stopColor={tint} stopOpacity={0} />
          </radialGradient>
        </defs>
        <circle cx={C} cy={C} r={R_TICKS} fill={`url(#${glowId})`} />

        {/* Outer: one long arc with a gap. A uniform circle turning is
            invisible — the gap is what makes the rotation legible. */}
        <circle
          cx={C}
          cy={C}
          r={R_OUTER}
          fill="none"
          stroke={tint}
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeDasharray={arc(R_OUTER, 0.72)}
          opacity={still ? 0.55 : 0.4}
          style={working ? spin(OUTER_MS) : undefined}
        />

        {/* The tick ring. Turns slowly even at idle — a graticule that is
            perfectly still reads as a printed frame rather than an instrument
            — and stops dead in the two states that must not suggest activity. */}
        <circle
          cx={C}
          cy={C}
          r={R_TICKS}
          fill="none"
          stroke={tint}
          strokeWidth={4}
          strokeDasharray={dashes(R_TICKS, 36, 1.2)}
          opacity={still ? 0.3 : 0.45}
          style={still ? undefined : spin(working ? TICKS_MS / 2 : TICKS_MS)}
        />

        {/* Inner: two arcs, counter-turning against the outer one. */}
        <circle
          cx={C}
          cy={C}
          r={R_INNER}
          fill="none"
          stroke={tint}
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeDasharray={arc(R_INNER, 0.3)}
          opacity={still ? 0.7 : 0.6}
          style={working ? spin(INNER_MS, true) : undefined}
        />

        <circle cx={C} cy={C} r={R_CORE} fill={tint} style={breathe} />
      </svg>
    </View>
  );
}

const s = StyleSheet.create({
  root: { alignItems: "center", justifyContent: "center" },
});
