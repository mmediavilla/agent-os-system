import React, { useCallback, useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Fact, FactList, api, errorMessage } from "../api";
import { colors, radii, spacing, type } from "../theme";
import ConfirmDialog from "./ConfirmDialog";
import { Card, Group, Line, Note, StatPage, statStyles } from "./StatParts";

type Where = "review" | "known" | "add";

function noteFor(error: { at: Where; text: string } | null, at: Where): Note | undefined {
  return error?.at === at ? { text: error.text, warn: true } : undefined;
}

/**
 * Facts: what the assistant has on file about the owner, what it would like to
 * add, and a way to tell it something directly.
 *
 * The core menu's Facts title opens it. One page of cards like Profile — a
 * **trust surface**, not a management system: no filters, no pages. Facts are
 * never the point of a screen; they change every other answer, and this is
 * where the owner checks what the assistant believes and fixes what is wrong.
 *
 * **Read on arrival, never polled**, like Profile: nothing here changes on its
 * own while it is open except a proposal from the extractor (15.2), which can
 * wait for the next visit.
 *
 * **Nothing is optimistic**, for `useServerSettings`' reason. Every button waits
 * for its answer and the page is read again, so a fact that looked kept and was
 * not — decided in another tab, a 409 — cannot be left on screen. One write is
 * out at a time, and every button waits for it.
 *
 * **Forget asks first.** It is a hard delete of the key and its history, the
 * one thing here that cannot be taken back; a rejection leaves a tombstone and
 * a keep can be forgotten, so neither asks.
 */
