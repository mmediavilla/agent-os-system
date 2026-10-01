import React, { createContext, useCallback, useContext, useMemo, useState } from "react";
import {
  DEFAULT_FITNESS_PREFS,
  FitnessPrefs,
  readStoredFitnessPrefs,
  writeStoredFitnessPrefs,
} from "./fitnessPrefs";

type FitnessPrefsContextValue = {
  prefs: FitnessPrefs;
  /** Changes one preference, leaving the rest alone. */
  setPref: <K extends keyof FitnessPrefs>(key: K, value: FitnessPrefs[K]) => void;
};

const FitnessPrefsContext = createContext<FitnessPrefsContextValue | null>(null);

/** localStorage, or null anywhere it doesn't exist (native, SSR). */
function webStorage(): Storage | null {
  return typeof localStorage === "undefined" ? null : localStorage;
}

export function FitnessPrefsProvider({ children }: { children: React.ReactNode }) {
  // Read on mount, so Home's first request already asks for the chosen range.
  const [prefs, setPrefs] = useState<FitnessPrefs>(() => readStoredFitnessPrefs(webStorage()));

  const setPref = useCallback(<K extends keyof FitnessPrefs>(key: K, value: FitnessPrefs[K]) => {
    setPrefs((prev) => {
      const next = { ...prev, [key]: value };
      writeStoredFitnessPrefs(webStorage(), next);
      return next;
    });
  }, []);

  const value = useMemo(() => ({ prefs, setPref }), [prefs, setPref]);

  return <FitnessPrefsContext.Provider value={value}>{children}</FitnessPrefsContext.Provider>;
}

/** The Fitness preferences. Falls back rather than throwing, as `useUnits` does. */
export function useFitnessPrefs(): FitnessPrefsContextValue {
  return useContext(FitnessPrefsContext) ?? FALLBACK;
}

const FALLBACK: FitnessPrefsContextValue = { prefs: DEFAULT_FITNESS_PREFS, setPref: () => {} };
