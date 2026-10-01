import { CALENDAR_COLORS, CalendarColor } from "./api";
import { hudPalette } from "./theme";

/**
 * Google Calendar's colours, and how they are drawn on the HUD.
 *
 * An iCal feed carries a calendar's name but not its colour, so the user picks
 * one again in Settings, out of the eleven names Google's own picker uses. The
 * names are what they recognise; the hexes below are what Google paints them.
 *
 * **Google's hexes were chosen for a white page, and three of them vanish on
 * navy.** Blueberry and Grape sit near 2.5:1 against the HUD's surface and
 * Graphite at 2.8, all under the 3:1 a graphical object needs to be seen at all
 * — a dot you cannot find is a calendar you cannot tell apart from the rest.
 * The other eight clear it as Google paints them, and are left exactly so.
 * Google does the same thing in its own dark theme: the colour lightens and
 * keeps its name. So each is **lifted toward white, just far enough**, and only
 * if it has to be. The amount is derived rather than written out, for the reason
 * the orb's dash patterns are: a hand-tuned tint is right against one ground and
 * quietly wrong the day that ground changes.
 *
 * Every surface that draws these is inside `data-hud` — the agenda panel, and
 * Settings, which is a HUD overlay — so there is one ground to clear, not two.
 */

/** What Google paints each colour, on a light page. */
export const GOOGLE_HEX: Record<CalendarColor, string> = {
  tomato: "#d50000",
  flamingo: "#e67c73",
  tangerine: "#f4511e",
  banana: "#f6bf26",
  sage: "#33b679",
  basil: "#0b8043",
  peacock: "#039be5",
  blueberry: "#3f51b5",
  lavender: "#7986cb",
  grape: "#8e24aa",
  graphite: "#616161",
};

export const COLOR_LABELS: Record<CalendarColor, string> = {
  tomato: "Tomato",
  flamingo: "Flamingo",
  tangerine: "Tangerine",
  banana: "Banana",
  sage: "Sage",
  basil: "Basil",
  peacock: "Peacock",
  blueberry: "Blueberry",
  lavender: "Lavender",
  grape: "Grape",
  graphite: "Graphite",
};

/** WCAG's floor for a graphical object against what is behind it. */
export const MIN_CONTRAST = 3;

type Rgb = [number, number, number];

function rgb(hex: string): Rgb {
  const n = parseInt(hex.replace("#", ""), 16);

  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function hexOf([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;
}

/** WCAG relative luminance. */
export function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);

  return (hi + 0.05) / (lo + 0.05);
}

/**
 * `hex`, mixed toward white in small steps until it clears `min` against every
 * ground — or unchanged, if it already does. Toward white rather than up in
 * saturation, because that is the direction that keeps the hue: Blueberry
 * lifted is still blue, just a blue you can see.
 */
export function lift(hex: string, grounds: string[], min = MIN_CONTRAST): string {
  const from = rgb(hex);

  for (let t = 0; t <= 1; t += 0.02) {
    const mixed = hexOf(from.map((c) => c + (255 - c) * t) as Rgb);

    if (grounds.every((g) => contrast(mixed, g) >= min)) return mixed;
  }

  return "#ffffff";
}

/** The grounds a dot is drawn on: the HUD itself, and the panels and cards on it. */
const HUD_GROUNDS = [hudPalette.bg, hudPalette.surface];

/** Each colour as the HUD draws it. Computed once, at import. */
export const CALENDAR_HEX: Record<CalendarColor, string> = Object.fromEntries(
  CALENDAR_COLORS.map((c) => [c, lift(GOOGLE_HEX[c], HUD_GROUNDS)]),
) as Record<CalendarColor, string>;

/**
 * The colour for a feed, tolerating a key this client has never heard of.
 *
 * The server validates against the same closed set, so an unknown key means the
 * two lists drifted. Graphite rather than nothing: an empty dot reads as a
 * calendar that failed to load.
 */
export function calendarHex(key: string | null | undefined): string {
  return CALENDAR_HEX[key as CalendarColor] ?? CALENDAR_HEX.graphite;
}
