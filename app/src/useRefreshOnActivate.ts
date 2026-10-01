import { useEffect, useRef } from "react";

/**
 * Runs `onActivate` each time `active` flips false → true.
 *
 * Screens stay mounted across navigation (see App.tsx), which preserves form
 * state but also means the mount-time fetch never runs again. This restores the
 * refresh that used to come for free with a remount, without giving up the
 * preserved state. It deliberately does not fire on the initial render — screens
 * already load on mount, and firing here too would double every first request.
 */
export function useRefreshOnActivate(active: boolean, onActivate: () => void) {
  const wasActive = useRef(active);

  useEffect(() => {
    if (active && !wasActive.current) onActivate();
    wasActive.current = active;
  }, [active, onActivate]);
}