export default function FactsView({ active }: { active: boolean }) {
  const [facts, setFacts] = useState<FactList | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  // Which write is out: a fact's id, "all" for Keep all, or "add".
  const [busy, setBusy] = useState<number | "all" | "add" | null>(null);
  // A failed write says so on the card it came from.
  const [writeError, setWriteError] = useState<{ at: Where; text: string } | null>(null);
  const [forgetting, setForgetting] = useState<Fact | null>(null);

  const reload = useCallback(async () => {
    try {
      setFacts(await api.listFacts());
      setReadError(null);
    } catch (e) {
      setReadError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    if (active) reload();
  }, [active, reload]);

  /** Run one write, then re-read whatever it did or did not do. */
  const write = async (which: number | "all" | "add", at: Where, fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(which);
    setWriteError(null);
    let ok = true;
    try {
      await fn();
    } catch (e) {
      ok = false;
      setWriteError({ at, text: errorMessage(e) });
    }
    await reload();
    setBusy(null);
    return ok;
  };

  const decide = (fact: Fact, decision: "keep" | "reject") => write(fact.id, "review", () => api.decideFact(fact.id, decision));

  // One at a time, oldest first, so two proposals for one key end with the
  // newer on file. It stops at the first refusal: whatever is left is still
  // on screen after the re-read, with the sentence that says why.
  const keepAll = () =>
    write("all", "review", async () => {
      for (const fact of [...(facts?.proposed ?? [])].reverse()) {
        await api.decideFact(fact.id, "keep");
      }
    });

  const forget = async () => {
    if (!forgetting) return;
    const fact = forgetting;
    await write(fact.id, "known", () => api.forgetFact(fact.id));
    setForgetting(null);
  };

  const proposed = facts?.proposed ?? [];

  return (
    <StatPage testID="facts-view">
      <Card
        testID="facts-proposed"
        title="To review"
        right={facts ? (proposed.length === 0 ? "nothing waiting" : `${proposed.length} waiting`) : undefined}
        footnote={noteFor(writeError, "review")}
      >
        {facts === null && !readError && <Line label="Proposals" value="reading…" dim />}
        {facts && proposed.length === 0 && (
          <Text style={s.empty}>Nothing to review. What the assistant picks up from a conversation waits here until you keep it.</Text>
        )}

        {proposed.map((fact) => (
          <View key={fact.id} style={s.item} testID={`facts-proposed-${fact.id}`}>
            <FactText fact={fact} />
            {fact.replaces !== null && (
              <Text style={s.detail} testID={`facts-proposed-${fact.id}-replaces`}>
                replaces “{fact.replaces}”
              </Text>
            )}
            <View style={s.actions}>
              <SmallButton
                label="Keep"
                onPress={() => decide(fact, "keep")}
                disabled={busy !== null}
                testID={`facts-keep-${fact.id}`}
                accessibilityLabel={`Keep ${fact.category} / ${fact.key}`}
              />
              <SmallButton
                label="Reject"
                tone={colors.error}
                onPress={() => decide(fact, "reject")}
                disabled={busy !== null}
                testID={`facts-reject-${fact.id}`}
                accessibilityLabel={`Reject ${fact.category} / ${fact.key}`}
              />
            </View>
          </View>
        ))}

        {proposed.length > 1 && (
          <Button
            label={busy === "all" ? "Keeping…" : "Keep all"}
            onPress={keepAll}
            disabled={busy !== null}
            testID="facts-keep-all"
          />
        )}
      </Card>

      <KnownCard
        facts={facts}
        error={readError}
        writeError={noteFor(writeError, "known")}
        busy={busy}
        onForget={setForgetting}
      />

      <AddCard busy={busy} error={noteFor(writeError, "add")} onAdd={(input) => write("add", "add", () => api.addFact(input))} />

      <ConfirmDialog
        visible={forgetting !== null}
        title={`Forget ${forgetting ? `${forgetting.category} / ${forgetting.key}` : "this fact"}?`}
        message="It is deleted, with every earlier answer on file for it, and the assistant stops knowing it from the next message on."
        confirmLabel="Forget"
        destructive
        loading={forgetting !== null && busy === forgetting.id}
        onConfirm={forget}
        onCancel={() => setForgetting(null)}
      />
    </StatPage>
  );
}

function KnownCard({
  facts,
  error,
  writeError,
  busy,
  onForget,
}: {
  facts: FactList | null;
  error: string | null;
  writeError: Note | undefined;
  busy: number | "all" | "add" | null;
  onForget: (fact: Fact) => void;
}) {
  const known = facts?.active ?? [];
  const categories = groupBy(known, (fact) => fact.category);

  return (
    <Card
      testID="facts-known"
      title="What I know"
      right={facts ? `${known.length} on file` : undefined}
      footnote={error ? { text: error, warn: true } : writeError}
    >
      {facts === null && !error && <Line label="Facts" value="reading…" dim />}
      {facts && known.length === 0 && (
        <Text style={s.empty}>Nothing on file yet. Tell the assistant something below, or ask it to remember something in chat.</Text>
      )}

      {categories.map(([category, rows]) => (
        <Group key={category} label={category} testID={`facts-category-${category}`}>
          {rows.map((fact) => (
            <View key={fact.id} style={s.item} testID={`facts-known-${fact.id}`}>
              <View style={s.itemHead}>
                <FactText fact={fact} withCategory={false} />
                <SmallButton
                  label="Forget"
                  tone={colors.error}
                  onPress={() => onForget(fact)}
                  disabled={busy !== null}
                  testID={`facts-forget-${fact.id}`}
                  accessibilityLabel={`Forget ${fact.category} / ${fact.key}`}
                />
              </View>
            </View>
          ))}
        </Group>
      ))}
    </Card>
  );
}

function AddCard({
  busy,
  error,
  onAdd,
}: {
  busy: number | "all" | "add" | null;
  error: Note | undefined;
  onAdd: (input: { category: string; key: string; value: string }) => Promise<boolean>;
}) {
  const [category, setCategory] = useState("");
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");

  const ready = category.trim() !== "" && key.trim() !== "" && value.trim() !== "";
  const adding = busy === "add";

  const add = async () => {
    if (!ready || busy !== null) return;
    // Cleared only once it is on file; a refusal leaves the words to fix.
    if (await onAdd({ category, key, value })) {
      setKey("");
      setValue("");
    }
  };

  const field = (label: string, text: string, set: (t: string) => void, placeholder: string, wide = false) => (
    <TextInput
      value={text}
      onChangeText={set}
      onSubmitEditing={add}
      placeholder={placeholder}
      placeholderTextColor={colors.textDim}
      autoComplete="off"
      editable={!adding}
      accessibilityLabel={label}
      style={[s.input, wide && s.inputWide]}
      testID={`facts-add-${label.toLowerCase()}`}
    />
  );

  return (
    <Card testID="facts-add" title="Tell me something" right="on file at once" footnote={error}>
      <View style={s.addRow}>
        {field("Category", category, setCategory, "food")}
        {field("Key", key, setKey, "coffee")}
      </View>
      {field("Value", value, setValue, "Black, no sugar.", true)}
      <Button label={adding ? "Saving…" : "Add fact"} onPress={add} disabled={!ready || busy !== null} testID="facts-add-submit" />
    </Card>
  );
}

/** "key: value" with its date, source and confidence under it. */
function FactText({ fact, withCategory = true }: { fact: Fact; withCategory?: boolean }) {
  return (
    <View style={s.factText}>
      <Text style={s.claim}>
        <Text style={s.subject}>{withCategory ? `${fact.category} / ${fact.key}` : fact.key}: </Text>
        {fact.value}
      </Text>
      <Text style={[s.detail, fact.confidence === "inferred" && s.inferred]}>
        {[learned(fact.learned_at), SOURCE[fact.source], fact.confidence].join(" · ")}
      </Text>
    </View>
  );
}

const SOURCE = {
  chat: "from chat",
  voice: "from voice",
  manual: "typed here",
  extracted: "picked up from a conversation",
} satisfies Record<Fact["source"], string>;

function SmallButton({
  label,
  onPress,
  disabled,
  tone = colors.accentTxt,
  testID,
  accessibilityLabel,
}: {
  label: string;
  onPress: () => void;
  disabled: boolean;
  tone?: string;
  testID: string;
  accessibilityLabel: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      style={({ hovered }: any) => [s.small, hovered && !disabled && s.smallHovered, disabled && s.disabled]}
      testID={testID}
    >
      <Text style={[s.smallText, { color: tone }]}>{label}</Text>
    </Pressable>
  );
}

function Button({
  label,
  onPress,
  disabled,
  testID,
}: {
  label: string;
  onPress: () => void;
  disabled: boolean;
  testID: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      style={({ hovered }: any) => [s.button, hovered && !disabled && s.buttonHovered, disabled && s.disabled]}
      testID={testID}
    >
      <Text style={s.buttonText}>{label}</Text>
    </Pressable>
  );
}

/** Groups in first-seen order — the server sends the facts sorted by category. */
function groupBy<T>(rows: T[], by: (row: T) => string): [string, T[]][] {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = by(row);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.entries()];
}

