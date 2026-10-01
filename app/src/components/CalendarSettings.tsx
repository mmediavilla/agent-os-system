import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import ConfirmDialog from "./ConfirmDialog";
import { CALENDAR_COLORS, CalendarColor, CalendarFeed, CalendarFeedPatch, api, errorMessage } from "../api";
import { feedName } from "../calendar";
import { COLOR_LABELS, calendarHex } from "../calendarColors";
import * as fmt from "../hudFormat";
import { colors, radii, spacing } from "../theme";

/**
 * Settings → Calendars: the calendars the agenda panel reads — Google, iCloud,
 * or anything else that publishes an iCal address.
 *
 * **Connected by pasting each calendar's iCal address** — no sign-in, no OAuth
 * consent, no developer project. Google calls it the secret address, iCloud its
 * public calendar link; either way the address is a bearer credential for that
 * one calendar, so it is treated as one: it goes in here once, the server
 * stores it encrypted, and **nothing ever shows it again** — not this list, not
 * an error. Changing it is removing the calendar and adding the new address,
 * which is also what a provider's "reset" or "stop sharing" asks of every
 * other client.
 *
 * Why this is not Google-only: a calendar the user *subscribes to* inside
 * Google — iCloud's, typically — has no secret address in Google at all, so it
 * can only be read from where it lives. Google Calendar stays the place they
 * look at everything, which is why the colours are still Google's eleven.
 *
 * The name is read off the feed rather than typed, and the colour is the first
 * of Google's eleven that no other calendar is using yet — so the form is one
 * field and one button, and anything else is changed on the row afterwards.
 *
 * **Adding is slow on purpose.** The server fetches the address before it saves
 * anything, so a mistyped or reset one is a sentence under the field rather
 * than a calendar that is unreachable forever. The button says "Checking…"
 * for that second, because a button that does nothing for a second reads as
 * broken.
 *
 * Read only while Settings is open (`active`). The overlay stays mounted while
 * shut, and a list loaded when the HUD first drew would be stale the first time
 * anyone looked at it.
 */
/**
 * Where each provider keeps the address, in its own words.
 *
 * iCloud is second because a calendar subscribed to inside Google has no
 * secret address there — the iCloud link has to come from iCloud. Its link is
 * "public" in Apple's word only: it is unlisted, and works for whoever holds it,
 * exactly as Google's secret one does.
 */
const HOW_TO: [string, string][] = [
  ["Google Calendar", 'Settings → the calendar → Integrate calendar → "Secret address in iCal format".'],
  ["iCloud", "In Calendar, share the calendar → turn on Public Calendar → copy the webcal:// link."],
  ["Outlook", "Settings → Calendar → Shared calendars → Publish a calendar → the ICS link."],
];

