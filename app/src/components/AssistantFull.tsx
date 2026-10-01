import React, { useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import ConfirmDialog from "./ConfirmDialog";
import ConversationView from "./ConversationView";
import { Conversation } from "../api";
import { ConversationController } from "../useConversation";
import { colors, radii, spacing } from "../theme";

/**
 * The whole conversation, with the threads beside it.
 *
 * This was the Assistant *screen* until 8.2, and what changed is not its
 * contents but where it is reached from. It is the Chat tab of the Assistant
 * overlay (`AssistantView`), opened from the core menu's Assistant title or
 * ⌘K — an overlay *over* the HUD rather than a place you navigate to and then have to
 * navigate back out of. Same argument 7.3b made of the calendar.
 *
 * **It is the only place to type.** The popover that used to sit between the
 * HUD and this is gone, and so is the Talk button that used to be in the
 * composer: talking is the microphone's job, typing is this. A conversation
 * had out loud still appears here, because the session writes into the same
 * thread — it just cannot be started from here.
 *
 * **It does not own a conversation.** `chat` arrives as a prop from the HUD,
 * so the thread a spoken question landed in is the thread this opens on; a
 * `useConversation` of its own would quietly open a different one, and there
 * would be two run watchers again with `active` refereeing them.
 *
 * What is left here is picking *which* thread: a rail, a delete confirmation
 * and a narrow-window story for showing one pane at a time. The transcript,
 * the tool chips, the approval cards and the composer are `ConversationView`.
 *
 * It draws no identity header of its own any more: the overlay around it has a
 * spine reading ASSISTANT down its left edge and the state orb in its corner,
 * and a second title under those would be the same word twice.
 */

/** Below this the thread list and the transcript take turns; above, both fit. */
const TWO_PANE_WIDTH = 900;

/** Offered on an empty thread, so the first message is not a blank page. */
const OPENERS = [
  "How has my training gone over the last four weeks?",
  "Which muscle groups am I neglecting?",
  "What are my recent PRs?",
];

export default function AssistantFull({
  chat,
  assistantOff = false,
}: {
  /**
   * The conversation, owned by whoever opened this — which today is the HUD.
   *
   * Passed rather than created so this shows the thread the HUD is holding,
   * including one a spoken question has just landed in.
   */
  chat: ConversationController;
  /**
   * The Anthropic switch is off. Read from the shell's health poll rather than
   * from a poll of this view’s own, so this composer, the HUD's microphone and
   * the chip in the bar are all drawing one reading.
   */
  assistantOff?: boolean;
}) {
  const twoPane = useWindowDimensions().width >= TWO_PANE_WIDTH;

  // Only meaningful on a narrow viewport, where the two panes are one.
  const [showThreads, setShowThreads] = useState(false);
  const [deleting, setDeleting] = useState<Conversation | null>(null);

  const openThread = (id: number | null) => {
    chat.openThread(id);
    setShowThreads(false);
  };

  const confirmDelete = async () => {
    const target = deleting;
    if (!target) return;

    await chat.deleteThread(target);
    setDeleting(null);
  };

  const threadList = (
    <View style={[s.rail, !twoPane && s.railFull]}>
      <Pressable
        onPress={() => {
          chat.startNewThread();
          setShowThreads(false);
        }}
        accessibilityRole="button"
        style={({ hovered }: any) => [s.newBtn, hovered && s.newBtnHovered]}
      >
        <Text style={s.newBtnText}>+ New chat</Text>
      </Pressable>

      <ScrollView>
        {chat.conversations.length === 0 ? (
          <Text style={s.railEmpty}>No conversations yet.</Text>
        ) : (
          chat.conversations.map((c) => {
            const selected = c.id === chat.activeId;
            return (
              <View key={c.id} style={[s.threadRow, selected && s.threadRowActive]}>
                <Pressable
                  onPress={() => openThread(c.id)}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  aria-selected={selected}
                  style={s.threadMain}
                >
                  <Text numberOfLines={1} style={[s.threadTitle, selected && s.threadTitleActive]}>
                    {c.title ?? "New conversation"}
                  </Text>
                  <Text style={s.threadDate}>{relativeDate(c.last_message_at ?? c.created_at)}</Text>
                </Pressable>
                <Pressable
                  onPress={() => setDeleting(c)}
                  accessibilityRole="button"
                  accessibilityLabel={`Delete ${c.title ?? "conversation"}`}
                  style={({ hovered }: any) => [s.threadDelete, hovered && s.threadDeleteHovered]}
                >
                  <Text style={s.threadDeleteIcon}>✕</Text>
                </Pressable>
              </View>
            );
          })
        )}
      </ScrollView>
    </View>
  );

  return (
    <View style={s.root}>
      {/* The one part of the old screen header that is this view's own
          business rather than the assistant's: which of the two panes a
          narrow window is showing. The rest of that bar — the orb and the
          word "Assistant" — belongs to the frame around this now, which
          draws both and would otherwise say the same word twice. */}
      {!twoPane && (
        <View style={s.paneBar}>
          <Pressable
            onPress={() => setShowThreads((v) => !v)}
            accessibilityRole="button"
            accessibilityLabel="Conversations"
            accessibilityState={{ expanded: showThreads }}
            aria-expanded={showThreads}
            style={({ hovered }: any) => [s.threadsToggle, hovered && s.threadsToggleHovered]}
          >
            <Text style={s.threadsToggleText}>Chats</Text>
          </Pressable>
        </View>
      )}

      <View style={s.body}>
        {(twoPane || showThreads) && threadList}

        {(twoPane || !showThreads) && (
          <View style={s.main}>
            <ConversationView chat={chat} openers={OPENERS} assistantOff={assistantOff} />
          </View>
        )}
      </View>

      <ConfirmDialog
        visible={deleting !== null}
        title="Delete conversation?"
        message={
          "The transcript goes; anything the assistant already wrote to your " +
          "workouts, exercises or insights stays."
        }
        confirmLabel="Delete"
        onConfirm={confirmDelete}
        onCancel={() => setDeleting(null)}
      />
    </View>
  );
}

function relativeDate(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";

  const days = Math.floor((Date.now() - date.getTime()) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const RAIL_W = 240;

const s = StyleSheet.create({
  // No ground of its own: what is behind this is the overlay, which is glass
  // over a HUD that is meant to stay visible through it. A surface colour here
  // would paint that back out.
  root: { flex: 1 },

  paneBar: {
    flexDirection: "row",
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
  },

  threadsToggle: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  threadsToggleHovered: { backgroundColor: colors.bg },
  threadsToggleText: { fontSize: 13, color: colors.textMuted, fontWeight: "500" },

  body: { flex: 1, flexDirection: "row" },
  main: { flex: 1 },

  // ── the thread rail ────────────────────────────────────────────────────────
  rail: {
    width: RAIL_W,
    borderRightWidth: 1,
    borderColor: colors.border,
    padding: spacing.sm,
    gap: spacing.sm,
  },
  // On a narrow viewport it is not a rail beside anything — it is the page.
  railFull: { width: "100%", flex: 1, borderRightWidth: 0 },
  railEmpty: { fontSize: 13, color: colors.textDim, padding: spacing.md },

  newBtn: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.accentBd,
    backgroundColor: colors.accentBg,
    alignItems: "center",
  },
  newBtnHovered: { backgroundColor: colors.accentBd },
  newBtnText: { fontSize: 13, fontWeight: "600", color: colors.accentTxt },

  threadRow: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: radii.md,
  },
  threadRowActive: { backgroundColor: colors.accentBg },
  threadMain: { flex: 1, paddingVertical: spacing.sm, paddingHorizontal: spacing.md, gap: 2 },
  threadTitle: { fontSize: 13, color: colors.text },
  threadTitleActive: { color: colors.accentTxt, fontWeight: "600" },
  threadDate: { fontSize: 11, color: colors.textDim },
  threadDelete: { paddingHorizontal: spacing.sm, paddingVertical: spacing.sm, borderRadius: radii.sm },
  threadDeleteHovered: { backgroundColor: colors.errorBg },
  threadDeleteIcon: { fontSize: 12, color: colors.textDim },
});
