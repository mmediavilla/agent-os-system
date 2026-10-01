import React, { useCallback, useEffect, useState } from "react";
import { Image, StyleSheet, Text, TextInput, View } from "react-native";
import { DOCUMENT_KINDS, DOCUMENT_MEDIA_TYPES, DocumentInput, DocumentPatch, FiledDocument, api, errorMessage } from "../api";
import * as fmt from "../hudFormat";
import { colors, radii, spacing, type } from "../theme";
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
 * Records → Documents: the filing cabinet.
 *
 * One card per document — its file, what it is, its dates and a line of notes —
 * plus a card for filing a new one. A document is a **filed artifact the
 * assistant can find**, not prose: the notes are a line about the thing, and
 * anything longer belongs in Obsidian.
 *
 * **Nothing here is optimistic**, for `useServerSettings`' reason and in
 * `AutomationsView`'s shape: every write waits for its answer, the page redraws
 * from the list, and one write is out at a time. **The text fields are drafts
 * committed on blur**, resynced from the row's values *and* a counter bumped on
 * every write, so a title the server trimmed or refused is pulled back rather
 * than left looking saved.
 *
 * **Fields and file travel separately**, as they do on the server: filing with a
 * file is create, then upload. When the upload fails the record is still saved,
 * so the add card clears and the failure is said on the new document's own
 * card, where Upload is one press away — not on a form that would file it twice.
 *
 * **The file opens in a tab through its signed URL**, which is the only way a
 * browser can fetch it: neither a link nor a new tab can send the bearer token.
 * A picture is also drawn on its card; a PDF is named, not embedded, because a
 * page of `<embed>`s is a page of PDF viewers.
 *
 * **Deleting asks first, and so does removing a file.** The plan named only
 * delete, but a removed scan is gone from the disk just as surely, and it is one
 * stray press on a card of buttons.
 */
export default function DocumentsView({ active }: { active: boolean }) {
  const [rows, setRows] = useState<FiledDocument[] | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  // Which write is out: a row's id, or "new" for the add card.
  const [busy, setBusy] = useState<number | "new" | null>(null);
  const [writeError, setWriteError] = useState<{ at: number | "new"; text: string } | null>(null);
  const [confirming, setConfirming] = useState<{ doc: FiledDocument; what: "document" | "file" } | null>(null);
  // Bumped by every write, and by nothing else. See the drafts, above.
  const [written, setWritten] = useState(0);

  const reload = useCallback(async () => {
    try {
      setRows((await api.listDocuments()).data);
      setReadError(null);
    } catch (e) {
      setReadError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    if (active) reload();
  }, [active, reload]);

  /**
   * Run one write, then re-read whatever it did or did not do. A failure lands
   * on `which`'s card unless it names another — see `add`.
   */
  const write = async (which: number | "new", fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(which);
    setWriteError(null);
    let ok = true;
    try {
      await fn();
    } catch (e) {
      ok = false;
      setWriteError({ at: (e as { at?: number }).at ?? which, text: errorMessage(e) });
    }
    await reload();
    setWritten((v) => v + 1);
    setBusy(null);
    return ok;
  };

  const patch = (doc: FiledDocument, changes: DocumentPatch) => write(doc.id, () => api.updateDocument(doc.id, changes));

  const upload = (doc: FiledDocument) =>
    pickFile((file) => void write(doc.id, () => api.uploadDocumentFile(doc.id, file)));

  /** Resolves true once the record exists, whether or not its file followed it. */
  const add = async (input: DocumentInput, file: File | null): Promise<boolean> => {
    let created = false;
    await write("new", async () => {
      const doc = await api.createDocument(input);
      created = true;
      if (!file) return;
      try {
        await api.uploadDocumentFile(doc.id, file);
      } catch (e) {
        throw Object.assign(new Error(`Filed without its file — ${errorMessage(e)}`), { at: doc.id });
      }
    });
    return created;
  };

  const confirm = async () => {
    if (!confirming) return;
    const { doc, what } = confirming;
    await write(doc.id, () => (what === "file" ? api.deleteDocumentFile(doc.id) : api.deleteDocument(doc.id)));
    setConfirming(null);
  };

  return (
    <StatPage testID="documents-view">
      {rows === null && !readError && (
        <Card testID="documents-loading" title="Documents">
          <Line label="Documents" value="reading…" dim />
        </Card>
      )}

      {readError && (
        <Card testID="documents-error" title="Documents" footnote={{ text: readError, warn: true }}>
          <Line label="Documents" value="—" dim />
        </Card>
      )}

      {rows?.length === 0 && (
        <Card testID="documents-empty" title="Nothing filed">
          <Text style={s.empty}>
            Nothing is filed yet. Add a passport, a policy or a receipt below, and the assistant can find
            it when you ask.
          </Text>
        </Card>
      )}

      {(rows ?? []).map((doc) => (
        <DocumentCard
          key={doc.id}
          doc={doc}
          written={written}
          busy={busy}
          error={writeError?.at === doc.id ? writeError.text : null}
          onPatch={(changes) => patch(doc, changes)}
          onUpload={() => upload(doc)}
          onRemoveFile={() => setConfirming({ doc, what: "file" })}
          onDelete={() => setConfirming({ doc, what: "document" })}
        />
      ))}

      {rows !== null && (
        <AddCard busy={busy} error={writeError?.at === "new" ? writeError.text : null} onAdd={add} />
      )}

      <ConfirmDialog
        visible={confirming !== null}
        title={
          confirming?.what === "file"
            ? `Remove the file from ${confirming.doc.title}?`
            : `Delete ${confirming?.doc.title ?? "this document"}?`
        }
        message={
          confirming?.what === "file"
            ? "The file is deleted from this machine. The record, its dates and its notes stay."
            : "The record and its file are both deleted from this machine."
        }
        confirmLabel={confirming?.what === "file" ? "Remove" : "Delete"}
        destructive
        loading={confirming !== null && busy === confirming.doc.id}
        onConfirm={confirm}
        onCancel={() => setConfirming(null)}
      />
    </StatPage>
  );
}

/**
 * Opens the browser's file chooser, the way Equipment's photo and the CSV import
 * do: React Native has no picker of its own. `accept` only steers the chooser —
 * what a file *is* is decided by the server from its bytes.
 */
function pickFile(onPick: (file: File) => void) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = DOCUMENT_MEDIA_TYPES.join(",");
  input.onchange = () => {
    const file = input.files?.[0];
    if (file) onPick(file);
  };
  input.click();
}

