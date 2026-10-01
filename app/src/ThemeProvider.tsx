import React, { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState } from "react";
import { Accent, readStoredAccent, writeStoredAccent } from "./accent";

type ThemeContextValue = {
  /** The theme colour. */
  accent: Accent;
  setAccent: (accent: Accent) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

/** localStorage, or null anywhere it doesn't exist (native, SSR). */
function webStorage(): Storage | null {
  return typeof localStorage === "undefined" ? null : localStorage;
}

/**
 * The theme colour, stamped on <html> as `data-accent` for the stylesheet.
 *
 * It also held a Light/Dark/System mode, stamped as `data-theme`, until the app
 * became one palette (see `theme.ts`). A `projectmc.appearance` key left in
 * someone's localStorage by then is read by nothing.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Read once, on mount, rather than in an effect, which would render one frame
  // of the default first.
  const [accent, setAccentState] = useState<Accent>(() => readStoredAccent(webStorage()));

  // A layout effect, so the first paint is already in the chosen colour.
  useLayoutEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.setAttribute("data-accent", accent);
  }, [accent]);

  const setAccent = useCallback((next: Accent) => {
    setAccentState(next);
    writeStoredAccent(webStorage(), next);
  }, []);

  const value = useMemo(() => ({ accent, setAccent }), [accent, setAccent]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/** The theme colour setting. Throws outside a ThemeProvider rather than guessing. */
export function useAccent(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useAccent must be used inside a ThemeProvider");
  return ctx;
}
