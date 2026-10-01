import React, { useCallback, useEffect, useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import { AssistantInstruction, api, errorMessage } from "../api";
import { colors, radii, spacing, type } from "../theme";
import { SmallButton } from "./RecordsParts";
import { Card, Line, Note, StatPage, statStyles } from "./StatParts";

/**
 * Assistant → Instructions: what Claude is told, in the words the owner may
 * change — the persona, the scope, how a spoken answer sounds, and the briefs of
 * the weekly assessment and the morning nudge.
 *
 * **Blank is the default, never "no instructions"** — the Agents guardrail's
 * rule. Every field starts holding the code's wording; a change is kept on the
 * server (`AssistantInstructions`), clearing the field or pressing Reset goes
 * back to the default, and the next turn uses whichever is current. Rows on the
 * server, because the worker, the scheduler and a spoken turn all read them
 * with no browser open.
 *
 * **The list is the server's**, label and all, so this screen keeps no second
 * copy of what is rewordable. What is *not* here — the tools' shared paragraph,
 * the approval gate, the agents and the facts — is said on the first card, so
 * nobody goes looking for it.
 *
 * `AgentsView`'s rules otherwise: read on arrival, never polled; nothing
 * optimistic; one write out at a time; a draft committed on blur and resynced
 * from the stored text **and** a write counter. Nothing asks first — any
 * rewording can be reset.
 */
export default function InstructionsView({ active }: { active: boolean }) {
  const [rows, setRows] = useState<AssistantInstruction[] | null>(null);
  const [max, setMax] = useState(4000);
  const [readError, setReadError] = useState<string | null>(null);
  // Which instruction's write is out.
  const [busy, setBusy] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<{ at: string; text: string } | null>(null);
  // Bumped by every write, and by nothing else — what a draft resyncs on.
  const [written, setWritten] = useState(0);

  const reload = useCallback(async () => {
    try {
      const state = await api.getAssistantInstructions();
      setRows(state.data);
      setMax(state.max_chars);
      setReadError(null);
    } catch (e) {
      setReadError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    if (active) reload();
  }, [active, reload]);

  const reword = async (key: string, text: string | null) => {
    setBusy(key);
    setWriteError(null);
    try {
      const state = await api.patchAssistantInstructions({ [key]: text });
      setRows(state.data);
    } catch (e) {
      setWriteError({ at: key, text: errorMessage(e) });
    }
    setWritten((v) => v + 1);
    setBusy(null);
  };

  return (
    <StatPage testID="instructions-view">
      <Card testID="instructions-about" title="Instructions" wide>
        <Text style={s.desc}>
          What the assistant is told before it answers. Reword any of these; clearing a field, or
          Reset, puts the default back, and the next turn uses whichever is current. The tools'
          own notes, the approval gate, the agents you have switched on and the facts on file are
          worked out by the app, so they are not here.
        </Text>
      </Card>

      {rows === null && !readError && (
        <Card testID="instructions-loading" title="Instructions">
          <Line label="Instructions" value="reading…" dim />
        </Card>
      )}

      {readError && (
        <Card testID="instructions-error" title="Instructions" footnote={{ text: readError, warn: true }}>
          <Line label="Instructions" value="—" dim />
        </Card>
      )}

      {(rows ?? []).map((row) => (
        <InstructionCard
          key={row.key}
          row={row}
          max={max}
          written={written}
          locked={busy !== null}
          error={writeError?.at === row.key ? writeError.text : null}
          onReword={(text) => reword(row.key, text)}
        />
      ))}
    </StatPage>
  );
}

function InstructionCard({
  row,
  max,
  written,
  locked,
  error,
  onReword,
}: {
  row: AssistantInstruction;
  max: number;
  /** How many writes this page has made. The draft resyncs on each one. */
  written: number;
  locked: boolean;
  error: string | null;
  onReword: (text: string | null) => void;
}) {
  const { key, label, text, reworded } = row;
  const [draft, setDraft] = useState(text);
  // Kept here, not sent: a paste over the limit is refused without throwing it away.
  const [tooLong, setTooLong] = useState(false);

  // The value and the write counter, never the row object — AutomationsView's pair.
  useEffect(() => setDraft(text), [text, written]);
  useEffect(() => setTooLong(false), [text, written]);

  const commit = () => {
    const next = draft.trim();
    if (next === text.trim()) return;
    // Blank is the default. Already on it, there is nothing to write.
    if (next === "" && !reworded) {
      setDraft(text);
      return;
    }
    if (next.length > max) {
      setTooLong(true);
      return;
    }
    onReword(next);
  };

  const footnote: Note | undefined = tooLong
    ? { text: `At most ${max} characters — this is ${draft.trim().length}. Nothing was saved.`, warn: true }
    : error
      ? { text: error, warn: true }
      : undefined;

  return (
    // A row per instruction, the page's full width (the owner's call): five columns
    // side by side left each field a few words wide.
    <Card testID={`instruction-${key}`} title={label} right={reworded ? "reworded" : "default"} footnote={footnote} wide>
      <Text style={s.desc} testID={`instruction-${key}-used-by`}>
        {row.used_by}
      </Text>

      <TextInput
        value={draft}
        onChangeText={(t) => {
          setDraft(t);
          if (tooLong) setTooLong(false);
        }}
        onBlur={commit}
        multiline
        numberOfLines={8}
        editable={!locked}
        placeholder="Blank uses the default."
        placeholderTextColor={colors.textDim}
        accessibilityLabel={`${label} instruction`}
        style={s.input}
        testID={`instruction-${key}-input`}
      />

      <Text style={s.desc} testID={`instruction-${key}-note`}>
        {reworded
          ? "Reworded by you. Clear it, or reset, to go back to the default."
          : "The default. Reword it here; clearing it keeps the default."}
      </Text>

      {reworded && (
        <View style={s.actions}>
          <SmallButton
            label="Reset to default"
            onPress={() => onReword(null)}
            disabled={locked}
            testID={`instruction-${key}-reset`}
            accessibilityLabel={`Reset ${label} to default`}
          />
        </View>
      )}
    </Card>
  );
}

const s = {
  ...statStyles,
  ...StyleSheet.create({
    desc: { ...type.caption, color: colors.textDim },
    input: {
      fontSize: 13,
      color: colors.text,
      backgroundColor: colors.bg,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: radii.md,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      // Full width, the longest brief is about a dozen lines — room for it
      // whole, so nobody has to scroll inside a field to reword it.
      minHeight: 200,
      textAlignVertical: "top",
    },
    actions: { flexDirection: "row", gap: spacing.xs },
  }),
};
