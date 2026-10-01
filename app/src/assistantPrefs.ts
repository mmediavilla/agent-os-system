/**
 * Assistant preferences that belong to this browser: how the chat opens and
 * whether it announces a reply, not what the server calls or spends.
 *
 * Built like `fitnessPrefs.ts` — free of React, validated field by field on the
 * way out of storage — because they are the same kind of thing: a choice about
 * what this screen shows, which nothing without a browser needs to see. What
 * the worker must read (the Anthropic switch) is a database row instead.
 */

export type OpenOn = "last" | "new";

/** In the order Assistant → Settings lists them. */
export const OPEN_ON: readonly OpenOn[] = ["last", "new"];

export const OPEN_ON_LABELS: Record<OpenOn, string> = {
  last: "Where you left off",
  new: "A new chat",
};

export const OPEN_ON_DESCRIPTIONS: Record<OpenOn, string> = {
  last: "The thread you were last in, spoken answers included.",
  new: "An empty thread each time. Earlier ones stay in the list beside it.",
};

export type AssistantPrefs = {
  /** Whether a reply nobody has seen lights the menu's Assistant title and the caption. */
  unreadSignal: boolean;
  /** What opening the Assistant lands on. */
  openOn: OpenOn;
};

export const DEFAULT_ASSISTANT_PREFS: AssistantPrefs = { unreadSignal: true, openOn: "last" };

/** Namespaced — localStorage is per origin. */
export const ASSISTANT_PREFS_STORAGE_KEY = "projectmc.assistant";

export function isOpenOn(value: unknown): value is OpenOn {
  return typeof value === "string" && (OPEN_ON as readonly string[]).includes(value);
}

/** The stored preferences, falling back per field for the reason `readStoredUnits` does. */
export function readStoredAssistantPrefs(
  storage: Pick<Storage, "getItem"> | null | undefined,
): AssistantPrefs {
  if (!storage) return DEFAULT_ASSISTANT_PREFS;
  try {
    const raw = storage.getItem(ASSISTANT_PREFS_STORAGE_KEY);
    if (!raw) return DEFAULT_ASSISTANT_PREFS;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return DEFAULT_ASSISTANT_PREFS;

    const record = parsed as Record<string, unknown>;
    return {
      unreadSignal:
        typeof record.unreadSignal === "boolean" ? record.unreadSignal : DEFAULT_ASSISTANT_PREFS.unreadSignal,
      openOn: isOpenOn(record.openOn) ? record.openOn : DEFAULT_ASSISTANT_PREFS.openOn,
    };
  } catch {
    return DEFAULT_ASSISTANT_PREFS;
  }
}

/** Persists the choices, ignoring storage failures — the choice just won't survive a reload. */
export function writeStoredAssistantPrefs(
  storage: Pick<Storage, "setItem"> | null | undefined,
  prefs: AssistantPrefs,
): void {
  if (!storage) return;
  try {
    storage.setItem(ASSISTANT_PREFS_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* not worth surfacing */
  }
}
