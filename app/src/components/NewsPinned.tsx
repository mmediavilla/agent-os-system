import React, { useCallback, useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { PinnedArticle, api, errorMessage } from "../api";
import { colors, spacing, type } from "../theme";
import { SmallButton } from "./RecordsParts";
import { Card, since, statStyles } from "./StatParts";

/**
 * News → Pinned: the reading list, where the menu's "N unread" leads (19.4).
 *
 * A chip beside the beats rather than a group on an agent's card (the owner's call —
 * it was out of place there): the pins are stories, and this is the screen
 * they were pinned from.
 *
 * Unread first, each with **Open ↗**, **Mark read** and **Remove**; read ones
 * behind a toggle, each with **Reopen**. **Remove does not ask first** — a pin
 * is a bookmark, and the story can be pinned again while the server holds it.
 * Nothing is optimistic: every write re-reads the list before the buttons come
 * back, and one write is out at a time. Read on arrival — the chip mounts this
 * fresh each time it is picked — and never polled.
 */
export default function NewsPinned({ active }: { active: boolean }) {
  const [pins, setPins] = useState<PinnedArticle[] | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [showRead, setShowRead] = useState(false);

  const read = useCallback(async () => {
    try {
      setPins((await api.listPins()).data);
      setReadError(null);
    } catch (e) {
      setReadError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    if (active) read();
  }, [active, read]);

  const write = async (pinId: number, fn: () => Promise<unknown>) => {
    if (busy !== null) return;
    setBusy(pinId);
    setWriteError(null);
    try {
      await fn();
    } catch (e) {
      setWriteError(errorMessage(e));
    }
    await read();
    setBusy(null);
  };

  const unread = (pins ?? []).filter((p) => p.read_at === null);
  const done = (pins ?? []).filter((p) => p.read_at !== null);
  const error = writeError ?? readError;

  const row = (pin: PinnedArticle) => {
    const isRead = pin.read_at !== null;
    const locked = busy !== null;
    return (
      <View key={pin.id} style={[s.item, isRead && s.itemRead]} testID={`news-pinned-${pin.id}`}>
        <Text style={s.title}>{pin.title}</Text>
        <Text style={s.meta}>
          {[pin.source, `pinned ${since(pin.created_at)}`, isRead ? `read ${since(pin.read_at)}` : null]
            .filter(Boolean)
            .join(" · ")}
        </Text>
        {pin.summary && (
          <Text style={s.summary} numberOfLines={2}>
            {pin.summary}
          </Text>
        )}
        <View style={s.actions}>
          <SmallButton
            label="Open ↗"
            // A click, so a user gesture: the agenda's ↗ rule.
            onPress={() => window.open?.(pin.link, "_blank", "noopener")}
            disabled={false}
            testID={`news-pinned-${pin.id}-open`}
            accessibilityLabel={`Open ${pin.title}`}
          />
          {isRead ? (
            <SmallButton
              label={busy === pin.id ? "…" : "Reopen"}
              onPress={() => void write(pin.id, () => api.reopenPin(pin.id))}
              disabled={locked}
              testID={`news-pinned-${pin.id}-reopen`}
              accessibilityLabel={`Mark ${pin.title} unread`}
            />
          ) : (
            <SmallButton
              label={busy === pin.id ? "…" : "Mark read"}
              onPress={() => void write(pin.id, () => api.markPinRead(pin.id))}
              disabled={locked}
              testID={`news-pinned-${pin.id}-read`}
              accessibilityLabel={`Mark ${pin.title} read`}
            />
          )}
          <SmallButton
            label="Remove"
            tone={colors.error}
            onPress={() => void write(pin.id, () => api.unpinArticle(pin.id))}
            disabled={locked}
            testID={`news-pinned-${pin.id}-remove`}
            accessibilityLabel={`Remove ${pin.title} from the reading list`}
          />
        </View>
      </View>
    );
  };

  return (
    <Card
      testID="news-pinned"
      title="Pinned"
      right={pins === null ? undefined : unread.length > 0 ? `${unread.length} unread` : undefined}
      footnote={error ? { text: error, warn: true } : undefined}
      wide
    >
      {pins === null && !readError && <Text style={s.empty}>Reading…</Text>}

      {pins !== null && unread.length === 0 && (
        <Text style={s.empty} testID="news-pinned-empty">
          {done.length > 0
            ? "Everything pinned has been read."
            : "Nothing pinned. Pin a story from any beat, or ask the assistant to."}
        </Text>
      )}

      {unread.map(row)}

      {done.length > 0 && (
        <View style={s.actions}>
          <SmallButton
            label={showRead ? "Hide read" : `Show ${done.length} read`}
            onPress={() => setShowRead((v) => !v)}
            disabled={false}
            testID="news-pinned-toggle"
            accessibilityLabel={showRead ? "Hide read pins" : "Show read pins"}
          />
        </View>
      )}

      {showRead && done.map(row)}
    </Card>
  );
}

const s = {
  ...statStyles,
  ...StyleSheet.create({
    empty: { ...type.small, color: colors.textDim },
    item: {
      gap: 2,
      paddingVertical: spacing.sm,
      borderTopWidth: 1,
      borderTopColor: colors.border,
    },
    itemRead: { opacity: 0.7 },
    title: { ...type.body, color: colors.text, fontWeight: "600" },
    meta: { ...type.caption, color: colors.textDim },
    summary: { ...type.small, color: colors.textMuted },
    actions: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs, marginTop: spacing.xs },
  }),
};
