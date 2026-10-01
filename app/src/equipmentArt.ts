/**
 * Default illustrations for equipment that has no uploaded photo.
 *
 * An item either pins one of these (`thumbnail` on the record) or leaves the
 * choice to its name and category. Pinning is what makes the drawing editable
 * without inventing a second kind of image: the stored value is the key of a
 * drawing, never a file, so an item with a thumbnail still has no photo.
 *
 * These are drawn, not stored: each one is an SVG built here and handed to
 * `<Image>` as a data URI. Nothing is added to the API, the `equipment` table
 * or the photo endpoints, so a default can never be mistaken for a real photo
 * — `image_url` stays null until someone actually uploads one, and every
 * "has a photo?" check in the app and the backend keeps its old answer.
 *
 * ── Why the colors are hardcoded rather than theme tokens ────────────────────
 * A data-URI SVG in an <img> is its own document: it cannot see the page's CSS
 * custom properties, so `var(--c-textMuted)` would resolve to nothing. Passing
 * the active palette in would mean threading ThemeProvider through every call
 * site and rebuilding the URI on every theme flip. Instead the two colors below
 * are picked to read on both grounds — slate-500 and indigo-500 clear 3.5:1
 * against `bg` in the light *and* the dark palette — so one drawing serves both
 * themes and stays a pure, cacheable function of (name, type).
 */

/** The illustrations that exist, keyed by what each one depicts. */
export type EquipmentArt =
  | "barbell"
  | "dumbbell"
  | "kettlebell"
  | "plate"
  | "bench"
  | "rack"
  | "pullup"
  | "treadmill"
  | "bike"
  | "rower"
  | "cable"
  | "machine"
  | "band"
  | "mat"
  | "rope"
  | "duffel";

const INK = "#64748b"; // slate-500 — structure: frames, posts, rails
const ACCENT = "#6366f1"; // indigo-500 — the working part: the weight, the pad, the handle

/**
 * Words in an item's name that pin down a specific drawing, most specific
 * first. Order is load-bearing: "Smith Machine" has to reach `rack` before
 * `machine` sees it, and "Bench Press" has to reach `bench` before `press`
 * sends it to `machine`.
 *
 * Matching is on whole words (see `normalize`), so "Mat" cannot fire on
 * "Matrix" and "Dip" cannot fire on "Dipping Belt"… which is a machine we do
 * not draw anyway, and lands on the type's default like anything else unknown.
 */
const NAME_KEYWORDS: readonly (readonly [EquipmentArt, readonly string[]])[] = [
  ["kettlebell", ["kettlebell", "kettle bell"]],
  ["dumbbell", ["dumbbell", "dumb bell"]],
  ["barbell", ["barbell", "bar bell", "ez bar", "ez curl bar", "curl bar", "trap bar", "hex bar", "olympic bar", "safety squat bar"]],
  ["plate", ["plate", "bumper", "disc"]],
  ["bench", ["bench"]],
  ["rack", ["rack", "cage", "smith"]],
  ["pullup", ["pull up", "pullup", "chin up", "chinup", "dip", "ring", "parallette", "push up", "pushup"]],
  ["treadmill", ["treadmill", "stair", "stepper", "climber"]],
  ["bike", ["bike", "bicycle", "cycle", "spin", "elliptical"]],
  ["rower", ["rower", "rowing", "erg", "ergometer", "skierg", "ski erg"]],
  ["cable", ["cable", "pulley", "pulldown", "pull down", "crossover", "functional trainer", "lat tower"]],
  ["band", ["band", "tube"]],
  ["rope", ["rope"]],
  ["mat", ["mat", "roller"]],
  ["machine", ["machine", "press", "sled", "trainer"]],
];

/**
 * The drawing to fall back on per `equipment_type`. The type is free text on
 * the API, so this is a lookup with a default rather than an exhaustive map —
 * a category added to EQUIPMENT_TYPES without an entry here simply gets the
 * duffel, which is the point of having one.
 */
const TYPE_ART: Readonly<Record<string, EquipmentArt>> = {
  "free weight": "dumbbell",
  machine: "machine",
  cable: "cable",
  bodyweight: "pullup",
  cardio: "treadmill",
  band: "band",
  accessory: "duffel",
  other: "duffel",
};

/** Where anything unrecognised ends up. */
const FALLBACK_ART: EquipmentArt = "duffel";

/**
 * Crude singular. Enough to let "Plates" and "Rings" match the singular
 * keywords without pulling in a stemmer; the "ss" guard is what keeps "press"
 * from becoming "pres".
 */
function singular(word: string): string {
  return word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word;
}

/**
 * A name reduced to space-delimited singular words, padded with spaces at both
 * ends. The padding is what makes `includes(" mat ")` a whole-word test, and
 * flattening punctuation is what makes "pull-up" and "pull up" the same thing.
 */
function normalize(value: string): string {
  const words = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map(singular);

  return ` ${words.join(" ")} `;
}

/**
 * Whether a stored value names a drawing that exists. `hasOwnProperty` rather
 * than `in`, or "toString" and "constructor" would come back as drawings.
 */
