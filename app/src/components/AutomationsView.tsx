import React, { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import {
  AUTOMATION_CONTEXT,
  Automation,
  AutomationContext,
  AutomationInput,
  AutomationPatch,
  api,
  errorMessage,
} from "../api";
import * as fmt from "../hudFormat";
import { colors, radii, spacing, type } from "../theme";
import ConfirmDialog from "./ConfirmDialog";
import DateTimeInput from "./DateTimeInput";
import { normaliseTime } from "./FitnessSettings";
import { Card, Group, Line, Note, StatPage, statStyles } from "./StatParts";

/**
 * Automations: the conversations the assistant opens on its own.
 *
 * The core menu's Automations title opens it. One card per row — name, time,
 * on/off, what it is for, what it may bring with it, and how the last run went
 * — plus a card for adding one. A row is **when** and **what for**; there is no
 * condition language, because an automation always speaks. Whether something is
 * worth speaking about unprompted is the 07:00 nudge's job, and merging the two
 * would mean inventing one.
 *
 * **Delivered on the HUD's first load past its time**, never a cron tick: a
 * greeting written at 06:30 and found at 09:00 is a message timestamped before
 * anyone sat down. So a row that fired at 06:30 but was not collected until
 * 09:00 shows the hour it *ran*, which is when the HUD asked for it.
 *
 * **Nothing here is optimistic**, for `useServerSettings`' reason. Every write
 * waits for its answer and the page redraws from the list, so a time that
 * looked saved and was not cannot sit on screen until the morning it fails to
 * fire. One write is out at a time, and it disables every button on the page.
 *
 * **The text fields are drafts, committed on blur** — the nudge time's rule.
 * A field that wrote on every keystroke would be one request per character and
 * a name of "M", "Mo", "Mor" on the server in between. What they resync from is
 * the row's values **and a counter this page bumps on every write**, which is
 * the pair that makes both halves true: a rename the server trimmed, or refused
 * outright, is pulled back to what is stored rather than left on screen looking
 * saved, while the re-reads the Run-now loop makes in the background change
 * nothing and so leave a half-typed field alone.
 *
 * **Run now is watched, not assumed.** The endpoint answers as soon as the job
 * is queued; what actually happened is written by a worker seconds later. So
 * the row is re-read on a short bounded loop until its `last_run_at` moves, and
 * the card says it is waiting meanwhile. Nothing polls otherwise: a row changes
 * when someone changes it, or when it runs.
 */
export default function AutomationsView({ active }: { active: boolean }) {
  const [rows, setRows] = useState<Automation[] | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  // Which write is out: a row's id, or "new" for the add card.
  const [busy, setBusy] = useState<number | "new" | null>(null);
  const [writeError, setWriteError] = useState<{ at: number | "new"; text: string } | null>(null);
  const [deleting, setDeleting] = useState<Automation | null>(null);
  // Bumped by every write, and by nothing else. See the drafts, above.
  const [written, setWritten] = useState(0);
  // A row whose Run now has been queued and whose outcome has not landed yet.
  const [waiting, setWaiting] = useState<{ id: number; since: string | null } | null>(null);

  const reload = useCallback(async () => {
    try {
      setRows((await api.listAutomations()).data);
      setReadError(null);
    } catch (e) {
      setReadError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    if (active) reload();
  }, [active, reload]);

  /** Run one write, then re-read whatever it did or did not do. */
  const write = async (which: number | "new", fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(which);
    setWriteError(null);
    let ok = true;
    try {
      await fn();
    } catch (e) {
      ok = false;
      setWriteError({ at: which, text: errorMessage(e) });
    }
    await reload();
    setWritten((v) => v + 1);
    setBusy(null);
    return ok;
  };

  const patch = (row: Automation, changes: AutomationPatch) =>
    write(row.id, () => api.updateAutomation(row.id, changes));

  const runNow = async (row: Automation) => {
    const since = row.last_run_at;
    if (await write(row.id, () => api.runAutomation(row.id))) setWaiting({ id: row.id, since });
  };

  const remove = async () => {
    if (!deleting) return;
    const row = deleting;
    await write(row.id, () => api.deleteAutomation(row.id));
    setDeleting(null);
  };

  // The worker's answer to Run now, collected rather than waited for. Bounded
  // both ways: it gives up after `RUN_TRIES` and stops the moment the row moves,
  // so a dead queue worker costs a handful of cheap reads, not a loop all day.
  const tries = useRef(0);
  const row = rows?.find((r) => r.id === waiting?.id) ?? null;
  const landed = waiting !== null && (row === null || row.last_run_at !== waiting.since);

  useEffect(() => {
    if (waiting === null) return;
    if (landed) {
      setWaiting(null);
      return;
    }

    tries.current = 0;
    const timer = setInterval(() => {
      if (++tries.current > RUN_TRIES) {
        setWaiting(null);
        return;
      }
      reload();
    }, RUN_POLL_MS);

    return () => clearInterval(timer);
  }, [waiting, landed, reload]);

  return (
    <StatPage testID="automations-view">
      {rows === null && !readError && <Card testID="automations-loading" title="Automations">
        <Line label="Rows" value="reading…" dim />
      </Card>}

      {readError && (
        <Card testID="automations-error" title="Automations" footnote={{ text: readError, warn: true }}>
          <Line label="Rows" value="—" dim />
        </Card>
      )}

      {rows?.length === 0 && (
        <Card testID="automations-empty" title="Nothing scheduled">
          <Text style={s.empty}>
            Nothing runs on its own yet. Add one below and it will open a conversation the first time
            you look at the HUD after its hour.
          </Text>
        </Card>
      )}

      {(rows ?? []).map((automation) => (
        <AutomationCard
          key={automation.id}
          automation={automation}
          written={written}
          busy={busy}
          waiting={waiting?.id === automation.id}
          error={writeError?.at === automation.id ? writeError.text : null}
          onPatch={(changes) => patch(automation, changes)}
          onRun={() => runNow(automation)}
          onDelete={() => setDeleting(automation)}
        />
      ))}

      {rows !== null && (
        <AddCard
          busy={busy}
          error={writeError?.at === "new" ? writeError.text : null}
          onAdd={(input) => write("new", () => api.createAutomation(input))}
        />
      )}

      <ConfirmDialog
        visible={deleting !== null}
        title={`Delete ${deleting?.name ?? "this automation"}?`}
        message="It stops running. The conversations it has already opened stay where they are."
        confirmLabel="Delete"
        destructive
        loading={deleting !== null && busy === deleting.id}
        onConfirm={remove}
        onCancel={() => setDeleting(null)}
      />
    </StatPage>
  );
}

/** How often the row is re-read after Run now, and how many times at most. */
const RUN_POLL_MS = 3_000;
const RUN_TRIES = 10;

function AutomationCard({
  automation,
  written,
  busy,
  waiting,
  error,
  onPatch,
  onRun,
  onDelete,
}: {
  automation: Automation;
  /** How many writes this page has made. A draft resyncs on each one. */
  written: number;
  busy: number | "new" | null;
  waiting: boolean;
  error: string | null;
  onPatch: (changes: AutomationPatch) => Promise<boolean>;
  onRun: () => void;
  onDelete: () => void;
}) {
  const { id, name, time, intent } = automation;
  const [nameDraft, setNameDraft] = useState(name);
  const [timeDraft, setTimeDraft] = useState(time);
  const [intentDraft, setIntentDraft] = useState(intent);
  const [timeError, setTimeError] = useState<string | null>(null);

  // The values and the write counter, never the row object: a background
  // re-read that changes nothing leaves a half-typed field alone, and every
  // write — including one the server refused — puts the field back to what is
  // stored. Keyed on the row itself, the Run-now loop would wipe the field
  // mid-sentence; keyed on the values alone, a refused rename would stay up.
  useEffect(() => setNameDraft(name), [name, written]);
  useEffect(() => setTimeDraft(time), [time, written]);
  useEffect(() => setIntentDraft(intent), [intent, written]);

  const locked = busy !== null;

  const commitTime = () => {
    // The picker hands back a whole time or an empty string, so an emptied
    // field is a clear rather than a mistake: the stored value goes back,
    // exactly as an emptied name or intent does. `normaliseTime` stays because
    // it is what says the value is well-formed at all.
    if (timeDraft.trim() === "") {
      setTimeDraft(time);
      setTimeError(null);
      return;
    }
    const next = normaliseTime(timeDraft);
    if (next === null) {
      setTimeError("Use a 24-hour time, like 06:30.");
      return;
    }
    setTimeDraft(next);
    setTimeError(null);
    if (next !== time) onPatch({ time: next });
  };

  const commitText = (key: "name" | "intent", draft: string, stored: string, reset: (t: string) => void) => {
    const next = draft.trim();
    // An empty name or intent is a 422; putting the stored one back says so
    // without a sentence, because there is nothing here to correct.
    if (next === "") {
      reset(stored);
      return;
    }
    if (next !== stored) onPatch({ [key]: next } as AutomationPatch);
  };

  const failure = automation.last_outcome === "failed" ? automation.last_error : null;
  const footnote: Note | undefined = error
    ? { text: error, warn: true }
    : timeError
      ? { text: timeError, warn: true }
      : failure
        ? { text: failure, warn: true }
        : undefined;

  return (
    <Card
      testID={`automation-${id}`}
      title={name}
      right={automation.enabled ? time : "switched off"}
      footnote={footnote}
    >
      <View style={s.head}>
        <View style={s.headText}>
          <Text style={s.label}>Runs on its own</Text>
          <Text style={s.desc}>The first time you open the HUD after {time}, once a day.</Text>
        </View>
        <Switch
          value={automation.enabled}
          disabled={locked}
          onValueChange={(enabled) => void onPatch({ enabled })}
          accessibilityLabel={`${name} runs on its own`}
          trackColor={{ true: colors.accent, false: colors.borderHi }}
          testID={`automation-${id}-enabled`}
        />
      </View>

      <View style={s.fields}>
        <TextInput
          value={nameDraft}
          onChangeText={setNameDraft}
          onBlur={() => commitText("name", nameDraft, name, setNameDraft)}
          onSubmitEditing={() => commitText("name", nameDraft, name, setNameDraft)}
          editable={!locked}
          accessibilityLabel={`${name} name`}
          style={[s.input, s.nameInput]}
          testID={`automation-${id}-name`}
        />
        <DateTimeInput
          kind="time"
          value={timeDraft}
          onChangeText={(text) => {
            setTimeDraft(text);
            setTimeError(null);
          }}
          onBlur={commitTime}
          onSubmitEditing={commitTime}
          editable={!locked}
          accessibilityLabel={`${name} time`}
          style={[s.input, s.timeInput]}
          testID={`automation-${id}-time`}
        />
      </View>

      <TextInput
        value={intentDraft}
        onChangeText={setIntentDraft}
        onBlur={() => commitText("intent", intentDraft, intent, setIntentDraft)}
        multiline
        numberOfLines={3}
        editable={!locked}
        placeholder="What it is for, in your own words."
        placeholderTextColor={colors.textDim}
        accessibilityLabel={`${name} intent`}
        style={[s.input, s.intentInput]}
        testID={`automation-${id}-intent`}
      />

      <ContextToggles
        testPrefix={`automation-${id}`}
        label={`${name} brings`}
        chosen={automation.context}
        disabled={locked}
        onChange={(context) => onPatch({ context })}
      />

      <Line
        testID={`automation-${id}-last-run`}
        label="Last run"
        value={waiting ? "waiting on the worker…" : lastRun(automation)}
        tone={automation.last_outcome === "failed" ? colors.error : undefined}
      />

      <View style={s.actions}>
        <SmallButton
          label={waiting ? "Queued…" : "Run now"}
          onPress={onRun}
          disabled={locked || waiting}
          testID={`automation-${id}-run`}
          accessibilityLabel={`Run ${name} now`}
        />
        <SmallButton
          label="Delete"
          tone={colors.error}
          onPress={onDelete}
          disabled={locked}
          testID={`automation-${id}-delete`}
          accessibilityLabel={`Delete ${name}`}
        />
      </View>
    </Card>
  );
}

function AddCard({
  busy,
  error,
  onAdd,
}: {
  busy: number | "new" | null;
  error: string | null;
  onAdd: (input: AutomationInput) => Promise<boolean>;
}) {
  const [name, setName] = useState("");
  const [time, setTime] = useState("");
  const [intent, setIntent] = useState("");
  const [context, setContext] = useState<AutomationContext[]>(["agenda"]);
  const [timeError, setTimeError] = useState<string | null>(null);

  const adding = busy === "new";
  const ready = name.trim() !== "" && time.trim() !== "" && intent.trim() !== "";

  const add = async () => {
    if (!ready || busy !== null) return;
    const at = normaliseTime(time);
    if (at === null) {
      setTimeError("Use a 24-hour time, like 06:30.");
      return;
    }
    setTimeError(null);
    // Added switched off, like the seeded row: a conversation that starts
    // arriving before its intent has been read back is a surprise, and turning
    // it on is one press away.
    if (await onAdd({ name: name.trim(), time: at, intent: intent.trim(), context, enabled: false })) {
      setName("");
      setTime("");
      setIntent("");
      setContext(["agenda"]);
    }
  };

  return (
    <Card
      testID="automation-new"
      title="New automation"
      right="added switched off"
      footnote={error ? { text: error, warn: true } : timeError ? { text: timeError, warn: true } : undefined}
    >
      <View style={s.fields}>
        <TextInput
          value={name}
          onChangeText={setName}
          editable={!adding}
          placeholder="Evening wrap-up"
          placeholderTextColor={colors.textDim}
          accessibilityLabel="New automation name"
          style={[s.input, s.nameInput]}
          testID="automation-new-name"
        />
        <DateTimeInput
          kind="time"
          value={time}
          onChangeText={(text) => {
            setTime(text);
            setTimeError(null);
          }}
          editable={!adding}
          accessibilityLabel="New automation time"
          style={[s.input, s.timeInput]}
          testID="automation-new-time"
        />
      </View>

      <TextInput
        value={intent}
        onChangeText={setIntent}
        multiline
        numberOfLines={3}
        editable={!adding}
        placeholder="What it is for, in your own words."
        placeholderTextColor={colors.textDim}
        accessibilityLabel="New automation intent"
        style={[s.input, s.intentInput]}
        testID="automation-new-intent"
      />

      <ContextToggles
        testPrefix="automation-new"
        label="It brings"
        chosen={context}
        disabled={adding}
        onChange={setContext}
      />

      <SmallButton
        label={adding ? "Adding…" : "Add automation"}
        onPress={add}
        disabled={!ready || busy !== null}
        testID="automation-new-submit"
        accessibilityLabel="Add automation"
      />
    </Card>
  );
}

/**
 * What the row asks Laravel to fetch and put in front of the model before it
 * writes a word.
 *
 * **Facts is a readout, not a toggle.** `Automation::CONTEXT` carries it, but
 * the runner fetches nothing for it — what the assistant knows about the owner
 * is in the system prompt on every turn already. A switch that changes nothing
 * is a control that lies, and leaving it out entirely would draw the row as
 * something it is not, so it is stated instead. A value stored against it is
 * kept: only the fetched pieces are ever rewritten.
 */
function ContextToggles({
  testPrefix,
  label,
  chosen,
  disabled,
  onChange,
}: {
  testPrefix: string;
  label: string;
  chosen: AutomationContext[];
  disabled: boolean;
  onChange: (context: AutomationContext[]) => void;
}) {
  const toggle = (piece: AutomationContext, on: boolean) => {
    const next = new Set(chosen);
    if (on) next.add(piece);
    else next.delete(piece);
    // Rebuilt in the server's own order, and anything not offered here — facts
    // — survives untouched because it is read out of `chosen`.
    onChange(AUTOMATION_CONTEXT.filter((p) => next.has(p)));
  };

  return (
    <Group label={label} testID={`${testPrefix}-context`}>
      {FETCHED.map((piece) => (
        <View key={piece} style={s.contextRow}>
          <View style={s.headText}>
            <Text style={s.label}>{CONTEXT_COPY[piece].label}</Text>
            <Text style={s.desc}>{CONTEXT_COPY[piece].description}</Text>
          </View>
          <Switch
            value={chosen.includes(piece)}
            disabled={disabled}
            onValueChange={(on) => toggle(piece, on)}
            accessibilityLabel={CONTEXT_COPY[piece].label}
            trackColor={{ true: colors.accent, false: colors.borderHi }}
            testID={`${testPrefix}-context-${piece}`}
          />
        </View>
      ))}
      <Line label="Facts" value="always" dim testID={`${testPrefix}-context-facts`} />
    </Group>
  );
}

/** The pieces the runner actually fetches. See `ContextToggles`. */
const FETCHED = ["agenda", "weather", "training", "deadlines", "news"] as const;

const CONTEXT_COPY: Record<AutomationContext, { label: string; description: string }> = {
  agenda: { label: "Agenda", description: "Today's events, from your calendars." },
  weather: { label: "Weather", description: "The forecast where you are." },
  training: { label: "Training", description: "The last four weeks in the log." },
  deadlines: { label: "Deadlines", description: "Anything overdue, and what is due in the next two weeks." },
  news: { label: "News", description: "The local news, then your interests if you have set any." },
  facts: { label: "Facts", description: "What it knows about you — in every conversation anyway." },
};

/**
 * One line of what is true about a row's last run, in the order that matters.
 *
 * **A run that happened is reported, switched on or not.** Run now works on a
 * row that is switched off, and "switched off" in place of its outcome made the
 * press look like it had done nothing (checked live, 19.5). The card's head
 * already says the row is off, so here "switched off" only stands in for
 * "never". **Skipped is not a failure** — it is the Anthropic switch, a
 * decision, and calling it a fault would teach the line to be ignored. The
 * failure's own message is a footnote rather than a value, because it is a
 * sentence, not a reading.
 */
export function lastRun(automation: Automation, now: Date = new Date()): string {
  if (automation.last_run_at === null) return automation.enabled ? "never" : "switched off";

  const at = Date.parse(automation.last_run_at);
  const ago = Number.isNaN(at) ? "—" : fmt.age((now.getTime() - at) / 1000);

  if (automation.last_outcome === "failed") return `failed ${ago}`;
  if (automation.last_outcome === "skipped") return `skipped ${ago} — Anthropic off`;

  return ago;
}

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

const s = {
  ...statStyles,
  ...StyleSheet.create({
    empty: { ...type.small, color: colors.textDim },

    head: { flexDirection: "row", alignItems: "flex-start", gap: spacing.md },
    headText: { flex: 1, minWidth: 0, gap: 2 },
    label: { ...type.small, color: colors.text, fontWeight: "500" },
    desc: { ...type.caption, color: colors.textDim },

    contextRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },

    fields: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
    input: {
      fontSize: 13,
      color: colors.text,
      backgroundColor: colors.bg,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: radii.md,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
    },
    nameInput: { flex: 1, minWidth: 0 },
    // Wide enough for the browser's own time control, which draws two
    // spinnable fields and a clock indicator inside the box the app gives it —
    // at the 72px a typed `06:30` needed, the indicator is what gets clipped.
    timeInput: { width: 116, textAlign: "center", fontVariant: ["tabular-nums"] },
    intentInput: { minHeight: 64, textAlignVertical: "top" },

    actions: { flexDirection: "row", gap: spacing.xs },
    small: { paddingHorizontal: spacing.sm, paddingVertical: 4, borderRadius: radii.sm, alignSelf: "flex-start" },
    smallHovered: { backgroundColor: colors.bg },
    smallText: { fontSize: 12, fontWeight: "600" },
    disabled: { opacity: 0.45 },
  }),
};
