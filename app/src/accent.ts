/**
 * The theme colour: which accent the app is drawn in.
 *
 * Kept free of React and of the DOM, so the rules are testable on their own.
 * The colours behind each choice live in `theme.ts` beside the palette they
 * override; this file is only the choice.
 *
 * **Why these four.** The segment core's design ships with one knob,
 * `--hud-accent`, and three variants beside its green default: blue, orange and
 * violet. Mint, azure and violet are those, and `classic` is the HUD's cyan, so
 * choosing nothing changes nothing.
 *
 * **Why no orange or red**, though the design offers orange: in this app amber
 * means the assistant is waiting for you (or switched off) and red means it
 * failed, and both are drawn by tinting the core. An orange accent would make an
 * idle core and a switched-off one the same colour turning at the same pace.
 */

export type Accent = "classic" | "mint" | "azure" | "violet";

export const ACCENTS: readonly Accent[] = ["classic", "mint", "azure", "violet"] as const;

export const ACCENT_LABELS: Record<Accent, string> = {
  classic: "Classic",
  mint: "Mint",
  azure: "Azure",
  violet: "Violet",
};

/** Where the choice is persisted. Namespaced — localStorage is shared per origin. */
export const ACCENT_STORAGE_KEY = "projectmc.accent";

export function isAccent(value: unknown): value is Accent {
  return typeof value === "string" && (ACCENTS as readonly string[]).includes(value);
}

/**
 * The stored choice, or `classic` when there is nothing usable to read. Validated
 * rather than trusted — anything can end up in localStorage — and wrapped,
 * because Safari's private mode throws on access.
 */
export function readStoredAccent(storage: Pick<Storage, "getItem"> | null | undefined): Accent {
  if (!storage) return "classic";
  try {
    const raw = storage.getItem(ACCENT_STORAGE_KEY);
    return isAccent(raw) ? raw : "classic";
  } catch {
    return "classic";
  }
}

export function writeStoredAccent(
  storage: Pick<Storage, "setItem"> | null | undefined,
  accent: Accent,
): void {
  if (!storage) return;
  try {
    storage.setItem(ACCENT_STORAGE_KEY, accent);
  } catch {
    /* not worth surfacing — the choice just won't survive a reload */
  }
}
