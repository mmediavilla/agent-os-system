import { useEffect, useState } from "react";
import { errorMessage } from "../api";

/**
 * A settings tab's server half, read on arrival and shared by its sections.
 *
 * Not optimistic: each control is disabled while a write is out and the tab
 * redraws from the answer, as the Anthropic switch does — a setting that looked
 * saved and was not would be found out at 07:00 the next morning, or on the
 * next paid call. An error is kept beside the section whose write failed.
 *
 * Fitness → Settings and Assistant → Settings both use it; each passes its own
 * read and partial write.
 */
export function useServerSettings<State, Patch, Section extends string>(
  active: boolean,
  read: () => Promise<State>,
  write: (patch: Patch) => Promise<State>,
) {
  const [settings, setSettings] = useState<State | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ section: Section; message: string } | null>(null);

  useEffect(() => {
    if (!active) return;
    let live = true;
    read()
      .then((next) => {
        if (!live) return;
        setSettings(next);
        setLoadError(null);
      })
      .catch((e) => live && setLoadError(errorMessage(e)));
    return () => {
      live = false;
    };
    // Keyed on arrival only: `read` is an api call, a new function each render.
  }, [active]);

  const save = async (section: Section, patch: Patch) => {
    setSaving(true);
    setError(null);
    try {
      setSettings(await write(patch));
    } catch (e) {
      setError({ section, message: errorMessage(e) });
    } finally {
      setSaving(false);
    }
  };

  const errorFor = (section: Section) => (error?.section === section ? error.message : null);
  const setErrorFor = (section: Section, message: string | null) =>
    setError(message === null ? null : { section, message });

  return { settings, loadError, saving, save, errorFor, setErrorFor };
}
