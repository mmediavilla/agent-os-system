import React, { useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import ErrorBanner from "./ErrorBanner";
import { AgentAction } from "../api";
import { CapturedFrame } from "../camera";
import { ChatItem, describeInput, inlineSpans, toolLabel } from "../chat";
import { LiveRun, LiveTool, LiveToolState } from "../run";
import { ConversationController } from "../useConversation";
import { colors, radii, spacing } from "../theme";

/**
 * The conversation itself: transcript, approval cards, composer.
 *
 * Everything here was inside `Chat.tsx`, and what moved it is the HUD's drawer
 * — the same conversation, in a column a third the width, on a screen whose
 * whole premise is that it is the one you leave open. A second copy of the
 * approval cards and the 409 handling would have been one copy exercised daily
 * and one that rots, and the one that rots would be the one on the screen this
 * phase is about.
 *
 * It draws and does nothing else: the state, the run watching and the
 * re-reading all belong to `useConversation`, which both callers own an
 * instance of. What is left here is the two decisions a drawing makes.
 *
 * **A `tool_result` is never a bubble.** The loop writes `user` messages that
 * no user typed — a turn spent calling tools is answered by a message made
 * entirely of results, because the Messages API requires it — so `chatItems`
 * folds each result into the call it answers, and the chips are what is drawn.
 * Rendering the transcript as it arrives puts a wall of JSON on the right-hand
 * side of the screen, attributed to the person reading it.
 *
 * **The live run is drawn exactly the way the stored one is.** It is replaced
 * by the real turns the moment the run ends, and anything that looked different
 * would make that swap read as the screen redrawing itself.
 *
 * **It is typed, and only typed.** The Talk button lived in the composer from
 * 9.1 until the HUD's microphone replaced the ASK pill; a spoken conversation
 * is started from there now, and its turns still land in this transcript
 * because the session belongs to `useConversation`, not to this drawing. The
 * popover that was this view's second caller went at the same time, and its
 * `dense` spacing with it.
 */
export default function ConversationView({
  chat,
  openers,
  assistantOff = false,
  testID,
}: {
  chat: ConversationController;
  /** Offered on an empty thread, so the first message is not a blank page. */
  openers?: string[];
  /**
   * The Anthropic switch is off, so a message would come back a 503.
   *
   * Said before the send rather than after it. The server refuses cleanly and
   * the text is put back in the box, so nothing is lost either way — but
   * "type a paragraph, press enter, read an error" is a worse way to find out
   * than a closed composer with one line under it. Passed down from the health
   * poll the shell already runs, rather than read here, so both conversations
   * and the chip in the bar are looking at one reading.
   */
  assistantOff?: boolean;
  testID?: string;
}) {
  const scroller = useRef<ScrollView>(null);

  return (
    <View style={s.root} testID={testID}>
      <ScrollView
        ref={scroller}
        contentContainerStyle={s.transcript}
        onContentSizeChange={() => scroller.current?.scrollToEnd({ animated: false })}
      >
        {chat.loadingThread ? (
          <ActivityIndicator color={colors.accent} />
        ) : chat.items.length === 0 && chat.live === null ? (
          <Empty openers={openers ?? []} onPick={chat.setDraft} />
        ) : (
          chat.items.map((item) => <Item key={item.key} item={item} />)
        )}

        {chat.live && <Live run={chat.live} />}

        {chat.status === "max_iterations" && !chat.awaiting && (
          <Text style={s.note}>
            The assistant reached its step limit for that message and answered with what it
            had. Ask again if it stopped short.
          </Text>
        )}
      </ScrollView>

      {chat.error && (
        <View style={s.slot}>
          <ErrorBanner text={chat.error} />
        </View>
      )}

      {chat.awaiting && (
        <View style={[s.slot, s.pendingSlot]}>
          {chat.pending.map((action) => (
            <PendingCard
              key={action.id}
              action={action}
              busy={chat.decidingId !== null}
              deciding={chat.decidingId === action.id}
              onDecide={(decision) => chat.decide(action, decision)}
            />
          ))}
        </View>
      )}

      <Composer
        value={chat.draft}
        onChange={chat.setDraft}
        onSend={chat.send}
        disabled={chat.busy || assistantOff}
        snapshot={chat.snapshot}
        onDiscardSnapshot={chat.discardSnapshot}
        // Nothing while a run is going: the answer is being written into the
        // transcript above, which is where the eye already is, and saying it
        // twice reads as two things happening.
        //
        // A parked write outranks the switch: it is the thing the user can act
        // on from here, and the buttons for it are directly above this line.
        hint={
          chat.awaiting
            ? "Approve or decline the change above to carry on."
            : assistantOff
              ? "The Anthropic API is switched off under Settings, so the assistant can't answer."
              : null
        }
      />
    </View>
  );
}

function Empty({ openers, onPick }: { openers: string[]; onPick: (text: string) => void }) {
  return (
    <View style={s.empty}>
      <Text style={s.emptyTitle}>Ask about your training.</Text>
      <Text style={s.emptyBody}>
        The assistant can read your workouts, exercises and equipment, and can log or amend
        a session — it will ask before writing anything.
      </Text>
      <View style={s.openers}>
        {openers.map((text) => (
          <Pressable
            key={text}
            onPress={() => onPick(text)}
            accessibilityRole="button"
            style={({ hovered }: any) => [s.opener, hovered && s.openerHovered]}
          >
            <Text style={s.openerText}>{text}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function Item({ item }: { item: ChatItem }) {
  if (item.kind === "image") {
    const mine = item.role === "user";

    return (
      <View style={[s.bubbleRow, mine && s.bubbleRowMine]}>
        <View style={[s.snapshot, item.pending && s.snapshotPending]}>
          <Image
            source={{ uri: item.url }}
            // `contain` rather than `cover`: a cropped photograph is a
            // different picture from the one that was sent, and this is the
            // record of what the model was actually shown.
            resizeMode="contain"
            style={s.snapshotImage}
            accessibilityLabel="Camera snapshot"
          />
        </View>
      </View>
    );
  }

  if (item.kind === "said") {
    const mine = item.role === "user";
    return (
      <View style={[s.bubbleRow, mine && s.bubbleRowMine]}>
        <View style={[s.bubble, mine ? s.bubbleMine : s.bubbleTheirs]}>
          <Text style={mine ? s.bubbleTextMine : s.bubbleText}>
            {inlineSpans(item.text).map((span, i) => (
              <Text key={i} style={[span.bold && s.spanBold, span.code && s.spanCode]}>
                {span.text}
              </Text>
            ))}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={s.toolRun}>
      {item.calls.map((call) => (
        <ToolChip
          key={call.useId}
          name={call.name}
          input={call.input}
          // Four states, not two. A call with no outcome has not run — it is
          // parked below awaiting a decision — and marking that with a tick
          // would say the write already happened.
          mark={call.outcome === null ? "waiting" : call.outcome.isError ? "failed" : "done"}
          result={call.outcome?.text ?? null}
        />
      ))}
    </View>
  );
}

/** What the mark on a chip says, and how the chip is coloured. */
const MARKS: Record<LiveToolState, string> = {
  waiting: "·",
  running: "…",
  done: "✓",
  failed: "!",
};

/**
 * One tool call, collapsed to its name until asked.
 *
 * Expanded it shows the arguments and whatever came back — which is the whole
 * of what the model saw, and the only way to tell a confident-sounding answer
 * apart from one built on a tool that errored.
 *
 * Shared between the stored transcript and the live preview of a run, which is
 * what keeps the two looking identical across the moment one replaces the
 * other. A live chip has no result yet, which is why `result` is nullable
 * rather than the two callers having their own chip.
 */
function ToolChip({
  name,
  input,
  mark,
  result,
}: {
  name: string;
  input: Record<string, unknown> | null;
  mark: LiveToolState;
  result: string | null;
}) {
  const [open, setOpen] = useState(false);

  const failed = mark === "failed";
  const done = mark === "done";

  return (
    <View style={[s.chip, failed && s.chipFailed]}>
      <Pressable
        onPress={() => setOpen((v) => !v)}
        accessibilityRole="button"
        accessibilityLabel={toolLabel(name)}
        accessibilityState={{ expanded: open }}
        aria-expanded={open}
        style={s.chipHead}
      >
        <Text style={[s.chipDot, failed && s.chipDotFailed, !done && !failed && s.chipDotWaiting]}>
          {MARKS[mark]}
        </Text>
        <Text style={[s.chipName, failed && s.chipNameFailed]}>{toolLabel(name)}</Text>
        <Text style={s.chipChevron}>{open ? "▾" : "▸"}</Text>
      </Pressable>

      {open && (
        <View style={s.chipBody}>
          <Text style={s.chipLabel}>Arguments</Text>
          <Text style={s.code}>{describeInput(input)}</Text>
          <Text style={s.chipLabel}>Result</Text>
          <Text style={s.code}>{result ?? "Not run yet."}</Text>
        </View>
      )}
    </View>
  );
}

/**
 * The run in progress, drawn the way the transcript will draw it a moment
 * later.
 *
 * Reasoning is shown only while it is the only thing happening — the reducer
 * clears it as soon as the model starts answering. A summary of how an answer
 * was reached, left sitting above the answer, is noise.
 */
function Live({ run }: { run: LiveRun }) {
  const silent = run.items.length === 0 && run.thinking === "";

  return (
    <>
      {run.items.map((item, i) =>
        item.kind === "said" ? (
          <View key={i} style={s.bubbleRow}>
            <View style={[s.bubble, s.bubbleTheirs]}>
              <Text style={s.bubbleText}>{item.text}</Text>
            </View>
          </View>
        ) : (
          <View key={i} style={s.toolRun}>
            {item.calls.map((call: LiveTool) => (
              <ToolChip
                key={call.useId}
                name={call.name}
                input={call.input}
                mark={call.state}
                result={null}
              />
            ))}
          </View>
        ),
      )}

      {run.thinking !== "" && <Text style={s.reasoning}>{run.thinking}</Text>}

      {/* Queued, or thinking with `display: omitted` — either way nothing has
          been said yet, and an empty screen is not a state. */}
      {silent && (
        <View style={s.bubbleRow}>
          <View style={[s.bubble, s.bubbleTheirs, s.thinking]}>
            <ActivityIndicator color={colors.textDim} />
            <Text style={s.thinkingText}>Working…</Text>
          </View>
        </View>
      )}
    </>
  );
}

/** A write the assistant wants to make, and the only two things to do about it. */
function PendingCard({
  action,
  busy,
  deciding,
  onDecide,
}: {
  action: AgentAction;
  busy: boolean;
  deciding: boolean;
  onDecide: (decision: "approve" | "reject") => void;
}) {
  return (
    <View style={s.pending}>
      <Text style={s.pendingTitle}>{toolLabel(action.tool)}</Text>
      <Text style={s.pendingLead}>
        The assistant wants to make this change. Nothing is written until you say so.
      </Text>
      <ScrollView style={s.pendingScroll} horizontal={false}>
        <Text style={s.code}>{describeInput(action.input)}</Text>
      </ScrollView>

      <View style={s.pendingButtons}>
        <Pressable
          onPress={() => onDecide("reject")}
          disabled={busy}
          accessibilityRole="button"
          style={({ hovered }: any) => [
            s.decideBtn,
            s.rejectBtn,
            hovered && !busy && s.rejectBtnHovered,
            busy && s.btnDisabled,
          ]}
        >
          <Text style={s.rejectText}>Decline</Text>
        </Pressable>
        <Pressable
          onPress={() => onDecide("approve")}
          disabled={busy}
          accessibilityRole="button"
          style={({ hovered }: any) => [
            s.decideBtn,
            s.approveBtn,
            hovered && !busy && s.approveBtnHovered,
            busy && s.btnDisabled,
          ]}
        >
          {deciding ? (
            <ActivityIndicator color={colors.accentTxt} />
          ) : (
            <Text style={s.approveText}>Approve</Text>
          )}
        </Pressable>
      </View>
    </View>
  );
}

function Composer({
  value,
  onChange,
  onSend,
  disabled,
  snapshot,
  onDiscardSnapshot,
  hint,
}: {
  value: string;
  onChange: (text: string) => void;
  onSend: () => void;
  disabled: boolean;
  snapshot: CapturedFrame | null;
  onDiscardSnapshot: () => void;
  hint: string | null;
}) {
  // Enter sends, Shift+Enter breaks the line — the convention every chat box
  // uses.
  const onKeyPress = (e: any) => {
    if (e.nativeEvent?.key === "Enter" && !e.nativeEvent?.shiftKey) {
      e.preventDefault?.();
      onSend();
    }
  };

  // A picture is a whole question. "What is this?" is implied by having pointed
  // a camera at something, so an empty box with a frame on it can still be sent
  // — which is also the rule the endpoint enforces.
  const empty = value.trim() === "" && !snapshot;

  return (
    <View style={s.composer}>
      {hint && <Text style={s.hint}>{hint}</Text>}

      {snapshot && (
        <View style={s.staged} testID="composer-snapshot">
          <Image source={{ uri: snapshot.dataUrl }} resizeMode="cover" style={s.stagedImage} />
          <View style={s.stagedText}>
            <Text style={s.stagedTitle}>Snapshot attached</Text>
            {/* The dimensions, because they are what the frame costs. Nothing
                has been uploaded yet — the picture on the left is the local
                one, and pressing send is what spends anything. */}
            <Text style={s.stagedNote}>
              {snapshot.width}×{snapshot.height} · sent with your next message
            </Text>
          </View>
          <Pressable
            onPress={onDiscardSnapshot}
            // Deliberately *not* closed with the rest of the composer. A write
            // awaiting approval, or the Anthropic switch being off, closes
            // everything that would send something — and taking a picture back
            // off sends nothing. Sharing the flag stranded a captured frame
            // with no way to remove it in exactly the state where you would
            // most want to, which is the same shape of mistake as a permission
            // prompt whose only exit is to answer it.
            accessibilityRole="button"
            accessibilityLabel="Remove snapshot"
            style={({ hovered }: any) => [s.stagedRemove, hovered && s.stagedRemoveHovered]}
            testID="composer-snapshot-remove"
          >
            <Text style={s.stagedRemoveText}>Remove</Text>
          </Pressable>
        </View>
      )}

      <View style={s.composerRow}>
        <TextInput
          value={value}
          onChangeText={onChange}
          onKeyPress={onKeyPress}
          editable={!disabled}
          multiline
          placeholder={disabled ? "" : "Ask about your training…"}
          placeholderTextColor={colors.textDim}
          accessibilityLabel="Message"
          style={[s.input, disabled && s.inputDisabled]}
        />

        <Pressable
          onPress={onSend}
          disabled={disabled || empty}
          accessibilityRole="button"
          accessibilityLabel="Send"
          style={({ hovered }: any) => [
            s.sendBtn,
            hovered && !disabled && s.sendBtnHovered,
            (disabled || empty) && s.btnDisabled,
          ]}
        >
          <Text style={s.sendText}>Send</Text>
        </Pressable>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1 },

  transcript: {
    padding: spacing.lg,
    gap: spacing.md,
    maxWidth: 820,
    width: "100%",
  },

  bubbleRow: { flexDirection: "row" },
  bubbleRowMine: { justifyContent: "flex-end" },
  bubble: {
    maxWidth: "88%",
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.lg,
    borderWidth: 1,
  },
  bubbleMine: { backgroundColor: colors.accentBg, borderColor: colors.accentBd },

  // A snapshot in the transcript. Framed like a bubble so it sits in the same
  // column as the question it was asked with, and on a dark ground so a photo
  // with pale edges still reads as a picture rather than as a hole.
  snapshot: {
    maxWidth: "88%",
    padding: spacing.xs,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.accentBd,
    backgroundColor: colors.accentBg,
  },
  // Dimmed while it is still only the browser's copy — the send has not come
  // back, and this may yet go back on the composer.
  snapshotPending: { opacity: 0.6 },
  snapshotImage: { width: 220, height: 165, borderRadius: radii.md },
  bubbleTheirs: { backgroundColor: colors.surface, borderColor: colors.border },
  bubbleText: { fontSize: 14, lineHeight: 21, color: colors.text },
  bubbleTextMine: { fontSize: 14, lineHeight: 21, color: colors.accentTxt },

  // The only two pieces of markdown the bubbles understand — see inlineSpans.
  spanBold: { fontWeight: "700" },
  spanCode: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 13,
  },

  thinking: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  thinkingText: { fontSize: 13, color: colors.textDim },

  // Not a bubble. The model's reasoning is not something it said to anybody,
  // and giving it the same frame as the answer invites it to be quoted back.
  reasoning: {
    fontSize: 13,
    lineHeight: 20,
    color: colors.textDim,
    fontStyle: "italic",
    paddingHorizontal: spacing.xs,
  },

  toolRun: { gap: spacing.xs },
  chip: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
    alignSelf: "flex-start",
    maxWidth: "100%",
  },
  chipFailed: { borderColor: colors.errorBd, backgroundColor: colors.errorBgAlt },
  chipHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  chipDot: { fontSize: 11, fontWeight: "700", color: colors.emeraldTxt },
  chipDotFailed: { color: colors.error },
  chipDotWaiting: { color: colors.textDim },
  chipName: { fontSize: 12, fontWeight: "600", color: colors.textMuted },
  chipNameFailed: { color: colors.errorTxt },
  chipChevron: { fontSize: 10, color: colors.textDim },
  chipBody: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
    gap: spacing.xs,
    borderTopWidth: 1,
    borderColor: colors.border,
    paddingTop: spacing.sm,
  },
  chipLabel: {
    fontSize: 10,
    fontWeight: "700",
    color: colors.textDim,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  code: {
    fontSize: 12,
    lineHeight: 18,
    color: colors.textMuted,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  },

  empty: { gap: spacing.md, paddingVertical: spacing.xl },
  emptyTitle: { fontSize: 18, fontWeight: "600", color: colors.text },
  emptyBody: { fontSize: 14, lineHeight: 21, color: colors.textMuted, maxWidth: 520 },
  openers: { gap: spacing.sm, alignItems: "flex-start" },
  opener: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  openerHovered: { borderColor: colors.accentBd, backgroundColor: colors.accentBg },
  openerText: { fontSize: 13, color: colors.textMuted },

  note: { fontSize: 12, color: colors.textDim, fontStyle: "italic" },

  // ── the confirmation gate ──────────────────────────────────────────────────
  slot: { paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
  pendingSlot: { gap: spacing.sm },
  pending: {
    borderWidth: 1,
    borderColor: colors.amber,
    backgroundColor: colors.amberBg,
    borderRadius: radii.lg,
    padding: spacing.lg,
    gap: spacing.sm,
    maxWidth: 820,
  },
  pendingTitle: { fontSize: 15, fontWeight: "600", color: colors.text },
  pendingLead: { fontSize: 13, color: colors.textMuted },
  // Capped rather than free: a logged workout's arguments can run to dozens of
  // lines, and pushing the buttons off the bottom of the screen is how a
  // confirmation gate stops being one.
  pendingScroll: { maxHeight: 200 },
  pendingButtons: { flexDirection: "row", gap: spacing.sm },
  decideBtn: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.md,
    borderWidth: 1,
    alignItems: "center",
    minWidth: 110,
  },
  approveBtn: { backgroundColor: colors.accentBg, borderColor: colors.accentBd },
  approveBtnHovered: { backgroundColor: colors.accentBd },
  approveText: { fontSize: 14, fontWeight: "600", color: colors.accentTxt },
  rejectBtn: { backgroundColor: colors.surface, borderColor: colors.border },
  rejectBtnHovered: { backgroundColor: colors.bg },
  rejectText: { fontSize: 14, fontWeight: "500", color: colors.textMuted },
  btnDisabled: { opacity: 0.5 },

  // ── the composer ───────────────────────────────────────────────────────────
  composer: {
    borderTopWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    padding: spacing.md,
    gap: spacing.xs,
  },
  hint: { fontSize: 12, color: colors.textDim, paddingHorizontal: spacing.xs },

  // The staged frame, above the box rather than inside it: it is not text, and
  // it has its own control.
  staged: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    padding: spacing.xs,
    borderWidth: 1,
    borderColor: colors.accentBd,
    backgroundColor: colors.accentBg,
    borderRadius: radii.md,
  },
  stagedImage: { width: 56, height: 42, borderRadius: radii.sm },
  stagedText: { flex: 1 },
  stagedTitle: { fontSize: 12, fontWeight: "600", color: colors.accentTxt },
  stagedNote: { fontSize: 11, color: colors.textDim },
  stagedRemove: {
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  stagedRemoveHovered: { backgroundColor: colors.surface },
  stagedRemoveText: { fontSize: 11, color: colors.textDim },

  composerRow: { flexDirection: "row", gap: spacing.sm, alignItems: "flex-end" },
  input: {
    flex: 1,
    minHeight: 42,
    maxHeight: 160,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: 14,
    color: colors.text,
    backgroundColor: colors.bg,
  },
  inputDisabled: { opacity: 0.6 },
  sendBtn: {
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xl,
    borderRadius: radii.md,
    backgroundColor: colors.accent,
  },
  sendBtnHovered: { backgroundColor: colors.accentHov },
  sendText: { fontSize: 14, fontWeight: "600", color: colors.bg },
});
