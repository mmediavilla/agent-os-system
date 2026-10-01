import React, { useId } from "react";
import { StyleSheet, View } from "react-native";
import { OrbState } from "./AssistantOrb";
import { colors, injectStylesheet } from "../theme";

/**
 * The assistant, as a holographic core.
 *
 * Ported from the "JARVIS Holographic Core" design canvas the owner produced — a
 * wireframe sphere inside three orbit rings, with a swarm of particles, a
 * bloomed nucleus and a scan plane that sweeps it while it thinks. It replaces
 * `AssistantOrb` in the middle of the HUD, where the orb's arcs-and-ticks
 * drawing was reading as a loading spinner at 560px however good it looks at 34.
 *
 * ── What was ported, and what was left behind ───────────────────────────────
 *
 * The design is a **6-scene demo reel** — Dormant, Wake, Listen, Process,
 * Respond, Settle — driven by an authored timeline. This app has states and no
 * timeline, so the scenes are read as a vocabulary rather than as a sequence:
 * Dormant is `idle`, **Listen is `listening`**, Process is `working`,
 * **Respond is `responding`**, and the two states that must not move take their
 * own colour. Only `Wake` and `Settle` are left out, and they are the two that
 * could not be anything else — they are transitions *between* scenes, and a
 * state machine has no frame to hang them on.
 *
 * `listening` and `responding` arrived a pass after the rest, at the owner's request,
 * and the argument against them at the time was that a state nothing can reach
 * is decoration. The HUD's preview row answered that until Phase 11 removed it;
 * by then both were reachable for real. The microphone landed in 7.3; `responding` is the stretch of a run where the model
 * is writing rather than calling tools, which the streamed events already
 * distinguish and 7.2 will report.
 *
 * Its full-frame chrome — the telemetry panels, the RESPONSE readout, the
 * corner brackets, the status line, the background grid — is deliberately *not*
 * ported either. The HUD already draws all of that, better, out of real data:
 * the core menu is the telemetry, `HudChrome` is the bracket line, and the
 * graticule is behind the whole screen. Porting it would have been a second,
 * fake copy of the screen it is sitting in.
 *
 * ── Why it animates from CSS ────────────────────────────────────────────────
 *
 * The original recomputes every meridian, particle and ring position from a
 * clock, on every frame, in React. That is fine for a demo reel that plays for
 * eighteen seconds and right out of the question for the middle of a screen
 * meant to be left open all day — it would re-render ~75 SVG nodes at 60Hz
 * forever, through the JS thread, on the one screen with three live panels
 * beside it.
 *
 * So each moving part was re-expressed as something CSS can hold on its own:
 *
 * - **The meridians** are `scaleX` on a wrapping group, not a recomputed `rx`.
 *   A meridian of a rotating wireframe sphere is an ellipse whose width traces
 *   |sin(spin)| — which is exactly a scale oscillating 1 → 0 → 1 twice per
 *   turn. Staggering the delay across the eight of them *is* the rotation.
 * - **The orbit rings and the particle swarm** are groups under a plain
 *   rotation, at different rates and directions.
 * - **The scan plane** is the one part that needs the sphere's radius in its
 *   keyframes, because it has to follow the silhouette as it descends. That is
 *   why this file publishes its own stylesheet rather than adding to the shared
 *   one in `theme.ts`: the radius belongs beside the drawing, and a copy of it
 *   kept in the theme is a copy that goes stale in silence.
 *
 * What is left in JS is a handful of per-state *constants* — energy, spin rate,
 * tint — read once per render. Nothing recomputes between renders.
 *
 * The tints are `colors.*`, so the theme colour recolours the core like
 * everything else, and `prefers-reduced-motion` stops all of it through the
 * rule in `theme.ts` that covers the `data-hud` subtree.
 *
 * ── What it costs, and when ─────────────────────────────────────────────────
 *
 * This is ~110 elements under a `feGaussianBlur` bloom, animating forever, on
 * the screen whose whole premise is that it is left open. One thing keeps that
 * from being a battery bill, and it is a property of where it sits rather than
 * of this file — which is why it is written down here:
 *
 * - **A backgrounded tab freezes its document timeline.** Measured, while
 *   fighting it: `document.timeline.currentTime` sticks at 0 and every
 *   animation reports `currentTime: 0` while `playState` is still
 *   `running`.
 *
 * There used to be a second: other screens hid the HUD with `display: none`,
 * which stops CSS animations dead. Since Phase 11 the HUD is the only screen,
 * and Fitness, Settings and the Assistant are glass overlays *over* it, so the
 * sphere keeps turning under the blur while one is open.
 *
 * So the cost is paid while the tab is visible. What has *not*
 * been measured is the frame rate when they are — a hidden tab cannot be
 * profiled, and this one was hidden throughout. If the HUD ever feels heavy,
 * the bloom is the first thing to try removing: it is one attribute, and it
 * is the most expensive thing here by a wide margin.
 */