/**
 * The card head's right-hand word: when it expires, or that it has. A document
 * with no expiry says nothing — a receipt does not lapse.
 *
 * Compared as strings, which is exact for `YYYY-MM-DD`, and against the local
 * date rather than an instant, because a passport expires on a day.
 */
export function expiryLabel(expiresOn: string | null, today: string = localToday()): string | undefined {
  if (expiresOn === null) return undefined;
  return expiresOn < today ? `expired ${expiresOn}` : `expires ${expiresOn}`;
}

/** "PDF · 1.2 MB", or what little is known. */
export function fileLabel(doc: Pick<FiledDocument, "mime" | "size_bytes" | "file_url">): string {
  if (!doc.file_url) return "none";
  const kind = doc.mime === "application/pdf" ? "PDF" : (doc.mime?.replace("image/", "").toUpperCase() ?? "File");
  return doc.size_bytes === null ? kind : `${kind} · ${fmt.bytes(doc.size_bytes)}`;
}

function DocumentCard({
  doc,
  written,
  busy,
  error,
  onPatch,
  onUpload,
  onRemoveFile,
  onDelete,
}: {
  doc: FiledDocument;
  /** How many writes this page has made. A draft resyncs on each one. */
  written: number;
  busy: number | "new" | null;
  error: string | null;
  onPatch: (changes: DocumentPatch) => Promise<boolean>;
  onUpload: () => void;
  onRemoveFile: () => void;
  onDelete: () => void;
}) {
  const { id, title, kind } = doc;
  const [titleDraft, setTitleDraft] = useState(title);
  const [notesDraft, setNotesDraft] = useState(doc.notes ?? "");
  const [issuedDraft, setIssuedDraft] = useState(doc.issued_on ?? "");
  const [expiresDraft, setExpiresDraft] = useState(doc.expires_on ?? "");
  const [dateError, setDateError] = useState<string | null>(null);

  // The values and the write counter, never the row object — `AutomationsView`'s
  // rule, for its reasons.
  useEffect(() => setTitleDraft(title), [title, written]);
  useEffect(() => setNotesDraft(doc.notes ?? ""), [doc.notes, written]);
  useEffect(() => setIssuedDraft(doc.issued_on ?? ""), [doc.issued_on, written]);
  useEffect(() => setExpiresDraft(doc.expires_on ?? ""), [doc.expires_on, written]);

  const locked = busy !== null;

  const commitTitle = () => {
    const next = titleDraft.trim();
    // An empty title is a 422; putting the stored one back says so without a
    // sentence, because there is nothing here to correct.
    if (next === "") {
      setTitleDraft(title);
      return;
    }
    if (next !== title) onPatch({ title: next });
  };

  const commitNotes = () => {
    const next = notesDraft.trim();
    // Unlike a title, empty is an answer: the notes are cleared.
    if (next !== (doc.notes ?? "")) onPatch({ notes: next === "" ? null : next });
  };

  // An emptied date is a clear, not a mistake — a receipt has no expiry — so it
  // is sent as null. The picker hands back a whole date or nothing, and the
  // shape check is what says a typed value is well-formed at all.
  const commitDate = (key: "issued_on" | "expires_on", draft: string) => {
    const stored = doc[key] ?? "";
    const next = draft.trim();
    if (next !== "" && !DATE_SHAPE.test(next)) {
      setDateError(DATE_HINT);
      return;
    }
    setDateError(null);
    if (next !== stored) onPatch({ [key]: next === "" ? null : next } as DocumentPatch);
  };

  const footnote: Note | undefined = error
    ? { text: error, warn: true }
    : dateError
      ? { text: dateError, warn: true }
      : undefined;

  const picture = doc.file_url && doc.mime?.startsWith("image/") ? doc.file_url : null;
  const expired = doc.expires_on !== null && doc.expires_on < localToday();

  return (
    <Card testID={`document-${id}`} title={title} right={expiryLabel(doc.expires_on)} footnote={footnote}>
      <View style={s.file}>
        {picture ? (
          <Image
            source={{ uri: picture }}
            style={s.preview}
            resizeMode="contain"
            accessibilityLabel={`${title}, the filed picture`}
            testID={`document-${id}-preview`}
          />
        ) : (
          <View style={[s.preview, s.previewBlank]} testID={`document-${id}-preview`}>
            <Text style={s.previewText}>{doc.file_url ? "PDF" : "No file"}</Text>
          </View>
        )}

        <View style={s.fileSide}>
          <Line testID={`document-${id}-file`} label="File" value={fileLabel(doc)} dim={!doc.file_url} />
          {doc.expires_on && (
            <Line
              testID={`document-${id}-expiry`}
              label={expired ? "Expired" : "Expires"}
              value={doc.expires_on}
              tone={expired ? colors.amber : undefined}
            />
          )}
          <View style={s.actions}>
            {doc.file_url && (
              <SmallButton
                label="Open"
                onPress={() => openFile(doc.file_url!)}
                disabled={false}
                testID={`document-${id}-open`}
                accessibilityLabel={`Open ${title}`}
              />
            )}
            <SmallButton
              label={doc.file_url ? "Replace" : "Upload"}
              onPress={onUpload}
              disabled={locked}
              testID={`document-${id}-upload`}
              accessibilityLabel={doc.file_url ? `Replace the file for ${title}` : `Upload a file for ${title}`}
            />
            {doc.file_url && (
              <SmallButton
                label="Remove file"
                tone={colors.error}
                onPress={onRemoveFile}
                disabled={locked}
                testID={`document-${id}-remove-file`}
                accessibilityLabel={`Remove the file from ${title}`}
              />
            )}
          </View>
        </View>
      </View>

      <View style={s.fields}>
        <TextInput
          value={titleDraft}
          onChangeText={setTitleDraft}
          onBlur={commitTitle}
          onSubmitEditing={commitTitle}
          editable={!locked}
          accessibilityLabel={`${title} title`}
          style={[s.input, s.grow]}
          testID={`document-${id}-title`}
        />
        <View style={s.kind}>
          <Dropdown
            options={kindOptions(DOCUMENT_KINDS, kind)}
            value={kind}
            // No `disabled` on the dropdown, so a pick while a write is out is
            // dropped here — one write at a time.
            onChange={(next) => {
              if (!locked && next !== "" && next !== kind) onPatch({ kind: next });
            }}
            title="Kind"
            testID={`document-${id}-kind`}
          />
        </View>
      </View>

      <View style={s.fields}>
        <DateField
          label="Issued"
          value={issuedDraft}
          onChange={(text) => {
            setIssuedDraft(text);
            setDateError(null);
          }}
          onCommit={() => commitDate("issued_on", issuedDraft)}
          editable={!locked}
          accessibilityLabel={`${title} issued on`}
          testID={`document-${id}-issued`}
        />
        <DateField
          label="Expires"
          value={expiresDraft}
          onChange={(text) => {
            setExpiresDraft(text);
            setDateError(null);
          }}
          onCommit={() => commitDate("expires_on", expiresDraft)}
          editable={!locked}
          accessibilityLabel={`${title} expires on`}
          testID={`document-${id}-expires`}
        />
      </View>

      <TextInput
        value={notesDraft}
        onChangeText={setNotesDraft}
        onBlur={commitNotes}
        multiline
        numberOfLines={2}
        editable={!locked}
        placeholder="A line about it — the insurer, the policy number, where the original is."
        placeholderTextColor={colors.textDim}
        accessibilityLabel={`${title} notes`}
        style={[s.input, s.notes]}
        testID={`document-${id}-notes`}
      />

      <View style={s.actions}>
        <SmallButton
          label="Delete"
          tone={colors.error}
          onPress={onDelete}
          disabled={locked}
          testID={`document-${id}-delete`}
          accessibilityLabel={`Delete ${title}`}
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
  onAdd: (input: DocumentInput, file: File | null) => Promise<boolean>;
}) {
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState("");
  const [issued, setIssued] = useState("");
  const [expires, setExpires] = useState("");
  const [notes, setNotes] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [dateError, setDateError] = useState<string | null>(null);

  const adding = busy === "new";
  const ready = title.trim() !== "" && kind !== "";

  const add = async () => {
    if (!ready || busy !== null) return;
    const dates = [issued.trim(), expires.trim()];
    if (dates.some((d) => d !== "" && !DATE_SHAPE.test(d))) {
      setDateError(DATE_HINT);
      return;
    }
    setDateError(null);
    const input: DocumentInput = {
      title: title.trim(),
      kind,
      issued_on: dates[0] || null,
      expires_on: dates[1] || null,
      notes: notes.trim() || null,
    };
    // Cleared once the record exists, even if its file did not follow: the
    // failure is on the new card, and filing again from here would file twice.
    if (await onAdd(input, file)) {
      setTitle("");
      setKind("");
      setIssued("");
      setExpires("");
      setNotes("");
      setFile(null);
    }
  };

  return (
    <Card
      testID="document-new"
      title="File a document"
      footnote={error ? { text: error, warn: true } : dateError ? { text: dateError, warn: true } : undefined}
    >
      <View style={s.fields}>
        <TextInput
          value={title}
          onChangeText={setTitle}
          editable={!adding}
          placeholder="Passport"
          placeholderTextColor={colors.textDim}
          accessibilityLabel="New document title"
          style={[s.input, s.grow]}
          testID="document-new-title"
        />
        <View style={s.kind}>
          <Dropdown
            options={kindOptions(DOCUMENT_KINDS, kind)}
            value={kind}
            onChange={(next) => setKind(next)}
            placeholder="Kind…"
            title="Kind"
            testID="document-new-kind"
          />
        </View>
      </View>

      <View style={s.fields}>
        <DateField
          label="Issued"
          value={issued}
          onChange={(text) => {
            setIssued(text);
            setDateError(null);
          }}
          editable={!adding}
          accessibilityLabel="New document issued on"
          testID="document-new-issued"
        />
        <DateField
          label="Expires"
          value={expires}
          onChange={(text) => {
            setExpires(text);
            setDateError(null);
          }}
          editable={!adding}
          accessibilityLabel="New document expires on"
          testID="document-new-expires"
        />
      </View>

      <TextInput
        value={notes}
        onChangeText={setNotes}
        multiline
        numberOfLines={2}
        editable={!adding}
        placeholder="A line about it — optional."
        placeholderTextColor={colors.textDim}
        accessibilityLabel="New document notes"
        style={[s.input, s.notes]}
        testID="document-new-notes"
      />

      <Line testID="document-new-file" label="File" value={file ? file.name : "none — optional"} dim={!file} />

      <View style={s.actions}>
        <SmallButton
          label={file ? "Choose another" : "Choose file"}
          onPress={() => pickFile(setFile)}
          disabled={adding}
          testID="document-new-choose"
          accessibilityLabel="Choose a file for the new document"
        />
        {file && (
          <SmallButton
            label="Clear file"
            onPress={() => setFile(null)}
            disabled={adding}
            testID="document-new-clear-file"
            accessibilityLabel="Clear the chosen file"
          />
        )}
        <SmallButton
          label={adding ? "Filing…" : "File it"}
          onPress={add}
          disabled={!ready || busy !== null}
          testID="document-new-submit"
          accessibilityLabel="File the document"
        />
      </View>
    </Card>
  );
}

const s = {
  ...statStyles,
  ...recordStyles,
  ...StyleSheet.create({
    file: { flexDirection: "row", gap: spacing.md, alignItems: "flex-start" },
    fileSide: { flex: 1, minWidth: 0, gap: spacing.xs },
    preview: { width: 96, height: 96, borderRadius: radii.md, backgroundColor: colors.bg },
    previewBlank: {
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 1,
      borderColor: colors.border,
    },
    previewText: { ...type.caption, color: colors.textDim, fontWeight: "600" },
  }),
};