export function isEquipmentArt(value: unknown): value is EquipmentArt {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(ART, value);
}

/**
 * Which drawing an item gets.
 *
 * A pinned `thumbnail` wins outright — someone chose it, and no rename should
 * move them off it. Failing that the name decides, because "Treadmill" says
 * more than "Cardio"; then the category; then the duffel.
 *
 * An unrecognised `thumbnail` falls through to the derived pick rather than
 * drawing nothing, so a key retired from this file leaves old rows looking
 * reasonable instead of blank.
 */
export function equipmentArtFor(
  name: string,
  equipmentType: string,
  thumbnail?: string | null,
): EquipmentArt {
  if (isEquipmentArt(thumbnail)) return thumbnail;

  const haystack = normalize(name);

  for (const [art, keywords] of NAME_KEYWORDS) {
    if (keywords.some((keyword) => haystack.includes(` ${keyword} `))) return art;
  }

  return TYPE_ART[equipmentType.trim().toLowerCase()] ?? FALLBACK_ART;
}

/**
 * The drawings themselves, on a 64×64 grid with roughly 6 units of margin so
 * they still breathe inside a 44px row thumbnail. Strokes are round-capped and
 * 3–4.5 wide: thinner hairlines disappear at that size.
 */
const ART: Readonly<Record<EquipmentArt, string>> = {
  // Two plates a side, and a bar that runs past them: without both, this and
  // the dumbbell come out as the same drawing at 44px.
  barbell: `
    <path d="M4 32h56" stroke="${INK}" stroke-width="3"/>
    <rect x="10" y="16" width="6" height="32" rx="3" fill="${ACCENT}"/>
    <rect x="19" y="21" width="6" height="22" rx="3" fill="${ACCENT}"/>
    <rect x="39" y="21" width="6" height="22" rx="3" fill="${ACCENT}"/>
    <rect x="48" y="16" width="6" height="32" rx="3" fill="${ACCENT}"/>`,

  dumbbell: `
    <path d="M18 32h28" stroke="${INK}" stroke-width="4"/>
    <rect x="9" y="19" width="10" height="26" rx="5" fill="${ACCENT}"/>
    <rect x="45" y="19" width="10" height="26" rx="5" fill="${ACCENT}"/>
    <rect x="4" y="24" width="5" height="16" rx="2.5" fill="${INK}"/>
    <rect x="55" y="24" width="5" height="16" rx="2.5" fill="${INK}"/>`,

  kettlebell: `
    <path d="M23 29a9 9 0 0 1 18 0" stroke="${INK}" stroke-width="4"/>
    <rect x="25" y="28" width="14" height="12" rx="4" fill="${ACCENT}"/>
    <circle cx="32" cy="43" r="13" fill="${ACCENT}"/>`,

  plate: `
    <circle cx="32" cy="32" r="20" stroke="${INK}" stroke-width="4"/>
    <circle cx="32" cy="32" r="7" fill="${ACCENT}"/>`,

  bench: `
    <rect x="8" y="22" width="48" height="9" rx="4.5" fill="${ACCENT}"/>
    <path d="M18 31 12 50M46 31 52 50M8 50h12M44 50h12" stroke="${INK}" stroke-width="3"/>`,

  rack: `
    <path d="M16 12v40M48 12v40M16 12h32M8 52h48" stroke="${INK}" stroke-width="3.5"/>
    <path d="M10 26h44" stroke="${ACCENT}" stroke-width="4.5"/>`,

  pullup: `
    <path d="M12 16h40" stroke="${ACCENT}" stroke-width="4.5"/>
    <path d="M18 16v34M46 16v34M10 50h16M38 50h16" stroke="${INK}" stroke-width="3"/>`,

  // A console, not a handlebar, and no wheels: a raised deck on two wheels is
  // a kick scooter, which is what the first draft of this drew.
  treadmill: `
    <rect x="6" y="38" width="40" height="9" rx="4.5" fill="${ACCENT}"/>
    <path d="M6 51h40M44 43 50 21" stroke="${INK}" stroke-width="3.5"/>
    <rect x="40" y="8" width="18" height="13" rx="3" stroke="${INK}" stroke-width="3"/>`,

  bike: `
    <circle cx="15" cy="42" r="10" stroke="${INK}" stroke-width="3.5"/>
    <circle cx="49" cy="42" r="10" stroke="${INK}" stroke-width="3.5"/>
    <path d="M15 42 26 24h14l9 18" stroke="${ACCENT}" stroke-width="3.5"/>
    <path d="M22 22h9M38 20h10" stroke="${INK}" stroke-width="3"/>`,

  // The flywheel reads as a fan housing sitting on the rail, not as a loose
  // circle: a bare ring at one end of a line looked like a key, not a machine.
  rower: `
    <rect x="8" y="16" width="18" height="24" rx="5" stroke="${INK}" stroke-width="3"/>
    <path d="M8 48h48" stroke="${INK}" stroke-width="4"/>
    <path d="M26 28h14" stroke="${ACCENT}" stroke-width="3"/>
    <path d="M42 22v12" stroke="${ACCENT}" stroke-width="4"/>
    <rect x="28" y="40" width="16" height="7" rx="3.5" fill="${ACCENT}"/>`,

  cable: `
    <path d="M30 10v44M30 12h18M6 54h52" stroke="${INK}" stroke-width="3.5"/>
    <circle cx="48" cy="17" r="5" stroke="${INK}" stroke-width="3"/>
    <rect x="8" y="22" width="16" height="28" rx="3" stroke="${INK}" stroke-width="3"/>
    <path d="M48 22v10" stroke="${ACCENT}" stroke-width="3"/>
    <path d="M41 33h14" stroke="${ACCENT}" stroke-width="4.5"/>
    <path d="M12 30h8M12 38h8M12 46h8" stroke="${ACCENT}" stroke-width="2.5"/>`,

  machine: `
    <path d="M8 54h48M36 12v42M30 30 36 26" stroke="${INK}" stroke-width="3.5"/>
    <rect x="40" y="20" width="14" height="26" rx="3" stroke="${INK}" stroke-width="3"/>
    <path d="M43 28h8M43 36h8" stroke="${ACCENT}" stroke-width="2.5"/>
    <rect x="10" y="36" width="20" height="7" rx="3.5" fill="${ACCENT}"/>
    <rect x="10" y="18" width="7" height="19" rx="3.5" fill="${ACCENT}"/>`,

  band: `
    <ellipse cx="32" cy="32" rx="22" ry="11" stroke="${ACCENT}" stroke-width="4.5"/>
    <rect x="4" y="24" width="6" height="16" rx="3" fill="${INK}"/>
    <rect x="54" y="24" width="6" height="16" rx="3" fill="${INK}"/>`,

  // Rolled, seen end-on. Drawn flat with a disc on one end it came out as an
  // iOS toggle switch, which is not a thing anyone trains with.
  mat: `
    <rect x="12" y="22" width="38" height="20" fill="${ACCENT}"/>
    <ellipse cx="12" cy="32" rx="6" ry="10" fill="${ACCENT}"/>
    <ellipse cx="50" cy="32" rx="7" ry="11" fill="${ACCENT}" stroke="${INK}" stroke-width="3"/>
    <circle cx="50" cy="32" r="3" fill="${INK}"/>`,

  rope: `
    <path d="M6 24q6.5-9 13 0t13 0t13 0t13 0" stroke="${INK}" stroke-width="4"/>
    <path d="M6 40q6.5-9 13 0t13 0t13 0t13 0" stroke="${ACCENT}" stroke-width="4"/>`,

  duffel: `
    <rect x="7" y="26" width="50" height="25" rx="9" stroke="${INK}" stroke-width="3"/>
    <path d="M24 26v-4a5 5 0 0 1 5-5h6a5 5 0 0 1 5 5v4" stroke="${INK}" stroke-width="3"/>
    <rect x="26" y="28" width="12" height="21" fill="${ACCENT}"/>`,
};