/** Everything is drawn in this square and scaled by the viewBox. */
const VB = 1000;
const C = VB / 2;
/**
 * The sphere's radius.
 *
 * The design draws it at 250 in a 1920x1080 frame — a wide frame with the
 * sphere in the middle of it and a lot of room either side for the telemetry
 * panels that are not being ported. Dropped into a square box those
 * proportions leave the sphere filling under half of it, so the radius is
 * re-picked against what actually has to fit: the outermost orbit ring at
 * 1.52R, the particle swarm at 1.56R, and the ground shadow at 1.45R below
 * centre. 285 puts the furthest of those at 945 of 1000, just inside the edge.
 */
const R = 285;
/** How far the sphere leans, so the latitude rings read as a globe. */
const TILT = 18;

const LATITUDES = [-64, -44, -24, 0, 24, 44, 64];
const MERIDIANS = 8;
const PARTICLES = 46;
/** Particles are bucketed into groups so one rotation drives many dots. */
const SWARMS = 4;
/**
 * Bars in the voice ring. The design draws 84; 56 reads the same at this
 * size and is 28 fewer elements inside the bloom, which is the expensive
 * part of every frame.
 */
const VOICE_BARS = 56;
/**
 * What a bar is worth when the room is silent.
 *
 * Not zero: a ring that disappears entirely says "not listening", and the
 * microphone *is* listening. A still 6% stub says "on, and hearing nothing",
 * which is the true statement and the one worth drawing.
 */
const VOICE_FLOOR = 0.06;

/**
 * The design's own hash, kept verbatim.
 *
 * It is what places the particles, and the placement is a large part of why the
 * swarm looks scattered rather than regular. Reimplementing it "more cleanly"
 * would produce a different, worse picture — so it is copied rather than
 * improved, and it stays deterministic so the swarm is identical on every
 * render and in every test.
 */
function hash(n: number): number {
  const s = Math.sin(n * 12.9898) * 43758.5453;

  return s - Math.floor(s);
}

/** Per-state look. Read once per render; nothing here changes between frames. */
type Look = {
  tint: string;
  /** 0–1. Drives every opacity in the drawing, the way the original's did. */
  energy: number;
  /** Seconds for one full turn of the sphere. */
  spin: number;
  /** Whether anything moves at all. */
  alive: boolean;
  /** Whether the scan plane sweeps. */
  scanning: boolean;
  /** Whether the voice ring is up. */
  voice: boolean;
  /** Whether shockwaves are pushing outward. */
  shock: boolean;
};

const off = { scanning: false, voice: false, shock: false } as const;

/**
 * The design's six scenes, read as six states.
 *
 * Each one turns a different layer on and leaves the rest of the drawing
 * alone, which is what makes them tell apart at a glance rather than by hue:
 * the voice ring is listening, the scan plane is thinking, the shockwaves are
 * answering, and the two that must not move do not move at all.
 */