export default function CalendarSettings({
  active = true,
  onChanged,
}: {
  active?: boolean;
  /** Called after anything here changes what the agenda would show. */
  onChanged?: () => void;
}) {
  const [feeds, setFeeds] = useState<CalendarFeed[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [url, setUrl] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  // Which row has a request in flight, and the last thing a row failed at.
  const [busy, setBusy] = useState<number | null>(null);
  const [rowError, setRowError] = useState<{ id: number; message: string } | null>(null);

  const [removing, setRemoving] = useState<CalendarFeed | null>(null);

  const load = useCallback(async () => {
    try {
      setFeeds((await api.listCalendarFeeds()).data);
      setLoadError(null);
    } catch (e) {
      setLoadError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    if (active) load();
  }, [active, load]);

  const add = async () => {
    const address = url.trim();
    if (!address || adding) return;

    setAdding(true);
    setAddError(null);
    try {
      const feed = await api.addCalendarFeed(address);
      setFeeds((prev) => [...(prev ?? []), feed]);
      // Cleared the moment it is stored: the address is not something this
      // screen holds on to, even in a text box.
      setUrl("");
      onChanged?.();
    } catch (e) {
      // A 422 is a sentence written for this field — a wrong host, a reset
      // address, a calendar that is already here. The address stays in the box
      // so it can be corrected rather than pasted again.
      setAddError(errorMessage(e));
    } finally {
      setAdding(false);
    }
  };

  const update = async (feed: CalendarFeed, patch: CalendarFeedPatch) => {
    setBusy(feed.id);
    setRowError(null);
    try {
      const next = await api.updateCalendarFeed(feed.id, patch);
      setFeeds((prev) => (prev ?? []).map((f) => (f.id === next.id ? next : f)));
      onChanged?.();
    } catch (e) {
      setRowError({ id: feed.id, message: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    const feed = removing;
    if (!feed) return;

    setBusy(feed.id);
    setRowError(null);
    try {
      await api.removeCalendarFeed(feed.id);
      setFeeds((prev) => (prev ?? []).filter((f) => f.id !== feed.id));
      onChanged?.();
    } catch (e) {
      setRowError({ id: feed.id, message: errorMessage(e) });
    } finally {
      setBusy(null);
      setRemoving(null);
    }
  };

  return (
    <>
      {feeds === null && !loadError && <ActivityIndicator color={colors.accent} />}
      {loadError && <Text style={s.error}>{loadError}</Text>}

      {feeds && feeds.length > 0 && (
        <View style={s.card} testID="calendar-feeds">
          {feeds.map((feed, i) => (
            <FeedRow
              key={feed.id}
              feed={feed}
              divided={i > 0}
              busy={busy === feed.id}
              error={rowError?.id === feed.id ? rowError.message : null}
              onToggle={(enabled) => update(feed, { enabled })}
              onColor={(color) => update(feed, { color })}
              onRemove={() => setRemoving(feed)}
            />
          ))}
        </View>
      )}

      <View style={s.card}>
        <View style={s.addRow}>
          <TextInput
            value={url}
            onChangeText={(text) => {
              setUrl(text);
              setAddError(null);
            }}
            onSubmitEditing={add}
            placeholder="https://… or webcal://… — the calendar's iCal address"
            placeholderTextColor={colors.textDim}
            autoCapitalize="none"
            autoCorrect={false}
            // Not a password field, though it is a secret: browsers offer to
            // save anything typed into one, and this is not a login.
            autoComplete="off"
            editable={!adding}
            accessibilityLabel="Calendar's iCal address"
            style={s.input}
            testID="calendar-url"
          />
          <Pressable
            onPress={add}
            disabled={adding || !url.trim()}
            accessibilityRole="button"
            accessibilityState={{ disabled: adding || !url.trim(), busy: adding }}
            style={({ hovered }: any) => [
              s.addBtn,
              (adding || !url.trim()) && s.addBtnDisabled,
              hovered && !adding && url.trim() && s.addBtnHovered,
            ]}
            testID="calendar-add"
          >
            <Text style={s.addBtnText}>{adding ? "Checking…" : "Add calendar"}</Text>
          </Pressable>
        </View>
        {addError && <Text style={[s.error, s.addError]}>{addError}</Text>}
      </View>

      <View style={s.howTo} testID="calendar-how-to">
        {HOW_TO.map(([where, steps]) => (
          <Text key={where} style={s.footnote}>
            <Text style={s.footnoteWhere}>{where}: </Text>
            {steps}
          </Text>
        ))}
        <Text style={s.footnote}>
          Anyone holding the address can read the calendar, so it is stored
          encrypted and never shown again. The HUD reads it every few minutes;
          events are added and changed in the calendar's own app.
        </Text>
      </View>

      <ConfirmDialog
        visible={removing !== null}
        title={`Remove ${removing ? feedName(removing) : "calendar"}?`}
        message="Its events leave the agenda. The calendar itself is untouched where it lives — adding it back needs its address again."
        confirmLabel="Remove"
        loading={removing !== null && busy === removing.id}
        onConfirm={remove}
        onCancel={() => setRemoving(null)}
      />
    </>
  );
}

function FeedRow({
  feed,
  divided,
  busy,
  error,
  onToggle,
  onColor,
  onRemove,
}: {
  feed: CalendarFeed;
  divided: boolean;
  busy: boolean;
  error: string | null;
  onToggle: (enabled: boolean) => void;
  onColor: (color: CalendarColor) => void;
  onRemove: () => void;
}) {
  const name = feedName(feed);

  return (
    <View style={[s.row, divided && s.rowDivided]} testID={`calendar-feed-${feed.id}`}>
      <View style={s.rowHead}>
        <View style={[s.dot, { backgroundColor: calendarHex(feed.color) }]} />
        <View style={s.rowText}>
          <Text style={[s.name, !feed.enabled && s.nameOff]} numberOfLines={1}>
            {name}
          </Text>
          <Text style={[s.status, feed.enabled && feed.status === "failed" && s.statusFailed]}>
            {feedStatus(feed)}
          </Text>
        </View>
        <Switch
          value={feed.enabled}
          disabled={busy}
          onValueChange={onToggle}
          accessibilityLabel={`Show ${name} on the agenda`}
          trackColor={{ true: colors.accent, false: colors.borderHi }}
          testID={`calendar-toggle-${feed.id}`}
        />
      </View>

      <View style={s.rowFoot}>
        <View style={s.swatches} accessibilityRole="radiogroup" accessibilityLabel={`${name} colour`}>
          {CALENDAR_COLORS.map((color) => {
            const selected = feed.color === color;

            return (
              <Pressable
                key={color}
                onPress={() => !selected && onColor(color)}
                disabled={busy}
                accessibilityRole="radio"
                accessibilityLabel={COLOR_LABELS[color]}
                accessibilityState={{ selected, checked: selected, disabled: busy }}
                aria-checked={selected}
                style={[s.swatchRing, selected && s.swatchRingSelected]}
                testID={`calendar-color-${feed.id}-${color}`}
              >
                <View style={[s.swatch, { backgroundColor: calendarHex(color) }]} />
              </Pressable>
            );
          })}
        </View>

        <Pressable
          onPress={onRemove}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel={`Remove ${name}`}
          style={({ hovered }: any) => [s.remove, hovered && s.removeHovered]}
          testID={`calendar-remove-${feed.id}`}
        >
          <Text style={s.removeText}>Remove</Text>
        </Pressable>
      </View>

      {error && <Text style={s.error}>{error}</Text>}
    </View>
  );
}

/**
 * One line of what is true about a calendar, in the order that matters.
 *
 * Switched off outranks a failure, because a calendar nobody is asking about
 * has no business reporting how the last ask went. A failure is the server's
 * own sentence — it names what to do, and never quotes the address.
 */
export function feedStatus(feed: CalendarFeed, now: Date = new Date()): string {
  if (!feed.enabled) return "Switched off — not on the agenda.";
  if (feed.status === "failed") return feed.message ?? "This calendar could not be read.";
  if (feed.status === "pending" || !feed.fetched_at) return "Not read yet.";

  const read = `Read ${fmt.age((now.getTime() - Date.parse(feed.fetched_at)) / 1000)}.`;

  if (feed.skipped === 0) return read;

  return `${read} ${feed.skipped} ${feed.skipped === 1 ? "event" : "events"} in it could not be read.`;
}

const s = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.lg,
    overflow: "hidden",
  },

  row: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md, gap: spacing.sm },
  rowDivided: { borderTopWidth: 1, borderTopColor: colors.border },
  rowHead: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  rowText: { flex: 1, gap: 2 },
  name: { fontSize: 15, fontWeight: "500", color: colors.text },
  nameOff: { color: colors.textMuted },
  status: { fontSize: 13, color: colors.textMuted },
  statusFailed: { color: colors.amber },
  dot: { width: 12, height: 12, borderRadius: 6 },

  rowFoot: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: spacing.sm,
    // Under the name rather than under the dot.
    paddingLeft: 12 + spacing.md,
  },
  swatches: { flexDirection: "row", flexWrap: "wrap", gap: 4 },
  // The ring is what shows the choice; the swatch inside it never changes size,
  // so the row does not shift when a different one is picked.
  swatchRing: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: "transparent",
    alignItems: "center",
    justifyContent: "center",
  },
  swatchRingSelected: { borderColor: colors.text },
  swatch: { width: 16, height: 16, borderRadius: 8 },

  remove: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  removeHovered: { borderColor: colors.error },
  removeText: { fontSize: 12, color: colors.error },

  addRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: spacing.sm,
    padding: spacing.md,
  },
  input: {
    flex: 1,
    minWidth: 220,
    fontSize: 13,
    color: colors.text,
    backgroundColor: colors.bg,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  addBtn: {
    backgroundColor: colors.accent,
    borderRadius: radii.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  addBtnHovered: { backgroundColor: colors.accentHov },
  addBtnDisabled: { opacity: 0.5 },
  addBtnText: { fontSize: 13, fontWeight: "600", color: colors.bg },
  addError: { paddingHorizontal: spacing.md, paddingBottom: spacing.md },

  error: { fontSize: 13, color: colors.error },
  howTo: { gap: 4 },
  footnote: { fontSize: 12, color: colors.textDim, fontStyle: "italic" },
  footnoteWhere: { fontStyle: "normal", fontWeight: "600", color: colors.textMuted },
});
