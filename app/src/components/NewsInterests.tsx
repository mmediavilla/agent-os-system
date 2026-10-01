import React, { useCallback, useEffect, useState } from "react";
import { StyleSheet, Text, TextInput } from "react-native";
import { NewsSettings, api, errorMessage } from "../api";
import { colors, radii, spacing, type } from "../theme";
import { Card, statStyles } from "./StatParts";

/**
 * News → Interests' editor: the topics `get_news` searches for "interests",
 * one per line (19.4).
 *
 * **Here, not on an agent's card** (the owner's call): an interest is a search topic
 * for this screen, not something about an agent, and not a fact — facts are
 * claims about the owner read on every turn, while these are only ever
 * searched. The stories they find are the list under this card.
 *
 * **A draft committed on blur**, resynced from the stored list *and* a write
 * counter (`AutomationsView`'s pair), so a refused list is pulled back rather
 * than left looking saved. Blank lines are dropped here and again by the
 * server; too many, or one too long, is the server's 422 sentence on the
 * card, never a silent cut. An emptied list is sent — no interests is a real
 * answer. Nothing is optimistic, and the field is locked while its write is
 * out. `onSaved` lets the list below re-read what the new topics find.
 */
export default function NewsInterests({ active, onSaved }: { active: boolean; onSaved: () => void }) {
  const [settings, setSettings] = useState<NewsSettings | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [written, setWritten] = useState(0);

  const read = useCallback(async () => {
    try {
      setSettings(await api.getNewsSettings());
      setReadError(null);
    } catch (e) {
      setReadError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    if (active) read();
  }, [active, read]);

  const stored = settings?.interests.join("\n") ?? "";
  const [draft, setDraft] = useState(stored);
  useEffect(() => setDraft(stored), [stored, written]);

  const commit = async () => {
    if (settings === null || busy) return;
    const lines = draft
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
    if (lines.join("\n") === stored) {
      setDraft(stored);
      return;
    }

    setBusy(true);
    setWriteError(null);
    try {
      setSettings(await api.updateNewsSettings(lines));
      onSaved();
    } catch (e) {
      setWriteError(errorMessage(e));
      await read();
    } finally {
      setWritten((v) => v + 1);
      setBusy(false);
    }
  };

  const error = writeError ?? readError;

  return (
    <Card
      testID="news-interests"
      // Not "Your interests": that is the server's label for the stories below.
      title="Topics you follow"
      right={settings ? `${settings.interests.length} of ${settings.max}` : undefined}
      footnote={error ? { text: error, warn: true } : undefined}
      wide
    >
      <TextInput
        value={draft}
        onChangeText={setDraft}
        onBlur={commit}
        multiline
        numberOfLines={3}
        editable={!busy && settings !== null}
        placeholder="One topic per line — Formula 1, Nintendo Switch, Philippine basketball."
        placeholderTextColor={colors.textDim}
        accessibilityLabel="News interests"
        style={s.input}
        testID="news-interests-input"
      />
      <Text style={s.desc}>
        {settings === null
          ? "Reading…"
          : `One per line, each up to ${settings.max_chars} characters. Saved when you click away, and searched below.`}
      </Text>
    </Card>
  );
}

const s = {
  ...statStyles,
  ...StyleSheet.create({
    desc: { ...type.caption, color: colors.textDim },
    input: {
      minHeight: 72,
      textAlignVertical: "top",
      fontSize: 13,
      color: colors.text,
      backgroundColor: colors.bg,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: radii.md,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
    },
  }),
};
