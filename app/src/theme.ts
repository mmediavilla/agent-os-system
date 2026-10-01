import type { ViewStyle } from "react-native";
import type { Accent } from "./accent";

// Centralised colors / spacing / typography so screens stay consistent.
// RN-Web translates these into CSS.
//
// ── How the palette reaches the screens ─────────────────────────────────────
// Every screen builds its styles with `StyleSheet.create` at module scope, so
// the exported `colors` are read once, at import time, and can never change
// afterwards. Rather than rewrite 240-odd call sites into render-time lookups,
// `colors` holds CSS custom properties (`var(--c-bg)`): RN-Web passes any
// string starting with `var(` straight through to CSS untouched (see
// `isWebColor` in react-native-web), so the *value* behind each token is free
// to change at runtime. Flipping `data-accent` on <html> re-colours every
// mounted screen at once, with no re-render and no per-screen changes.
//
// There is one palette. The app had light and dark ones until 11.2 made the HUD
// the only screen, with Fitness and Settings opening over it on glass: nothing
// was left drawn outside the HUD's colours except a modal or two, so the
// Light/Dark setting went (the owner's call) and the HUD's palette became the root's.

/**
 * The palette — the instrument look: cyan on deep navy.
 *
 * It was the HUD's scoped palette, beside a light and a dark one for every
 * other screen, and the app's is what it became when those went. The name
 * stayed, because "the HUD's palette" is still what it is.
 *
 * Neutrals re-picked for navy rather than inverted from a light theme:
 * `surface` sits *above* `bg` so panels read as raised, and the semantic
 * accents are the bright 400 steps, because mid-tones lose contrast on a dark
 * ground.
 */
const HUD = {
  bg:        "#040d18", // the deep navy behind the instruments
  surface:   "#0a1a2b",
  glass:     "rgba(6, 20, 34, 0)",
  border:    "#123049",
  borderHi:  "#1d4d70",
  text:      "#d8f2ff",
  textMuted: "#7fb4d4",
  textDim:   "#5c8aa8",

  accent:    "#22d3ee", // cyan-400 — the HUD's whole identity
  accentBg:  "#07202e",
  accentBd:  "#155e75", // cyan-800
  accentTxt: "#67e8f9", // cyan-300
  accentHov: "#a5f3fc", // cyan-200

  error:      "#ff5c6c",
  errorBg:    "#2a0f16",
  errorBd:    "#6b2230",
  errorHov:   "#3a141d",
  errorBgAlt: "#1e0c11",
  errorBdAlt: "#5c1e29",
  errorTxt:   "#ff9aa5",
  danger:     "#ff5c6c",

  emerald:    "#34d399",
  emeraldBg:  "#062b23",
  emeraldTxt: "#6ee7b7",
  amber:      "#fbbf24",
  amberBg:    "#2b1f07",
  sky:        "#38bdf8",
  skyBg:      "#04263a",
  violet:     "#a78bfa",
  violetBg:   "#1b1638",
} as const;

export type ColorToken = keyof typeof HUD;
export type Palette = Record<ColorToken, string>;

export const hudPalette: Palette = HUD;

/**
 * Tokens with no role in `Palette`, because only the instrument chrome draws
 * them: the graticule, the corner brackets on a panel, and the scrim behind
 * the core menu on a narrow window. `--h-*` rather than `--c-*`, so the
 * palette stays the list of roles every surface has.
 */
export const hudExtras = {
  grid:    "rgba(34, 211, 238, 0.055)", // the graticule — barely there on purpose
  bracket: "#1d7f97",                   // panel corner ticks: dimmer than accent, still cyan
  veil:    "rgba(2, 8, 15, 0.72)",      // behind the core menu on a narrow window
} as const;

export type HudExtraToken = keyof typeof hudExtras;

/**
 * Chart tokens for the Fitness dashboard. The heatmap ramp climbs in intensity
 * from "no training" to "hardest day", in the accent rather than in emerald: a
 * green heatmap inside a cyan instrument reads as a second, unrelated chart.
 * `track` matches the bar-track fill the Fitness and Workouts screens use.
 */