const LOOKS: Record<OrbState, Look> = {
  // Dormant. On, and saying nothing more than that.
  idle: { ...off, tint: colors.accent, energy: 0.42, spin: 26, alive: true },
  // Listen: the ring of bars ripples and the sphere leans in a little.
  listening: { ...off, tint: colors.accent, energy: 0.8, spin: 16, alive: true, voice: true },
  // Respond, out loud. The same ring, driven from the other end of the call —
  // it scales by `--h-voice` either way, and what changed upstream is which
  // volume is being written into it. Brighter and quicker than listening,
  // because this is the assistant's turn rather than the room's.
  speaking: { ...off, tint: colors.accent, energy: 1, spin: 12, alive: true, voice: true },
  // Process: brighter, quicker, and being swept.
  working: { ...off, tint: colors.accent, energy: 1, spin: 9, alive: true, scanning: true },
  // Respond: the answer pushing outward.
  responding: { ...off, tint: colors.accent, energy: 1, spin: 11, alive: true, shock: true },
  // Amber and completely still — there is an approval card below it, and
  // anything moving beside that card says the work is still going on.
  awaiting: { ...off, tint: colors.amber, energy: 0.6, spin: 26, alive: false },
  failed: { ...off, tint: colors.error, energy: 0.34, spin: 26, alive: false },
  // The Anthropic switch: awaiting's amber and brightness, turning at idle's
  // pace. A decision rather than a fault, and nothing on screen is asking for
  // one — so, at the owner's call, it moves.
  off: { ...off, tint: colors.amber, energy: 0.6, spin: 26, alive: true },
};

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

/**
 * The scan plane's keyframes, which need `R` — hence this file publishing its
 * own stylesheet.
 *
 * The plane descends through the sphere and its width has to follow the
 * **silhouette**, or it stops reading as a cross-section and becomes a hoop
 * sliding past. That width is `sqrt(R² - dy²)`, and the first version of this
 * wrote three stops by hand and let CSS interpolate between them — which is
 * linear, and a circle is not. A quarter of the way down the true half-width
 * is 0.866R and linear interpolation gives 0.52R, so the plane pinched shut
 * long before it reached the pole. Visible, and the bug the owner reported.
 *
 * So the stops are *derived* from the circle, the same way the orb's dash
 * patterns are: a hand-tuned pair of numbers is right at one radius and
 * quietly wrong everywhere else. Nine of them keeps the worst error under
 * 1% of R, which is well inside a pixel at any size this is drawn at.
 *
 * The opacity is derived too, from the same width — the plane fades out as it
 * closes on each pole rather than popping, and one expression keeps the two
 * from disagreeing.
 *
 * The scale is **uniform**, and that is the second half of the same bug. A
 * cross-section of a sphere is a circle; drawn in this projection it is an
 * ellipse whose height is a fixed fraction of its width, so the two have to
 * shrink together. Scaling only X left the plane 0.3R tall at the north pole —
 * a lens hanging off the top of the sphere, overshooting the silhouette by
 * exactly the half-height it should no longer have had.
 */
const SCAN_STOPS = 9;

function scanKeyframes(): string {
  return Array.from({ length: SCAN_STOPS }, (_, i) => {
    const t = i / (SCAN_STOPS - 1);
    const dy = (2 * t - 1) * R;
    const width = Math.sqrt(Math.max(0, 1 - (dy / R) ** 2));

    return (
      `  ${(t * 100).toFixed(2)}% { ` +
      `transform: translateY(${dy.toFixed(2)}px) scale(${Math.max(0.02, width).toFixed(4)}); ` +
      `opacity: ${(0.9 * Math.min(1, width * 3)).toFixed(3)} }`
    );
  }).join("\n");
}
const CORE_CSS = `
@keyframes hud-core-meridian {
  0%   { transform: scaleX(0.02) }
  25%  { transform: scaleX(1) }
  50%  { transform: scaleX(0.02) }
  75%  { transform: scaleX(1) }
  100% { transform: scaleX(0.02) }
}
@keyframes hud-core-scan {
${scanKeyframes()}
}
@keyframes hud-core-pulse {
  0%,100% { opacity: .55; transform: scale(.94) }
  50%     { opacity: 1;   transform: scale(1.06) }
}
@keyframes hud-core-voice {
  0%,100% { transform: scaleY(.14) }
  50%     { transform: scaleY(1) }
}
@keyframes hud-core-shock {
  0%   { transform: scale(1);   opacity: .75 }
  100% { transform: scale(1.7); opacity: 0 }
}
`;

