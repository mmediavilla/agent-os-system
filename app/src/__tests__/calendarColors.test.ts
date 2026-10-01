import { CALENDAR_COLORS } from "../api";
import {
  CALENDAR_HEX,
  GOOGLE_HEX,
  MIN_CONTRAST,
  calendarHex,
  contrast,
  lift,
} from "../calendarColors";
import { hudPalette } from "../theme";

/**
 * Google's colours on the HUD's navy.
 *
 * The property is the one the plan asked to be checked rather than assumed:
 * every calendar dot can actually be seen on the ground it is drawn on. The
 * second property is that nothing was lifted that did not need to be — a
 * colour the user already knows from Google should stay exactly that colour
 * wherever it can.
 */

it("mirrors the server's closed set, in Google's order", () => {
  // `CalendarFeed::COLORS` on the backend. A key the client has no hex for
  // would draw an empty dot.
  expect(CALENDAR_COLORS).toEqual([
    "tomato",
    "flamingo",
    "tangerine",
    "banana",
    "sage",
    "basil",
    "peacock",
    "blueberry",
    "lavender",
    "grape",
    "graphite",
  ]);
  expect(Object.keys(CALENDAR_HEX).sort()).toEqual([...CALENDAR_COLORS].sort());
});

it("puts every calendar colour at 3:1 or better on the HUD and on its panels", () => {
  for (const color of CALENDAR_COLORS) {
    for (const ground of [hudPalette.bg, hudPalette.surface]) {
      expect(contrast(CALENDAR_HEX[color], ground)).toBeGreaterThanOrEqual(MIN_CONTRAST);
    }
  }
});

it("leaves Google's own hex alone wherever it already clears", () => {
  for (const color of CALENDAR_COLORS) {
    const clears = [hudPalette.bg, hudPalette.surface].every(
      (g) => contrast(GOOGLE_HEX[color], g) >= MIN_CONTRAST,
    );

    if (clears) expect(CALENDAR_HEX[color]).toBe(GOOGLE_HEX[color]);
  }
});

it("lifts the ones that vanish on navy — Blueberry and Grape among them", () => {
  // Measured, not assumed: both sit near 2.6:1 on the HUD's surface as Google
  // paints them.
  expect(contrast(GOOGLE_HEX.blueberry, hudPalette.surface)).toBeLessThan(MIN_CONTRAST);
  expect(contrast(GOOGLE_HEX.grape, hudPalette.surface)).toBeLessThan(MIN_CONTRAST);

  expect(CALENDAR_HEX.blueberry).not.toBe(GOOGLE_HEX.blueberry);
  expect(CALENDAR_HEX.grape).not.toBe(GOOGLE_HEX.grape);
});

it("lifts only as far as it has to", () => {
  // One step less and it would not clear.
  const lifted = lift(GOOGLE_HEX.blueberry, [hudPalette.surface]);

  expect(contrast(lifted, hudPalette.surface)).toBeGreaterThanOrEqual(MIN_CONTRAST);
  expect(contrast(lifted, hudPalette.surface)).toBeLessThan(MIN_CONTRAST + 0.3);
});

it("measures contrast the way WCAG does", () => {
  expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
  expect(contrast("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
});

it("draws a key it has never heard of in Graphite rather than as nothing", () => {
  expect(calendarHex("chartreuse")).toBe(CALENDAR_HEX.graphite);
  expect(calendarHex(null)).toBe(CALENDAR_HEX.graphite);
});
