import React, { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { NewsItem, NewsPage, api, errorMessage } from "../api";
import { usePolled } from "../polling";
import { colors, radii, spacing, type } from "../theme";
import NewsInterests from "./NewsInterests";
import NewsPinned from "./NewsPinned";
import PillSelector from "./PillSelector";
import { SmallButton } from "./RecordsParts";
import { Card, StatPage, errorNote, since, statStyles } from "./StatParts";

/** A beat is read again this often while the overlay is open: an outlet's own cache is twenty minutes. */
export const NEWS_POLL_MS = 600_000;

/**
 * News: a beat's latest, the owner's interests, and a pin for later.
 *
 * The core menu's News title opens it (19.3). **One list under a row of chips**,
 * not a tab per beat: nine tab bodies would be nine mounts and nine pollers for
 * a screen that shows one list at a time. The chips come from the server's
 * `beats`, in config order with Local first, so the screen keeps no copy of the
 * config. Which chip is picked is the HUD's (`beat`), so it survives a close.
 *
 * **Reading here marks nothing as told.** `GET /api/news` reads without
 * `markSeen`; browsing is not the assistant briefing the owner, so a later
 * "what's the news?" still calls these stories new.
 *
 * **A dead outlet is said, in amber, under the list** — the agenda legend's
 * rule. An empty beat beside an unreachable outlet is not "no news".
 *
 * **Two chips are not beats** (19.4, the owner's call): Interests carries its own
 * editor above the stories it finds (`NewsInterests`), and **Pinned**, last,
 * is the reading list (`NewsPinned`) — where the menu's "N unread" leads.
 * Both lived on the News desk's card in Assistant → Agents for a day and were
 * out of place there.
 *
 * **Pinning is not optimistic** (`useServerSettings`' rule): the button waits
 * for its answer and is drawn from it, and one write is out at a time. The
 * browser sends the story's `id`, never its link.
 */
export default function NewsView({
  active,
  beat,
  onBeat,
}: {
  active: boolean;
  /** The chip picked; null until one is, which is the server's first beat. */
  beat: string | null;
  onBeat: (beat: string) => void;
}) {
  // The chips outlive a switch: the list below remounts, and the row it was
  // read from would otherwise go with it and come back a moment later.
  const [beats, setBeats] = useState<NewsPage["beats"]>([]);
  const [shown, setShown] = useState<string | null>(beat);
  // Bumped by a saved interests list, so the stories under it are read again.
  const [interestsSaved, setInterestsSaved] = useState(0);

  const pinned = beat === PINNED;

  // The chips come with a beat's answer. Opened straight onto Pinned — the chip
  // survives a close — there is none yet, so ask for the first beat once to
  // draw them. The server answers from its cache.
  useEffect(() => {
    if (!active || !pinned || beats.length > 0) return;
    let live = true;
    api
      .getNews()
      .then((page) => live && setBeats(page.beats))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [active, pinned, beats.length]);

  return (
    <StatPage testID="news-view">
      {beats.length > 0 && (
        <View style={s.chips} testID="news-beats">
          <PillSelector
            options={[...beats.map((b) => ({ value: b.key, label: chipLabel(b) })), { value: PINNED, label: "Pinned" }]}
            value={beat ?? shown ?? ""}
            // The chip already showing is not a new beat, and would remount the list.
            onChange={(next) => next !== (beat ?? shown) && onBeat(next)}
          />
        </View>
      )}

      {pinned ? (
        <NewsPinned active={active} />
      ) : (
        <>
          {beat === "interests" && <NewsInterests active={active} onSaved={() => setInterestsSaved((v) => v + 1)} />}

          {/* Keyed on the beat, so a switch is a fresh reader: an answer for the
              chip just left can never land over the one just picked. */}
          <BeatList
            key={`${beat ?? ""}:${beat === "interests" ? interestsSaved : 0}`}
            active={active}
            beat={beat}
            onRead={(page) => {
              setBeats(page.beats);
              setShown(page.beat);
            }}
          />
        </>
      )}
    </StatPage>
  );
}

/** Not a beat the server knows: the reading list, drawn here from `/news/pins`. */
export const PINNED = "pinned";

function BeatList({
  active,
  beat,
  onRead,
}: {
  active: boolean;
  beat: string | null;
  onRead: (page: NewsPage) => void;
}) {
  const news = usePolled(() => api.getNews(beat), { intervalMs: NEWS_POLL_MS, active });
  // The answer to a pin or an unpin, by story, until the next read agrees.
  const [pins, setPins] = useState<Record<string, number | null>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);

  const page = news.data;

  useEffect(() => {
    if (page) {
      onRead(page);
      setPins({});
    }
    // `onRead` is written inline by the parent; the page is what changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  const pinOf = (item: NewsItem): number | null => (item.id in pins ? pins[item.id] : item.pin_id);

  const toggle = async (item: NewsItem) => {
    if (busy !== null) return;
    const pinId = pinOf(item);
    setBusy(item.id);
    setWriteError(null);
    try {
      if (pinId === null) {
        const pin = await api.pinArticle(item.id);
        setPins((p) => ({ ...p, [item.id]: pin.id }));
      } else {
        await api.unpinArticle(pinId);
        setPins((p) => ({ ...p, [item.id]: null }));
      }
    } catch (e) {
      setWriteError(errorMessage(e));
      // Whatever it did or did not do, the next read says so.
      news.refresh();
    } finally {
      setBusy(null);
    }
  };

  const interests = page?.beat === "interests";
  const noInterests = interests && (page?.searched ?? []).length === 0;
  const unreachable = page?.unreachable ?? [];

  return (
    <Card
      testID="news-list"
      title={page?.label ?? "News"}
      right={page && !noInterests ? stories(page.items.length) : undefined}
      footnote={writeError ? { text: writeError, warn: true } : errorNote(news)}
      wide
    >
      {page === null && !news.error && <Text style={s.empty}>Reading…</Text>}

      {noInterests && (
        <Text style={s.empty} testID="news-empty-interests">
          No interests set yet. Add them above, one per line, and they are searched here.
        </Text>
      )}
      {page && !noInterests && page.items.length === 0 && (
        <Text style={s.empty} testID="news-empty">
          {unreachable.length > 0
            ? "Nothing could be read just now — the outlets below did not answer."
            : "Nothing new here in the last week."}
        </Text>
      )}

      {page?.items.map((item) => {
        const pinned = pinOf(item) !== null;
        return (
          <View key={item.id} style={s.item} testID={`news-item-${item.id}`}>
            <Text style={s.title}>{item.title}</Text>
            <Text style={s.meta}>
              {[item.source, item.published_at ? since(item.published_at) : "undated", item.interest].filter(Boolean).join(" · ")}
            </Text>
            {item.summary && (
              <Text style={s.summary} numberOfLines={2}>
                {item.summary}
              </Text>
            )}
            <View style={s.actions}>
              <SmallButton
                label="Open ↗"
                onPress={() => window.open?.(item.link, "_blank", "noopener")}
                disabled={false}
                testID={`news-open-${item.id}`}
                accessibilityLabel={`Open ${item.title}`}
              />
              <PinButton
                pinned={pinned}
                working={busy === item.id}
                disabled={busy !== null}
                onPress={() => toggle(item)}
                testID={`news-pin-${item.id}`}
                title={item.title}
              />
            </View>
          </View>
        );
      })}

      {unreachable.length > 0 && (
        <Text style={[statStyles.note, statStyles.noteWarn]} testID="news-unreachable">
          Couldn't reach {unreachable.map((u) => u.source).join(", ")} — {unreachable.length === 1 ? "its" : "their"} stories are
          missing, not absent.
        </Text>
      )}
    </Card>
  );
}

/** Pin, or Pinned in the accent — pressing Pinned takes it off the list. */
function PinButton({
  pinned,
  working,
  disabled,
  onPress,
  testID,
  title,
}: {
  pinned: boolean;
  working: boolean;
  disabled: boolean;
  onPress: () => void;
  testID: string;
  title: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={pinned ? `Unpin ${title}` : `Pin ${title} for later`}
      accessibilityState={{ disabled, selected: pinned }}
      style={({ hovered }: any) => [s.pin, pinned && s.pinOn, hovered && !disabled && s.pinHovered, disabled && s.disabled]}
      testID={testID}
    >
      <Text style={[s.pinText, pinned && s.pinTextOn]}>{working ? "…" : pinned ? "Pinned" : "Pin"}</Text>
    </Pressable>
  );
}

/** The server's label, except "Your interests", which is a heading rather than a chip's worth. */
function chipLabel(beat: { key: string; label: string }): string {
  return beat.key === "interests" ? "Interests" : beat.label;
}

function stories(n: number): string {
  return n === 1 ? "1 story" : `${n} stories`;
}

const s = {
  ...statStyles,
  ...StyleSheet.create({
    chips: { flexBasis: "100%" },
    empty: { ...type.small, color: colors.textDim },

    item: {
      gap: 2,
      paddingVertical: spacing.sm,
      borderTopWidth: 1,
      borderTopColor: colors.border,
    },
    title: { ...type.body, color: colors.text, fontWeight: "600" },
    meta: { ...type.caption, color: colors.textDim },
    summary: { ...type.small, color: colors.textMuted },
    actions: { flexDirection: "row", gap: spacing.xs, marginTop: spacing.xs },

    pin: {
      paddingHorizontal: spacing.sm,
      paddingVertical: 4,
      borderRadius: radii.sm,
      borderWidth: 1,
      borderColor: "transparent",
    },
    pinOn: { borderColor: colors.accentBd, backgroundColor: colors.accentBg },
    pinHovered: { backgroundColor: colors.bg },
    pinText: { fontSize: 12, fontWeight: "600", color: colors.accentTxt },
    pinTextOn: { color: colors.accentTxt },
    disabled: { opacity: 0.45 },
  }),
};