injectStylesheet("projectmc-hud-core", CORE_CSS);

/** Rotation about the middle of the box, for a group. */
function turn(seconds: number, reverse = false): React.CSSProperties {
  return {
    animation: `${reverse ? "hud-spin-reverse" : "hud-spin"} ${seconds}s linear infinite`,
    transformOrigin: "50% 50%",
  };
}

/**
 * The colour the core is drawn in for a state: the accent, amber while a write
 * waits or the switch is off, red when it failed. Exported so what is drawn
 * *around* the core (the HUD's click ring) is the same colour as the core.
 */
export function coreTint(state: OrbState): string {
  return LOOKS[state].tint;
}

export default function HolographicCore({
  state = "idle",
  decorative = false,
  voiceDriven = false,
}: {
  state?: OrbState;
  decorative?: boolean;
  /**
   * Whether a real microphone is behind the `listening` state.
   *
   * The HUD always passes it. It defaults to false for a core drawn with no
   * session behind it, which falls back to the ring's own clock. See `Voice`.
   */
  voiceDriven?: boolean;
}) {
  const look = LOOKS[state];
  const { tint, energy } = look;

  // Two cores could share a document the way the two orbs already do, and
  // `url(#id)` resolves against the first match — see AssistantOrb for the
  // failure that causes. Everything but letters and digits comes out, because
  // the punctuation is React's to choose.
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const ids = {
    glow: `core-glow-${uid}`,
    nucleus: `core-nucleus-${uid}`,
    bloom: `core-bloom-${uid}`,
    soft: `core-soft-${uid}`,
  };

  return (
    <View
      accessibilityRole={decorative ? "none" : "image"}
      accessibilityLabel={decorative ? undefined : LABELS[state]}
      accessibilityElementsHidden={decorative}
      importantForAccessibility={decorative ? "no-hide-descendants" : undefined}
      testID="holographic-core"
      style={s.root}
    >
      {/* The drawing is decorative; the View above it carries the name. */}
      <svg
        viewBox={`0 0 ${VB} ${VB}`}
        width="100%"
        height="100%"
        aria-hidden="true"
        focusable="false"
      >
        <defs>
          <radialGradient id={ids.glow}>
            <stop offset="0%" stopColor={tint} stopOpacity="0.28" />
            <stop offset="55%" stopColor={tint} stopOpacity="0.07" />
            <stop offset="100%" stopColor={tint} stopOpacity="0" />
          </radialGradient>
          <radialGradient id={ids.nucleus}>
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.95" />
            <stop offset="35%" stopColor={tint} stopOpacity="0.7" />
            <stop offset="100%" stopColor={tint} stopOpacity="0" />
          </radialGradient>
          <filter id={ids.soft} x="-80%" y="-80%" width="260%" height="260%">
            <feGaussianBlur stdDeviation="14" />
          </filter>
          {/* What makes it read as a hologram rather than as line art. Static,
              so it costs one composite rather than one per frame. */}
          <filter id={ids.bloom} x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="5" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        <g filter={`url(#${ids.bloom})`}>
          <OrbitRings look={look} />
          <Swarm look={look} />

          {/* The sphere. Latitudes are fixed geometry; the meridians are what
              turn, and they turn by being scaled rather than recomputed. */}
          <Latitudes tint={tint} energy={energy} />
          <Meridians look={look} />

          <circle
            cx={C}
            cy={C}
            r={R}
            fill="none"
            stroke={tint}
            strokeWidth="2"
            opacity={0.2 + 0.55 * energy}
          />
          <circle cx={C} cy={C} r={R} fill={`url(#${ids.glow})`} opacity={0.25 + 0.75 * energy} />

          {look.scanning && <ScanPlane tint={tint} />}
          {look.voice && <Voice tint={tint} energy={energy} driven={voiceDriven} />}
          {look.shock && <Shockwaves tint={tint} />}

          <circle
            cx={C}
            cy={C}
            r={38 + 26 * energy}
            fill={`url(#${ids.nucleus})`}
            opacity={0.35 + 0.65 * energy}
            filter={`url(#${ids.soft})`}
            style={
              look.alive
                ? {
                    animation: `hud-core-pulse ${look.spin / 6}s ease-in-out infinite`,
                    transformOrigin: "50% 50%",
                  }
                : undefined
            }
          />

          {/* Grounds the sphere. Without it the thing floats in a void. */}
          <ellipse
            cx={C}
            cy={C + R * 1.45}
            rx={R * (0.9 + 0.2 * energy)}
            ry={R * 0.06}
            fill={tint}
            opacity={0.06 + 0.16 * energy}
            filter={`url(#${ids.soft})`}
          />
        </g>
      </svg>
    </View>
  );
}