const hudChart = {
  heatmap: ["#0a1a2b", "#0e3a4a", "#12697c", "#22d3ee", "#a5f3fc"],
  track: "#0e2233",
};

// ── The theme colour ─────────────────────────────────────────────────────────

/** The five tokens an accent choice replaces. Everything else stays put. */
export const ACCENT_TOKENS = ["accent", "accentBg", "accentBd", "accentTxt", "accentHov"] as const;
export type AccentToken = (typeof ACCENT_TOKENS)[number];
export type AccentFamily = Record<AccentToken, string>;

/**
 * What each theme colour is: one hex, the design's own knob value, from which
 * `hudAccent` makes the other tokens. That formula is not a guess: run over the
 * classic cyan it lands within a few units of every hand-tuned value in
 * `hudPalette`, which is pinned in `theme.test`.
 *
 * It had a light and a dark family beside it until the light and dark palettes
 * went. `classic` has no entry: it is the palette as it already is, so choosing
 * it publishes no rule at all.
 */
export const ACCENT_SPECS: Record<Exclude<Accent, "classic">, string> = {
  mint: "#63f5b0",
  azure: "#5cc8ff",
  violet: "#c08bff",
};

type Rgb = [number, number, number];

const rgbOf = (hex: string): Rgb => {
  const n = parseInt(hex.replace("#", ""), 16);

  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/** `a` laid over `b` at `t` — 0 is all `b`, 1 is all `a`. */
export function mixHex(a: string, b: string, t: number): string {
  const [x, y] = [rgbOf(a), rgbOf(b)];

  return `#${x.map((c, i) => Math.round(y[i] + (c - y[i]) * t).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Every HUD token that carries the accent, from one hex.
 *
 * The fills sink the accent into the navy (a tint of it over `bg`, or over
 * `surface` for the heatmap's middle steps) and the text colours lift it toward
 * white. Nine values, of which the design supplies one.
 */
export function hudAccent(hex: string) {
  const [r, g, b] = rgbOf(hex);
  const hov = mixHex("#ffffff", hex, 0.6);

  return {
    family: {
      accent: hex,
      accentBg: mixHex(hex, hudPalette.bg, 0.12),
      accentBd: mixHex(hex, hudPalette.bg, 0.4),
      accentTxt: mixHex("#ffffff", hex, 0.35),
      accentHov: hov,
    } satisfies AccentFamily,
    grid: `rgba(${r}, ${g}, ${b}, 0.055)`,
    bracket: mixHex(hex, hudPalette.bg, 0.58),
    heatmap: [
      hudChart.heatmap[0],
      mixHex(hex, hudPalette.surface, 0.17),
      mixHex(hex, hudPalette.surface, 0.43),
      hex,
      hov,
    ],
  };
}

/**
 * The accent tokens under a choice, as hex — for anything that has to paint a
 * colour literally rather than through the variables (Settings' theme colour
 * chips, where every row must show its own colour and not the current one).
 */
export function accentFamily(accent: Accent): AccentFamily {
  if (accent === "classic") {
    return Object.fromEntries(ACCENT_TOKENS.map((k) => [k, hudPalette[k]])) as AccentFamily;
  }

  return hudAccent(ACCENT_SPECS[accent]).family;
}

// ── Token plumbing ───────────────────────────────────────────────────────────

const cssVar = (name: string) => `var(--${name})`;

const varPalette = Object.fromEntries(
  (Object.keys(hudPalette) as ColorToken[]).map((k) => [k, cssVar(`c-${k}`)]),
) as Palette;

const varChart = {
  heatmap: hudChart.heatmap.map((_, i) => cssVar(`ch-heat-${i}`)),
  track: cssVar("ch-track"),
};

const varHudExtras = Object.fromEntries(
  (Object.keys(hudExtras) as HudExtraToken[]).map((k) => [k, cssVar(`h-${k}`)]),
) as Record<HudExtraToken, string>;

/** The overrides for every theme colour but `classic`, one rule each. */
function accentRules(): string[] {
  const family = (f: AccentFamily) => ACCENT_TOKENS.map((k) => `--c-${k}:${f[k]}`);

  return (Object.keys(ACCENT_SPECS) as (keyof typeof ACCENT_SPECS)[]).map((name) => {
    const derived = hudAccent(ACCENT_SPECS[name]);

    return `:root[data-accent="${name}"]{${[
      ...family(derived.family),
      `--h-grid:${derived.grid}`,
      `--h-bracket:${derived.bracket}`,
      ...derived.heatmap.map((v, i) => `--ch-heat-${i}:${v}`),
    ].join(";")}}`;
  });
}

/**
 * The CSS the palette and the shared chrome are published as. `:root` carries
 * the palette; `data-accent` on <html> (set by ThemeProvider) swaps its accent.
 */
export function themeStylesheet(): string {
  const palette = [
    ...(Object.keys(hudPalette) as ColorToken[]).map((k) => `--c-${k}:${hudPalette[k]}`),
    ...hudChart.heatmap.map((v, i) => `--ch-heat-${i}:${v}`),
    `--ch-track:${hudChart.track}`,
    ...(Object.keys(hudExtras) as HudExtraToken[]).map((k) => `--h-${k}:${hudExtras[k]}`),
  ].join(";");

  return [
    `:root{color-scheme:dark;${palette}}`,
    // The theme colour. One attribute more specific than `:root`, which is the
    // whole mechanism, and only the accent tokens are redefined.
    ...accentRules(),
    // RN-Web only paints the app's own root element, so without this the page
    // behind it (and anything revealed by overscroll) stays white.
    `html,body{background-color:var(--c-bg)}`,
    // Frosted glass, for a surface floated over the app rather than replacing
    // it — the HUD's overlays (Assistant, Settings, Fitness) and its corner
    // cards. It was
    // tuned on the calendar drawer, which 10.2 deleted. It rides a data attribute rather than a
    // style prop for one measured reason: `backgroundColor: colors.glass` gets
    // through RN-Web because the value starts with `var(`, and `backdropFilter`
    // is not a React Native style property at all, so there is nothing to be
    // confident it forwards. A rule keyed on an attribute is the same mechanism
    // `data-hud` already rides and needs nothing from the style compiler.
    // Without the blur the surface is merely see-through, which is a graceful
    // enough failure that it is not worth a fallback.
    //
    // **The radius is the knob, not the alpha**, and that is worth stating
    // because it is the opposite of what it feels like. The fill is `rgba(…,0)`
    // — the surface is fully transparent and adds no darkness at all. What
    // makes the drawer read as a dark panel is this blur: the HUD behind it is
    // mostly near-black navy, and averaging near-black navy over a wide radius
    // gives back near-black navy. Turn the filter off entirely and the whole
    // HUD is plainly visible through the calendar, panels and transcript and
    // all; lower the radius and its structure comes back as soft shapes.
    //
    // So 20px is chosen for what it *shows*, not for what it hides: enough of
    // the HUD to read as glass over an instrument, not so much that the core's
    // caption competes with the text on the glass.
    `[data-glass]{backdrop-filter:blur(20px) saturate(140%);-webkit-backdrop-filter:blur(20px) saturate(140%)}`,
    // A label turned on its side — the console's vertical ASSISTANT spine. Same
    // argument as the line above: `writing-mode` is not a React Native style
    // property, so it cannot ride a style prop, and the alternative — an
    // absolutely positioned box rotated 90 degrees — has to be measured before
    // it can be centred. Written as CSS the text lays itself out and the box
    // follows it.
    `[data-vertical]{writing-mode:vertical-rl;transform:rotate(180deg)}`,
    // A native date or time picker, themed. `color-scheme: dark` on `:root`
    // already does the heavy lifting — the calendar panel and the spinner come
    // up dark without being asked here — so what is left is the accent the
    // browser highlights a selection with, and the indicator a style prop
    // cannot reach because it is a pseudo-element. See `pickerScope`.
    `[data-picker]{accent-color:var(--c-accent)}`,
    `[data-picker]::-webkit-calendar-picker-indicator{cursor:pointer;opacity:.55}`,
    `[data-picker]::-webkit-calendar-picker-indicator:hover{opacity:1}`,
    // The orb's rings and the live pills. CSS keyframes rather than `Animated`
    // because the orb is now SVG: a `stroke-dasharray` ring turning at a
    // constant rate is one declaration here and a per-frame React re-render
    // through the JS thread otherwise. See AssistantOrb.
    `@keyframes hud-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`,
    `@keyframes hud-spin-reverse{from{transform:rotate(360deg)}to{transform:rotate(0deg)}}`,
    `@keyframes hud-breathe{0%,100%{opacity:.45}50%{opacity:1}}`,
    // The square beside each core menu panel's title, from the owner's design: on,
    // then nearly off, with no fade between (`steps(2)`).
    `@keyframes hud-blink{0%,58%{opacity:1}59%,100%{opacity:.12}}`,
    // The core saying it can be clicked: a faint ring breathing out of the
    // sphere while nothing is hovering it, and one fast ring after a click.
    `@keyframes hud-core-beckon{0%{transform:scale(.98);opacity:0}25%{opacity:.45}70%,100%{transform:scale(1.28);opacity:0}}`,
    `@keyframes hud-core-ping{0%{transform:scale(1);opacity:.9}100%{transform:scale(1.55);opacity:0}}`,
    // Hovering the core: the ring closes in from further out while its
    // stroke draws round from twelve o'clock; leaving unwinds it.
    `@keyframes hud-core-ring-in{0%{transform:scale(1.3);opacity:0}100%{transform:scale(1.06);opacity:.9}}`,
    `@keyframes hud-core-ring-draw{0%{stroke-dashoffset:100}100%{stroke-dashoffset:0}}`,
    `@keyframes hud-core-ring-out{0%{transform:scale(1.06);opacity:.9}100%{transform:scale(1.18);opacity:0}}`,
    `@keyframes hud-core-ring-undraw{0%{stroke-dashoffset:0}100%{stroke-dashoffset:-100}}`,
    // Everything the HUD animates is decorative motion around a state that is
    // also stated in text, so there is nothing to keep for anyone who asked
    // the OS to stop moving things.
    `@media (prefers-reduced-motion:reduce){[data-hud] *{animation:none!important;transition:none!important}}`,
    // The voice ring is the one moving thing that is not on a clock — it is a
    // transform driven by a custom property `useAgentSession` rewrites every frame, so
    // neither `animation:none` nor `transition:none` above touches it. Pinning
    // the property is what stops it, and it works because a declaration on the
    // HUD container is *nearer* to the bars than the inline one on <html>, so
    // it wins for that subtree without a fight. The ring stays at its resting
    // stub and the caption underneath still says "Listening".
    `@media (prefers-reduced-motion:reduce){[data-hud]{--h-voice:0}}`,
  ].join("\n");
}

/**
 * Publishes a block of CSS into the document, once per id.
 *
 * The palettes and the shared keyframes go in through the same door below.
 * This one is exported because a drawing whose keyframes depend on its own
 * geometry cannot have them written here — `HolographicCore` interpolates a
 * scan plane across its own radius, and a copy of that radius kept in this
 * file is a copy that goes stale silently. So the constant stays beside the
 * drawing and the CSS comes to the document from there.
 */
export function injectStylesheet(id: string, css: string) {
  if (typeof document === "undefined") return;

  const existing = document.getElementById(id);
  if (existing) {
    // **Replace rather than return.** This used to bail out the moment the
    // element existed, which is right in production — the module runs once —
    // and quietly wrong under Expo's hot reload, where the module re-runs
    // against a document that still holds the *old* stylesheet. Every palette
    // edit then appeared to do nothing until a hard refresh, which is a long
    // way to chase a colour that was already correct in the source.
    //
    // Compared before writing, because a caller may re-inject on every render
    // and rewriting identical CSS invalidates style for the whole document.
    if (existing.textContent !== css) existing.textContent = css;

    return;
  }

  const el = document.createElement("style");
  el.id = id;
  el.textContent = css;
  document.head.appendChild(el);
}
const STYLE_ELEMENT_ID = "projectmc-theme-vars";

/**
 * Publishes the palettes into the document. Runs once at import, before any
 * screen's StyleSheet is read, so no frame is painted against missing vars.
 *
 * Goes through `injectStylesheet` so it inherits the replace-on-re-inject rule
 * — this is the stylesheet that rule exists for, since every token in the app
 * lives in it and an edit to any of them is invisible until it is rewritten.
 */
function injectThemeStylesheet() {
  injectStylesheet(STYLE_ELEMENT_ID, themeStylesheet());
}

injectThemeStylesheet();

/** The color tokens screens should use — CSS variables that follow the theme. */
export const colors: Palette = varPalette;

export const chart = {
  ...varChart,
  tonnage: varPalette.emerald,
  sets: varPalette.sky,
};

/**
 * The instrument-only tokens, as variables. Declared on `:root` with the
 * palette, so they resolve anywhere.
 */
export const hud: Record<HudExtraToken, string> = varHudExtras;

/**
 * What the HUD's container spreads: `data-hud` on the one subtree whose motion
 * `prefers-reduced-motion` stops, and where the voice ring's level is pinned.
 *
 * It used to carry the palette too, scoped to the HUD while the other screens
 * drew in light or dark. The palette is the root's now, and what is left keyed
 * on the attribute is motion.
 */
export const HUD_SCOPE = { dataSet: { hud: "true" } };

/**
 * What a surface spreads to be frosted rather than opaque.
 *
 * Same mechanism as `HUD_SCOPE` and for a narrower reason: the translucency is
 * a colour (`colors.glass`, which reaches CSS because it is a `var(`) but the
 * blur behind it is `backdrop-filter`, which React Native has never heard of.
 * A rule keyed on the attribute is the reliable way to say it — see
 * `themeStylesheet`.
 *
 * Only for something floated *over* the app. On an opaque surface there is
 * nothing behind to blur, and the browser still pays for the filter.
 */
export const GLASS_SCOPE = { dataSet: { glass: "true" } };

/**
 * What a label spreads to read bottom-to-top.
 *
 * The third use of the mechanism `data-hud` and `data-glass` already
 * established, and it is here for the identical reason `GLASS_SCOPE` is:
 * `writing-mode` is not a React Native style property, so there is nothing to
 * be confident the style compiler forwards.
 *
 * `vertical-rl` plus a half turn rather than `vertical-lr`, because the design
 * draws the spine reading *upward* — which is the direction a label pinned to a
 * left edge is read in, and the one `vertical-lr` gets backwards.
 */
export const VERTICAL_SCOPE = { dataSet: { vertical: "true" } };

/**
 * What a date or a time field spreads so the browser's own picker reads as part
 * of the HUD rather than a piece of the operating system dropped into it.
 *
 * The fourth use of the mechanism the three above established, and for the same
 * reason: none of what a native picker needs is a React Native style property.
 * `accent-color` tints the selected day and the focused spinner, and the
 * calendar indicator is a pseudo-element, which a style prop cannot reach at
 * all. What is *not* here is the important part — the panel and the indicator
 * are already legible on navy because `:root` declares `color-scheme: dark`,
 * so the browser paints its own chrome to match the app instead of over it.
 *
 * The attribute names the kind, so a rule can tell a date from a time later
 * without a second scope; today both want the same declarations.
 */
export const pickerScope = (kind: "date" | "time") => ({ dataSet: { picker: kind } });

export const radii = { sm: 6, md: 10, lg: 14, xl: 18 } as const;
export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, "2xl": 24 } as const;

/** Decelerating, so a panel arrives rather than stops. */
export const EASE_OUT = "cubic-bezier(0.22, 0.61, 0.36, 1)";

/**
 * A CSS transition, as a style object.
 *
 * RN-Web forwards `transitionProperty` and friends straight into the generated
 * CSS — its style compiler knows the property by name, because it has to flip
 * the value for right-to-left layouts. React Native's `ViewStyle` has never
 * heard of them, hence the cast, which is here once instead of at each caller.
 *
 * Why this rather than `Animated`: the thing being animated is a layer's
 * opacity and offset (a core menu panel, an overlay, a corner card), and both
 * ends of that are already a function of state the screen re-renders on. A CSS
 * transition needs no animated value, no driver, no cleanup, and no per-frame
 * `setState` through the JS thread — the same argument that moved the orb's
 * rotation to keyframes. What it costs is that the element has to stay mounted
 * at both ends, which is why a shut layer is made unreachable (`reachable`)
 * rather than removed from the tree.
 *
 * The reduced-motion rule in `themeStylesheet` turns all of it off in one line.
 */
export function transition(properties: string, ms = 260, easing: string = EASE_OUT) {
  return {
    transitionProperty: properties,
    transitionDuration: `${ms}ms`,
    transitionTimingFunction: easing,
  } as ViewStyle;
}

/**
 * Whether a layer that stays mounted for its transition can be reached — the
 * glass overlays and the popout cards, shut.
 *
 * **`pointerEvents: none` alone is not enough.** RN-Web renders a *disabled*
 * Pressable as `box-none`, and that polyfill is a rule turning `pointer-events`
 * back on for the button's children. So a shut layer holding a greyed-out
 * button kept that button's label as an invisible click target over whatever
 * lay beneath: the closed Settings' "Add calendar" sat on the Optics ✕, which
 * worked only at its rim until Settings had been opened once and its calendars
 * had loaded and moved the button.
 *
 * `visibility: hidden` is inherited and nothing in RN-Web turns it back on, so
 * no descendant can be hit. List `visibility` in the layer's `transition()`: a
 * discrete property flips at the *end* of a fade-out and the *start* of a
 * fade-in, so the fade still shows both ways.
 */
export function reachable(open: boolean) {
  return {
    pointerEvents: open ? "auto" : "none",
    visibility: open ? "visible" : "hidden",
  } as ViewStyle;
}

/**
 * The typography scale.
 *
 * The app has never had one — every screen writes `fontSize: 13` inline and
 * picks a weight by eye, which is how the same "eyebrow" label ended up at 10,
 * 11 and 12px on three screens. That was survivable while every screen was a
 * list of cards. A HUD is dense by design: a panel header, a unit suffix, a
 * telemetry readout and a caption can sit within 30px of each other, and at
 * that density "roughly the same size" reads as a mistake.
 *
 * Nine steps, named for the job rather than the size, so a screen picks a role
 * and the scale decides the numbers. `lineHeight` travels with `fontSize`
 * because RN does not derive one — omitting it is what makes stacked labels
 * drift out of alignment between two panels.
 *
 * `readout` is the only one that names a family: telemetry is digits that
 * change in place, and a proportional font makes them jump sideways every time
 * a 1 becomes an 8. Tabular figures fix the same thing more subtly, but no
 * system UI font on every platform has them; a monospace stack always does.
 */
export const type = {
  /** The one number on a panel that is the point of the panel. */
  display: { fontSize: 30, lineHeight: 34, fontWeight: "700", letterSpacing: -0.5 },
  /** A screen's own name. */
  title:   { fontSize: 20, lineHeight: 26, fontWeight: "700", letterSpacing: -0.2 },
  /** A panel's heading. */
  heading: { fontSize: 15, lineHeight: 20, fontWeight: "600" },
  /** Running prose — the assistant's answers, a note, a description. */
  body:    { fontSize: 14, lineHeight: 20, fontWeight: "400" },
  /** Body copy that has to fit in a row rather than a paragraph. */
  small:   { fontSize: 13, lineHeight: 18, fontWeight: "400" },
  /** Timestamps, hints, the second line of a two-line row. */
  caption: { fontSize: 12, lineHeight: 16, fontWeight: "400" },
  /** Tick labels and axis marks. Below this, nothing is readable. */
  micro:   { fontSize: 10, lineHeight: 13, fontWeight: "500" },
  /** The all-caps eyebrow above a panel or a stat. */
  label:   { fontSize: 11, lineHeight: 14, fontWeight: "700", letterSpacing: 1.1 },
  /** Telemetry: a number that is replaced by another number in the same slot. */
  readout: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    fontSize: 13,
    lineHeight: 17,
    fontWeight: "600",
  },
} as const;