/** When a fact came up, as a date on this browser's clock. */
function learned(iso: string | null): string {
  if (iso === null) return "undated";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "—";
  return at.toLocaleDateString(undefined, { dateStyle: "medium" });
}

const s = {
  ...statStyles,
  ...StyleSheet.create({
    empty: { ...type.small, color: colors.textDim },

    item: { gap: spacing.xs },
    itemHead: { flexDirection: "row", alignItems: "flex-start", gap: spacing.sm },
    factText: { flex: 1, minWidth: 0, gap: 2 },
    claim: { ...type.small, color: colors.text },
    subject: { color: colors.textMuted, fontWeight: "600" },
    detail: { ...type.caption, color: colors.textDim },
    inferred: { fontStyle: "italic" },
    actions: { flexDirection: "row", gap: spacing.xs },

    small: { paddingHorizontal: spacing.sm, paddingVertical: 4, borderRadius: radii.sm },
    smallHovered: { backgroundColor: colors.bg },
    smallText: { fontSize: 12, fontWeight: "600" },

    addRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
    input: {
      flexGrow: 1,
      flexBasis: 120,
      minWidth: 0,
      fontSize: 13,
      color: colors.text,
      backgroundColor: colors.bg,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: radii.md,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
    },
    inputWide: { flexBasis: "auto" },

    button: {
      alignSelf: "flex-start",
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radii.md,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
    },
    buttonHovered: { borderColor: colors.accent, backgroundColor: colors.accentBg },
    buttonText: { fontSize: 13, fontWeight: "600", color: colors.text },
    disabled: { opacity: 0.45 },
  }),
};
