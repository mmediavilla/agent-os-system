import React, { createContext, useCallback, useContext, useMemo, useState } from "react";
import {
  AssistantPrefs,
  DEFAULT_ASSISTANT_PREFS,
  readStoredAssistantPrefs,
  writeStoredAssistantPrefs,
} from "./assistantPrefs";

type AssistantPrefsContextValue = {
  prefs: AssistantPrefs;
  /** Changes one preference, leaving the rest alone. */
  setPref: <K extends keyof AssistantPrefs>(key: K, value: AssistantPrefs[K]) => void;
};

const AssistantPrefsContext = createContext<AssistantPrefsContextValue | null>(null);

/** localStorage, or null anywhere it doesn't exist (native, SSR). */
function webStorage(): Storage | null {
  return typeof localStorage === "undefined" ? null : localStorage;
}

export function AssistantPrefsProvider({ children }: { children: React.ReactNode }) {
  const [prefs, setPrefs] = useState<AssistantPrefs>(() => readStoredAssistantPrefs(webStorage()));

  const setPref = useCallback(<K extends keyof AssistantPrefs>(key: K, value: AssistantPrefs[K]) => {
    setPrefs((prev) => {
      const next = { ...prev, [key]: value };
      writeStoredAssistantPrefs(webStorage(), next);
      return next;
    });
  }, []);

  const value = useMemo(() => ({ prefs, setPref }), [prefs, setPref]);

  return <AssistantPrefsContext.Provider value={value}>{children}</AssistantPrefsContext.Provider>;
}

/** The Assistant preferences. Falls back rather than throwing, as `useUnits` does. */
export function useAssistantPrefs(): AssistantPrefsContextValue {
  return useContext(AssistantPrefsContext) ?? FALLBACK;
}

const FALLBACK: AssistantPrefsContextValue = { prefs: DEFAULT_ASSISTANT_PREFS, setPref: () => {} };
