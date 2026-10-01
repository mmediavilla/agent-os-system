import React, { useCallback, useEffect, useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import { DEADLINE_KINDS, Deadline, DeadlineInput, DeadlinePatch, FiledDocument, api, errorMessage } from "../api";
import { colors, spacing } from "../theme";
import ConfirmDialog from "./ConfirmDialog";
import Dropdown from "./Dropdown";
import {
  DATE_HINT,
  DATE_SHAPE,
  DateField,
  SmallButton,
  kindOptions,
  localToday,
  openFile,
  recordStyles,
} from "./RecordsParts";
import { Card, Line, Note, StatPage, statStyles } from "./StatParts";

/**
 * Records → Deadlines: the dates somebody must act on.
 *
 * One card per open deadline, soonest first, **overdue in amber**; the add
 * card; and the completed ones **collapsed behind a toggle** on a card of their
 * own, each with Reopen. The order is the server's (`inAgendaOrder`), which is
 * also what `list_deadlines` reads, so the tab and the assistant cannot
 * disagree about what comes next.
 *
 * **Overdue is read off this browser's clock**, never sent by the API — the
 * calendar's rule: a server-side "today" rolls over at 08:00 in Manila.
 *
 * **Nothing is optimistic**, `DocumentsView`'s rules exactly: one write out at
 * a time, the page redrawn from a re-read after every write, and text fields as
 * drafts committed on blur, resynced from the row's values *and* a write
 * counter. **Done is a write like any other** — a deadline drawn as done that
 * was not is found out on the day it mattered. Only Delete asks first: Done is
 * one press of Reopen away, and a delete loses the date it was done on.
 *
 * **A completed deadline is not edited in place.** It is history — "when did I
 * last renew this" — so its card is a line and a Reopen; changing one means
 * reopening it, which says so.
 */
export default function DeadlinesView({ active }: { active: boolean }) {
  const [rows, setRows] = useState<Deadline[] | null>(null);
  // For the link picker only. A failed read leaves it empty rather than failing
  // the tab — a deadline is readable without the cabinet, and its own linked
  // document arrives on the row.
  const [documents, setDocuments] = useState<FiledDocument[]>([]);
  const [readError, setReadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | "new" | null>(null);
  const [writeError, setWriteError] = useState<{ at: number | "new"; text: string } | null>(null);
  const [confirming, setConfirming] = useState<Deadline | null>(null);
  const [showCompleted, setShowCompleted] = useState(false);
  const [written, setWritten] = useState(0);

  const reload = useCallback(async () => {
    const [deadlines, docs] = await Promise.allSettled([api.listDeadlines(), api.listDocuments()]);
    if (deadlines.status === "fulfilled") {
      setRows(deadlines.value.data);
      setReadError(null);
    } else {
      setReadError(errorMessage(deadlines.reason));
    }
    if (docs.status === "fulfilled") setDocuments(docs.value.data);
  }, []);

  useEffect(() => {
    if (active) reload();
  }, [active, reload]);

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

  const confirm = async () => {
    if (!confirming) return;
    await write(confirming.id, () => api.deleteDeadline(confirming.id));
    setConfirming(null);
  };

  const today = localToday();
  const open = (rows ?? []).filter((d) => d.completed_at === null);
  const completed = (rows ?? []).filter((d) => d.completed_at !== null);

  return (
    <StatPage testID="deadlines-view">
      {rows === null && !readError && (
        <Card testID="deadlines-loading" title="Deadlines">
          <Line label="Deadlines" value="reading…" dim />
        </Card>
      )}

      {readError && (
        <Card testID="deadlines-error" title="Deadlines" footnote={{ text: readError, warn: true }}>
          <Line label="Deadlines" value="—" dim />
        </Card>
      )}

      {rows !== null && open.length === 0 && (
        <Card testID="deadlines-empty" title="Nothing due">
          <Text style={s.empty}>
            {completed.length === 0
              ? "Nothing is tracked yet. Add a renewal, a filing or a payment below, and the assistant can tell you what is coming up."
              : "Everything tracked is done."}
          </Text>
        </Card>
      )}

      {open.map((deadline) => (
        <DeadlineCard
          key={deadline.id}
          deadline={deadline}
          documents={documents}
          today={today}
          written={written}
          busy={busy}
          error={writeError?.at === deadline.id ? writeError.text : null}
          onPatch={(changes) => write(deadline.id, () => api.updateDeadline(deadline.id, changes))}
          onComplete={() => write(deadline.id, () => api.completeDeadline(deadline.id))}
          onDelete={() => setConfirming(deadline)}
        />
      ))}

      {rows !== null && (
        <AddCard
          documents={documents}
          busy={busy}
          error={writeError?.at === "new" ? writeError.text : null}
          onAdd={(input) => write("new", () => api.createDeadline(input))}
        />
      )}

      {completed.length > 0 && (
        <Card
          testID="deadlines-completed"
          title="Completed"
          right={String(completed.length)}
          footnote={
            writeError && completed.some((d) => d.id === writeError.at)
              ? { text: writeError.text, warn: true }
              : undefined
          }
        >
          <SmallButton
            label={showCompleted ? "Hide" : "Show"}
            onPress={() => setShowCompleted((v) => !v)}
            disabled={false}
            testID="deadlines-completed-toggle"
            accessibilityLabel={showCompleted ? "Hide completed deadlines" : "Show completed deadlines"}
          />
          {showCompleted &&
            completed.map((d) => (
              <View key={d.id} style={s.doneRow} testID={`deadline-${d.id}`}>
                <View style={s.doneLine}>
                  <Line label={d.title} value={`done ${localToday(new Date(d.completed_at!))}`} dim />
                </View>
                <SmallButton
                  label="Reopen"
                  onPress={() => void write(d.id, () => api.reopenDeadline(d.id))}
                  disabled={busy !== null}
                  testID={`deadline-${d.id}-reopen`}
                  accessibilityLabel={`Reopen ${d.title}`}
                />
              </View>
            ))}
        </Card>
      )}

      <ConfirmDialog
        visible={confirming !== null}
        title={`Delete ${confirming?.title ?? "this deadline"}?`}
        message={
          confirming?.document
            ? `The deadline goes; ${confirming.document.title} stays filed.`
            : "The deadline goes, and with it any record of when it was done."
        }
        confirmLabel="Delete"
        destructive
        loading={confirming !== null && busy === confirming.id}
        onConfirm={confirm}
        onCancel={() => setConfirming(null)}
      />
    </StatPage>
  );
}

/** Whole days from `from` to `to`, both `YYYY-MM-DD` — negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  const utc = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
  return Math.round((utc(to) - utc(from)) / 86_400_000);
}

/**
 * The card head's right-hand words. Counted in days on the wall calendar — a
 * deadline is due on a day, so "due today" holds until local midnight.
 */
export function dueLabel(dueOn: string, today: string = localToday()): string {
  const days = daysBetween(today, dueOn);
  if (days < 0) return `overdue ${-days} ${-days === 1 ? "day" : "days"}`;
  if (days === 0) return "due today";
  if (days === 1) return "due tomorrow";
  return `in ${days} days`;
}

/**
 * Every filed document by title, plus the one the row points at if the list
 * does not hold it (a failed read) — so a linked document is never shown as
 * no document.
 */
function documentOptions(documents: FiledDocument[], linked: FiledDocument | null) {
  const list = linked && !documents.some((d) => d.id === linked.id) ? [...documents, linked] : documents;
  return list.map((d) => ({ value: String(d.id), label: d.title }));
}

function DeadlineCard({
  deadline,
  documents,
  today,
  written,
  busy,
  error,
  onPatch,
  onComplete,
  onDelete,
}: {
  deadline: Deadline;
  documents: FiledDocument[];
  today: string;
  written: number;
  busy: number | "new" | null;
  error: string | null;
  onPatch: (changes: DeadlinePatch) => Promise<boolean>;
  onComplete: () => void;
  onDelete: () => void;
}) {
  const { id, title, kind, due_on, document } = deadline;
  const [titleDraft, setTitleDraft] = useState(title);
  const [dueDraft, setDueDraft] = useState(due_on);
  const [notesDraft, setNotesDraft] = useState(deadline.notes ?? "");
  const [dateError, setDateError] = useState<string | null>(null);

  useEffect(() => setTitleDraft(title), [title, written]);
  useEffect(() => setDueDraft(due_on), [due_on, written]);
  useEffect(() => setNotesDraft(deadline.notes ?? ""), [deadline.notes, written]);

  const locked = busy !== null;
  const overdue = due_on < today;

  const commitTitle = () => {
    const next = titleDraft.trim();
    if (next === "") {
      setTitleDraft(title);
      return;
    }
    if (next !== title) onPatch({ title: next });
  };

  // Unlike a document's dates, the due date is required: an emptied field puts
  // the stored date back, as an emptied title does.
  const commitDue = () => {
    const next = dueDraft.trim();
    if (next === "") {
      setDueDraft(due_on);
      setDateError(null);
      return;
    }
    if (!DATE_SHAPE.test(next)) {
      setDateError(DATE_HINT);
      return;
    }
    setDateError(null);
    if (next !== due_on) onPatch({ due_on: next });
  };

  const commitNotes = () => {
    const next = notesDraft.trim();
    if (next !== (deadline.notes ?? "")) onPatch({ notes: next === "" ? null : next });
  };

  const footnote: Note | undefined = error
    ? { text: error, warn: true }
    : dateError
      ? { text: dateError, warn: true }
      : undefined;

  return (
    <Card testID={`deadline-${id}`} title={title} right={dueLabel(due_on, today)} footnote={footnote}>
      {/* Only when it has passed: otherwise the head's countdown and the Due
          field already say it, and a third "Due" is noise. */}
      {overdue && (
        <Line testID={`deadline-${id}-overdue`} label="Overdue" value={`since ${due_on}`} tone={colors.amber} />
      )}
      {document && (
        <View style={s.docRow}>
          <View style={s.doneLine}>
            <Line testID={`deadline-${id}-document`} label="About" value={document.title} />
          </View>
          {document.file_url && (
            <SmallButton
              label="Open"
              onPress={() => openFile(document.file_url!)}
              disabled={false}
              testID={`deadline-${id}-open`}
              accessibilityLabel={`Open ${document.title}`}
            />
          )}
        </View>
      )}

      <View style={s.fields}>
        <TextInput
          value={titleDraft}
          onChangeText={setTitleDraft}
          onBlur={commitTitle}
          onSubmitEditing={commitTitle}
          editable={!locked}
          accessibilityLabel={`${title} title`}
          style={[s.input, s.grow]}
          testID={`deadline-${id}-title`}
        />
        <View style={s.kind}>
          <Dropdown
            options={kindOptions(DEADLINE_KINDS, kind)}
            value={kind}
            onChange={(next) => {
              if (!locked && next !== "" && next !== kind) onPatch({ kind: next });
            }}
            title="Kind"
            testID={`deadline-${id}-kind`}
          />
        </View>
      </View>

      <View style={s.fields}>
        <DateField
          label="Due"
          value={dueDraft}
          onChange={(text) => {
            setDueDraft(text);
            setDateError(null);
          }}
          onCommit={commitDue}
          editable={!locked}
          accessibilityLabel={`${title} due on`}
          testID={`deadline-${id}-due-on`}
        />
        <View style={s.document}>
          <Text style={s.dateLabel}>Document</Text>
          <Dropdown
            options={documentOptions(documents, document)}
            value={deadline.document_id === null ? "" : String(deadline.document_id)}
            onChange={(next) => {
              const value = next === "" ? null : Number(next);
              if (!locked && value !== deadline.document_id) onPatch({ document_id: value });
            }}
            placeholder="None"
            clearLabel="No document"
            title="Document"
            testID={`deadline-${id}-document-picker`}
          />
        </View>
      </View>

      <TextInput
        value={notesDraft}
        onChangeText={setNotesDraft}
        onBlur={commitNotes}
        multiline
        numberOfLines={2}
        editable={!locked}
        placeholder="A line about it — where to pay, who to call, what to bring."
        placeholderTextColor={colors.textDim}
        accessibilityLabel={`${title} notes`}
        style={[s.input, s.notes]}
        testID={`deadline-${id}-notes`}
      />

      <View style={s.actions}>
        <SmallButton
          label="Done"
          onPress={onComplete}
          disabled={locked}
          testID={`deadline-${id}-complete`}
          accessibilityLabel={`Mark ${title} done`}
        />
        <SmallButton
          label="Delete"
          tone={colors.error}
          onPress={onDelete}
          disabled={locked}
          testID={`deadline-${id}-delete`}
          accessibilityLabel={`Delete ${title}`}
        />
      </View>
    </Card>
  );
}

function AddCard({
  documents,
  busy,
  error,
  onAdd,
}: {
  documents: FiledDocument[];
  busy: number | "new" | null;
  error: string | null;
  onAdd: (input: DeadlineInput) => Promise<boolean>;
}) {
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState("");
  const [due, setDue] = useState("");
  const [documentId, setDocumentId] = useState("");
  const [notes, setNotes] = useState("");
  const [dateError, setDateError] = useState<string | null>(null);

  const adding = busy === "new";
  const ready = title.trim() !== "" && kind !== "" && due.trim() !== "";

  const add = async () => {
    if (!ready || busy !== null) return;
    if (!DATE_SHAPE.test(due.trim())) {
      setDateError(DATE_HINT);
      return;
    }
    setDateError(null);
    const input: DeadlineInput = {
      title: title.trim(),
      kind,
      due_on: due.trim(),
      document_id: documentId === "" ? null : Number(documentId),
      notes: notes.trim() || null,
    };
    if (await onAdd(input)) {
      setTitle("");
      setKind("");
      setDue("");
      setDocumentId("");
      setNotes("");
    }
  };

  return (
    <Card
      testID="deadline-new"
      title="Track a deadline"
      footnote={error ? { text: error, warn: true } : dateError ? { text: dateError, warn: true } : undefined}
    >
      <View style={s.fields}>
        <TextInput
          value={title}
          onChangeText={setTitle}
          editable={!adding}
          placeholder="Renew car insurance"
          placeholderTextColor={colors.textDim}
          accessibilityLabel="New deadline title"
          style={[s.input, s.grow]}
          testID="deadline-new-title"
        />
        <View style={s.kind}>
          <Dropdown
            options={kindOptions(DEADLINE_KINDS, kind)}
            value={kind}
            onChange={(next) => setKind(next)}
            placeholder="Kind…"
            title="Kind"
            testID="deadline-new-kind"
          />
        </View>
      </View>

      <View style={s.fields}>
        <DateField
          label="Due"
          value={due}
          onChange={(text) => {
            setDue(text);
            setDateError(null);
          }}
          editable={!adding}
          accessibilityLabel="New deadline due on"
          testID="deadline-new-due"
        />
        <View style={s.document}>
          <Text style={s.dateLabel}>Document</Text>
          <Dropdown
            options={documentOptions(documents, null)}
            value={documentId}
            onChange={(next) => setDocumentId(next)}
            placeholder="None"
            clearLabel="No document"
            title="Document"
            testID="deadline-new-document"
          />
        </View>
      </View>

      <TextInput
        value={notes}
        onChangeText={setNotes}
        multiline
        numberOfLines={2}
        editable={!adding}
        placeholder="A line about it — optional."
        placeholderTextColor={colors.textDim}
        accessibilityLabel="New deadline notes"
        style={[s.input, s.notes]}
        testID="deadline-new-notes"
      />

      <View style={s.actions}>
        <SmallButton
          label={adding ? "Adding…" : "Track it"}
          onPress={add}
          disabled={!ready || busy !== null}
          testID="deadline-new-submit"
          accessibilityLabel="Track the deadline"
        />
      </View>
    </Card>
  );
}

const s = {
  ...statStyles,
  ...recordStyles,
  ...StyleSheet.create({
    document: { gap: 2, flexGrow: 1, flexBasis: 160 },
    docRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
    doneRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
    doneLine: { flex: 1, minWidth: 0 },
  }),
};