/**
 * Every drawing there is, in the order ART declares them — heaviest first,
 * bag last, which is the order the picker offers them in.
 */
export const EQUIPMENT_ARTS = Object.keys(ART) as readonly EquipmentArt[];

/**
 * What to call each drawing in the picker. The key is what a drawing depicts,
 * which is not always what a user would call it ("pullup" covers rings and
 * parallettes, "duffel" is the catch-all), so the labels are written for the
 * person choosing rather than derived from the key.
 */
export const EQUIPMENT_ART_LABELS: Readonly<Record<EquipmentArt, string>> = {
  barbell: "Barbell",
  dumbbell: "Dumbbell",
  kettlebell: "Kettlebell",
  plate: "Plates",
  bench: "Bench",
  rack: "Rack",
  pullup: "Bar & rings",
  treadmill: "Treadmill",
  bike: "Bike",
  rower: "Rower",
  cable: "Cable",
  machine: "Machine",
  band: "Bands",
  mat: "Mat",
  rope: "Rope",
  duffel: "Gym bag",
};

/** The finished SVG for one drawing. Exported for tests; screens want the URI. */
export function equipmentArtSvg(art: EquipmentArt): string {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none" ' +
    `stroke-linecap="round" stroke-linejoin="round">${ART[art]}</svg>`
  ).replace(/\s+/g, " ");
}

/**
 * A data URI for the drawing this item should get — what `<Image source>`
 * takes. Percent-encoded rather than base64: the payload stays readable in
 * devtools and skips a btoa/Buffer split between web and native.
 */
export function defaultEquipmentImage(
  name: string,
  equipmentType: string,
  thumbnail?: string | null,
): string {
  return equipmentArtImage(equipmentArtFor(name, equipmentType, thumbnail));
}

/** The same URI for a drawing named outright — what the thumbnail picker shows. */
export function equipmentArtImage(art: EquipmentArt): string {
  return `data:image/svg+xml,${encodeURIComponent(equipmentArtSvg(art))}`;
}