/** The fixed rings of latitude — they do not move as the sphere turns. */
function Latitudes({ tint, energy }: { tint: string; energy: number }) {
  const tilt = (TILT * Math.PI) / 180;

  return (
    <g>
      {LATITUDES.map((deg) => {
        const th = (deg * Math.PI) / 180;
        const rx = R * Math.cos(th);

        return (
          <ellipse
            key={deg}
            cx={C}
            cy={C - R * Math.sin(th) * Math.cos(tilt)}
            rx={rx}
            ry={Math.max(1.2, rx * Math.sin(tilt))}
            fill="none"
            stroke={tint}
            strokeWidth={deg === 0 ? 1.9 : 1.1}
            opacity={(0.12 + 0.5 * energy) * (deg === 0 ? 1.3 : 1)}
          />
        );
      })}
    </g>
  );
}

/**
 * The eight meridians, and the whole of the sphere's rotation.
 *
 * Each is a full-width ellipse squeezed horizontally by an animation running
 * on a wrapping group. One turn of the sphere is two squeeze cycles, so the
 * animation is twice the spin period and the eight delays are spread across
 * it — which is what makes the near ones widen while the far ones narrow.
 */
function Meridians({ look }: { look: Look }) {
  const period = look.spin;

  return (
    <g transform={`rotate(${TILT} ${C} ${C})`}>
      {Array.from({ length: MERIDIANS }, (_, i) => (
        <g
          key={i}
          style={{
            transformOrigin: "50% 50%",
            ...(look.alive
              ? {
                  animation: `hud-core-meridian ${period}s linear infinite`,
                  animationDelay: `${-(i / MERIDIANS) * period}s`,
                }
              : // Frozen: spread them across the cycle by hand, so a still
                // sphere is still a sphere rather than eight stacked lines.
                { transform: `scaleX(${Math.abs(Math.sin((i * Math.PI) / MERIDIANS)) || 0.02})` }),
          }}
        >
          <ellipse
            cx={C}
            cy={C}
            rx={R}
            ry={R}
            fill="none"
            stroke={look.tint}
            strokeWidth="1.1"
            opacity={0.08 + 0.42 * look.energy}
          />
        </g>
      ))}
    </g>
  );
}

