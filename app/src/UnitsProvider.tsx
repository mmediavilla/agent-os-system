import React, { createContext, useCallback, useContext, useMemo, useState } from "react";
import {
  DEFAULT_UNITS,
  UnitDimension,
  UnitPrefs,
  readStoredUnits,
  writeStoredUnits,
} from "./units";

type UnitsContextValue = {
  units: UnitPrefs;
  /** Changes one dimension, leaving the other two alone. */
  setUnit: <D extends UnitDimension>(dimension: D, unit: UnitPrefs[D]) => void;
};

const UnitsContext = createContext<UnitsContextValue | null>(null);

/** localStorage, or null anywhere it doesn't exist (native, SSR). */
function webStorage(): Storage | null {
  return typeof localStorage === "undefined" ? null : localStorage;
}

export function UnitsProvider({ children }: { children: React.ReactNode }) {
  // Read on mount rather than in an effect, so nothing renders a frame of
  // kilograms at someone who logs in pounds.
  const [units, setUnits] = useState<UnitPrefs>(() => readStoredUnits(webStorage()));

  const setUnit = useCallback(
    <D extends UnitDimension>(dimension: D, unit: UnitPrefs[D]) => {
      setUnits((prev) => {
        const next = { ...prev, [dimension]: unit };
        writeStoredUnits(webStorage(), next);
        return next;
      });
    },
    [],
  );

  const value = useMemo(() => ({ units, setUnit }), [units, setUnit]);

  return <UnitsContext.Provider value={value}>{children}</UnitsContext.Provider>;
}

/**
 * The unit preferences.
 *
 * Unlike `useAccent`, this falls back instead of throwing when there is no
 * provider: every stored value is already canonical, so the fallback renders
 * the raw numbers rather than crashing. Setting a unit without a provider is
 * then a no-op, which is the honest answer — there is nowhere to keep it.
 */
export function useUnits(): UnitsContextValue {
  const ctx = useContext(UnitsContext);
  return ctx ?? FALLBACK;
}

const FALLBACK: UnitsContextValue = { units: DEFAULT_UNITS, setUnit: () => {} };