function OrbitRings({ look }: { look: Look }) {
  const rings = [
    { r: R * 1.16, tilt: 74, dash: "2 14", w: 1.4, o: 0.5, rate: 1.6, reverse: false },
    { r: R * 1.34, tilt: 8, dash: "38 20", w: 2.2, o: 0.7, rate: 2.4, reverse: true },
    { r: R * 1.52, tilt: 62, dash: "4 26", w: 1.2, o: 0.35, rate: 3.4, reverse: false },
  ];

  return (
    <g>
      {rings.map((ring, i) => (
        // The tilt is a static wrapper and the spin is the animated child, so
        // the two transforms compose without the keyframes needing to know the
        // tilt.
        <g key={i} transform={`rotate(${ring.tilt} ${C} ${C})`}>
          <g style={look.alive ? turn(look.spin * ring.rate, ring.reverse) : undefined}>
            <ellipse
              cx={C}
              cy={C}
              rx={ring.r}
              ry={ring.r * 0.3}
              fill="none"
              stroke={look.tint}
              strokeWidth={ring.w}
              strokeDasharray={ring.dash}
              opacity={ring.o * (0.1 + 0.9 * look.energy)}
            />
          </g>
        </g>
      ))}
    </g>
  );
}

/**
 * The particle swarm.
 *
 * The original moves every dot independently on its own orbit. Here they are
 * bucketed into four groups, each turning at its own rate and direction, and
 * every dot's position within its group is fixed. At this size the difference
 * is invisible and it is four animations instead of forty-six.
 */
function Swarm({ look }: { look: Look }) {
  const groups = Array.from({ length: SWARMS }, () => [] as React.ReactNode[]);

  for (let i = 0; i < PARTICLES; i++) {
    const radius = R * (1.06 + hash(i) * 0.5);
    const angle = hash(i + 5) * Math.PI * 2;
    const incline = (hash(i + 12) - 0.5) * 1.4;

    groups[i % SWARMS].push(
      <circle
        key={i}
        cx={C + Math.cos(angle) * radius}
        cy={
          C +
          Math.sin(angle) * radius * 0.32 +
          Math.sin(angle * 2 + incline * 3) * radius * 0.22 * incline
        }
        r={0.6 + hash(i + 3) * 1.9}
        fill={look.tint}
        opacity={0.25 + 0.6 * hash(i + 7)}
      />,
    );
  }

  return (
    <g opacity={0.15 + 0.85 * look.energy}>
      {groups.map((dots, g) => (
        <g
          key={g}
          style={look.alive ? turn(look.spin * (1.4 + g * 0.7), g % 2 === 1) : undefined}
        >
          {dots}
        </g>
      ))}
    </g>
  );
}

/**
 * The voice ring: bars standing off the sphere's edge, rippling.
 *
 * The design drives every bar from noise on each frame. Here each one has a
 * fixed length and a `scaleY` that runs on its own schedule — the *duration*
 * is varied per bar from the same hash the swarm uses, not just the delay,
 * because a shared duration with staggered delays is a wave travelling round
 * the ring rather than a voice.
 *
 * The scale is about each bar's inner end rather than its middle, so the ring
 * stays welded to the sphere and only grows outwards.
 *
 * ── What 7.3 paid ──────────────────────────────────────────────────────────
 *
 * 7.1 shipped these bars rippling on their own CSS clock and wrote down the
 * debt: it looks alive, and it looks exactly as alive in silence, which is the
 * one thing a listening indicator must never do. **`driven` is that debt
 * settled.** The ring now scales by `--h-voice`, one custom property written
 * once per frame off real audio — `useAgentSession` since 9.1, following the
 * microphone while listening and the assistant's own voice while it answers —
 * so a quiet room is a flat ring, and the bars move when and only when there is
 * something to hear.
 *
 * Three details of the settlement, each of which was a choice:
 *
 * - **A property, not a prop.** Passing an amplitude through React would
 *   re-render 56 elements inside a bloom filter sixty times a second, which is
 *   what this whole file was written to avoid. A custom property inherits, so
 *   one write on `<html>` reaches every bar.
 * - **The bars rest at 6% rather than at nothing.** A ring that vanishes
 *   completely in silence is indistinguishable from a ring that is not there,
 *   and "listening, hearing nothing" is a different thing to say from "not
 *   listening". The stub is still, which is the part that matters.
 * - **The per-bar hash stays**, twice over: a fixed length as before, and now a
 *   gain, so the bars answer the same amplitude by different amounts. Real
 *   audio is one number and would otherwise move all 56 in lockstep — a clean
 *   pulsing ring, which is not what a voice looks like.
 *
 * `driven` is false only where there is no microphone behind the state (the
 * HUD's preview row did that until Phase 11). There the old clock is still the
 * right picture, because nothing is claiming to hear.
 */
function Voice({ tint, energy, driven }: { tint: string; energy: number; driven: boolean }) {
  const inner = R * 1.03;

  return (
    <g opacity={0.35 + 0.65 * energy}>
      {Array.from({ length: VOICE_BARS }, (_, i) => {
        const deg = (i / VOICE_BARS) * 360;
        const length = R * (0.08 + 0.26 * hash(i + 61));
        const gain = (0.7 + hash(i + 17) * 0.6).toFixed(2);

        return (
          <g key={i} transform={`rotate(${deg} ${C} ${C})`}>
            <g
              style={{
                transformOrigin: `${C}px ${C - inner}px`,
                ...(driven
                  ? { transform: `scaleY(calc(${VOICE_FLOOR} + var(--h-voice, 0) * ${gain}))` }
                  : {
                      animation: `hud-core-voice ${(0.5 + hash(i + 17) * 0.7).toFixed(2)}s ease-in-out infinite`,
                      animationDelay: `${(-hash(i + 29) * 1.2).toFixed(2)}s`,
                    }),
              }}
            >
              <line
                x1={C}
                y1={C - inner}
                x2={C}
                y2={C - inner - length}
                stroke={tint}
                strokeWidth="2.4"
                strokeLinecap="round"
                opacity={0.35 + 0.6 * hash(i + 7)}
              />
            </g>
          </g>
        );
      })}
    </g>
  );
}

/**
 * Shockwaves — the answer arriving.
 *
 * Three flat rings in the sphere's equatorial plane, expanding and fading on a
 * stagger. They stop at 1.7x because the box is only 1000 across: anything
 * larger is clipped by the viewport, and a ring that vanishes at the edge of
 * the frame reads as a bug rather than as distance.
 */
function Shockwaves({ tint }: { tint: string }) {
  return (
    <g>
      {[0, 1, 2].map((i) => (
        <ellipse
          key={i}
          cx={C}
          cy={C}
          rx={R}
          ry={R * 0.3}
          fill="none"
          stroke={tint}
          strokeWidth="2.6"
          style={{
            transformOrigin: `${C}px ${C}px`,
            animation: `hud-core-shock 1.5s ease-out infinite`,
            animationDelay: `${i * 0.45}s`,
          }}
        />
      ))}
    </g>
  );
}

/** The cross-section that sweeps the sphere while the assistant is thinking. */
function ScanPlane({ tint }: { tint: string }) {
  return (
    <g
      style={{
        // Linear rather than eased. `ease-in-out` slows at both ends, which is
        // exactly where the plane is smallest — it would loiter as a dot at
        // each pole and hurry through the middle.
        animation: "hud-core-scan 2.4s linear infinite",
        transformOrigin: "50% 50%",
      }}
    >
      <ellipse cx={C} cy={C} rx={R} ry={R * 0.3} fill="none" stroke={tint} strokeWidth="2.4" />
      <ellipse cx={C} cy={C} rx={R} ry={R * 0.3} fill={tint} opacity="0.07" />
    </g>
  );
}

const s = StyleSheet.create({
  root: { width: "100%", height: "100%", aspectRatio: 1 },
});
