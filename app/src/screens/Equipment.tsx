import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  api,
  ApiError,
  Equipment as EquipmentItem,
  EquipmentQuery,
  EquipmentStatus,
  PageMeta,
  errorMessage,
} from "../api";
import ConfirmDialog from "../components/ConfirmDialog";
import EquipmentImage from "../components/EquipmentImage";
import FilterBar from "../components/FilterBar";
import Pagination, { PAGE_SIZE } from "../components/Pagination";
import PillSelector from "../components/PillSelector";
import ThumbnailPicker from "../components/ThumbnailPicker";
import { EquipmentArt, isEquipmentArt } from "../equipmentArt";
import { EQUIPMENT_STATUSES, EQUIPMENT_TYPES, equipmentStatusLabel } from "../equipmentConstants";
import { colors, radii, spacing } from "../theme";
import { useRefreshOnActivate } from "../useRefreshOnActivate";

type Props = { active: boolean };

/** Fields with an inline error slot in the form; everything else falls back to the banner. */
const INLINE_FIELDS = new Set(["name"]);

/** What the form intends to do with the photo when the user saves. */
type ImageAction =
  | { kind: "keep" }
  | { kind: "remove" }
  | { kind: "replace"; file: File; preview: string };

// ── Component ─────────────────────────────────────────────────────────────────

export default function Equipment({ active }: Props) {
  const [items, setItems] = useState<EquipmentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  // Filters and page. Both filters are exact matches, and "" means the filter
  // is off — the same convention Dropdown uses for an empty selection.
  const [typeFilter, setTypeFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [page, setPage] = useState(1);
  const [meta, setMeta] = useState<PageMeta | null>(null);

  // Modal
  const [modalVisible, setModalVisible] = useState(false);
  const [modalMode, setModalMode] = useState<"create" | "edit">("create");
  const [selected, setSelected] = useState<EquipmentItem | null>(null);
  const [saving, setSaving] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  // Form fields
  const [name, setName] = useState("");
  const [equipmentType, setEquipmentType] = useState<string>(EQUIPMENT_TYPES[0]);
  const [status, setStatus] = useState<EquipmentStatus>("active");
  // Null is "let the name and category choose", which is what a new item gets
  // and what the Automatic tile stores.
  const [thumbnail, setThumbnail] = useState<EquipmentArt | null>(null);
  const [notes, setNotes] = useState("");
  const [imageAction, setImageAction] = useState<ImageAction>({ kind: "keep" });

  // Delete
  const [deleteDialogVisible, setDeleteDialogVisible] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Search, filtering and paging are all served by the API. Keystrokes are
  // debounced, and a sequence guard drops responses that arrive after a newer
  // request has been issued.
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const loadSeq = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search.trim());
      // A new term means a new result set, in which the old page number means
      // nothing — page 3 of "bar" is not page 3 of "barbell".
      setPage(1);
    }, 250);
    return () => clearTimeout(t);
  }, [search]);

  /** Everything the list is currently asking the API for. */
  const query = useMemo<EquipmentQuery>(() => ({
    search: debouncedSearch || undefined,
    equipment_type: typeFilter || undefined,
    status: (statusFilter || undefined) as EquipmentStatus | undefined,
    page,
    per_page: PAGE_SIZE,
  }), [debouncedSearch, typeFilter, statusFilter, page]);

  const listRef = useRef<ScrollView>(null);

  /**
   * `toTop` is for loads that replace the result set — a new page, term or
   * filter. Leaving the viewport where it was would drop the reader into the
   * middle of rows they have not seen; pressing Next from the footer would be
   * answered with the *end* of the following page. Reloads after a save keep
   * their place instead, so the row just edited stays where it was.
   */
  const load = useCallback(async (q: EquipmentQuery, toTop = false) => {
    const seq = ++loadSeq.current;
    try {
      const res = await api.listEquipment(q);
      if (seq !== loadSeq.current) return;
      setItems(res.data);
      setMeta(res.meta);
      // The API clamps a page past the end — deleting the last row of the last
      // page leaves this screen asking for one that no longer exists. Follow it
      // back, or the footer would read "Page 4" over the third page's rows and
      // the next load would ask for the missing page all over again.
      if (res.meta.page !== q.page) setPage(res.meta.page);
      setErr(null);
      // Deferred to the frame after the new rows are committed. Scrolling
      // before the swap is undone by the browser's scroll anchoring, which
      // restores the old offset when content above the viewport changes.
      if (toTop) {
        requestAnimationFrame(() => listRef.current?.scrollTo({ y: 0, animated: false }));
      }
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setErr(errorMessage(e));
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, []);

  useEffect(() => { load(query, true); }, [query, load]);

  /** Wraps a filter setter so changing what is matched also resets the page. */
  const filterSetter = useCallback(
    (set: (v: string) => void) => (v: string) => { set(v); setPage(1); },
    [],
  );

  const clearFilters = useCallback(() => {
    setTypeFilter("");
    setStatusFilter("");
    setPage(1);
  }, []);

  // Kept mounted across navigation, so re-entry refetches the same page under
  // the current term and filters.
  const refresh = useCallback(() => { load(query); }, [load, query]);
  useRefreshOnActivate(active, refresh);

  // Object URLs for the picked-file preview are leaked unless revoked. Only the
  // preview currently on screen is live, so revoking on replacement is enough.
  const previewRef = useRef<string | null>(null);
  const setPreview = useCallback((next: ImageAction) => {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    previewRef.current = next.kind === "replace" ? next.preview : null;
    setImageAction(next);
  }, []);
  useEffect(() => () => {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
  }, []);

  function openCreate() {
    setModalMode("create");
    setSelected(null);
    setName("");
    setEquipmentType(EQUIPMENT_TYPES[0]);
    setStatus("active");
    setThumbnail(null);
    setNotes("");
    setPreview({ kind: "keep" });
    setFormErr(null);
    setFieldErrors({});
    setModalVisible(true);
  }

  function openEdit(item: EquipmentItem) {
    setModalMode("edit");
    setSelected(item);
    setName(item.name);
    setEquipmentType(item.equipment_type);
    setStatus(item.status);
    // The column is a free string on the wire; anything this build cannot draw
    // reads as no choice at all, which is how it renders too.
    setThumbnail(isEquipmentArt(item.thumbnail) ? item.thumbnail : null);
    setNotes(item.notes ?? "");
    setPreview({ kind: "keep" });
    setFormErr(null);
    setFieldErrors({});
    setModalVisible(true);
  }

  function closeModal() {
    if (saving || deleting) return;
    setPreview({ kind: "keep" });
    setModalVisible(false);
    setDeleteDialogVisible(false);
  }

  // ── Photo ────────────────────────────────────────────────────────────────────

  // Same DOM-input approach as the CSV import on the Workouts screen: RN has
  // no file picker of its own.
  function pickImage() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/jpeg,image/png,image/webp";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      setPreview({ kind: "replace", file, preview: URL.createObjectURL(file) });
    };
    input.click();
  }

  /** What the photo slot should show right now — the pending pick wins over the saved one. */
  function shownImage(): string | null {
    if (imageAction.kind === "replace") return imageAction.preview;
    if (imageAction.kind === "remove") return null;
    return selected?.image_url ?? null;
  }

  async function save() {
    // Only the name needs a client-side check — type and status are pill
    // selectors that always hold a valid value.
    if (!name.trim()) { setFormErr("Name is required"); return; }
    setSaving(true);
    setFormErr(null);
    setFieldErrors({});
    try {
      const input = {
        name: name.trim(),
        equipment_type: equipmentType,
        status,
        // Explicitly null rather than omitted: this is the only way to clear a
        // pinned drawing, and the rules validate it as nullable for that reason.
        thumbnail,
        notes: notes.trim() || undefined,
      };

      // The record has to exist before its photo can be attached, so a create
      // with a photo is two calls.
      const saved = modalMode === "create"
        ? await api.createEquipment(input)
        : await api.updateEquipment(selected!.id, input);

      // Bind the sheet to the row that now exists, before the photo call that
      // might still fail. Without this, pressing Save again after a failed
      // upload would try to create a second row and hit the unique-name error
      // instead of retrying the photo.
      setModalMode("edit");
      setSelected(saved);

      if (imageAction.kind === "replace") {
        await api.uploadEquipmentImage(saved.id, imageAction.file);
      } else if (imageAction.kind === "remove") {
        await api.deleteEquipmentImage(saved.id);
      }

      setPreview({ kind: "keep" });
      setModalVisible(false);
      await load(query);
    } catch (e) {
      const fields = (e as ApiError).fieldErrors;
      if (fields) setFieldErrors(fields);
      // Field messages render inline beside their input, but only `name` has a
      // rendered home. Anything else must still reach the banner, or the form
      // would silently do nothing on save.
      const shownInline = fields && Object.keys(fields).some((k) => INLINE_FIELDS.has(k));
      if (!shownInline) setFormErr(errorMessage(e));
      // The list may already have changed even on failure — a create that
      // succeeded before its photo upload failed leaves a new row behind.
      await load(query);
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    setDeleting(true);
    try {
      await api.deleteEquipment(selected!.id);
      setDeleteDialogVisible(false);
      setModalVisible(false);
      await load(query);
    } catch (e) {
      setFormErr(errorMessage(e));
      setDeleteDialogVisible(false);
    } finally {
      setDeleting(false);
    }
  }

  // ── Derived data ─────────────────────────────────────────────────────────────

  const grouped: Record<string, EquipmentItem[]> = {};
  for (const item of items) {
    const g = item.equipment_type;
    if (!grouped[g]) grouped[g] = [];
    grouped[g].push(item);
  }
  const groupKeys = Object.keys(grouped).sort();

  const filtering = Boolean(typeFilter || statusFilter);

  const statusChipStyle = (s: EquipmentStatus) =>
    s === "broken" ? st.chipError : s === "wishlist" ? st.chipMuted : st.chipEmerald;
  const statusTextStyle = (s: EquipmentStatus) =>
    s === "broken" ? st.chipErrorTxt : s === "wishlist" ? st.chipTxt : st.chipEmeraldTxt;

  const preview = shownImage();

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={st.root}>
      {/* Header */}
      <View style={st.header}>
        <Text style={st.headerTitle}>Equipment</Text>
        <Pressable onPress={openCreate} style={st.newBtn}>
          <Text style={st.newBtnTxt}>+ New</Text>
        </Pressable>
      </View>

      {/* Search */}
      <View style={st.searchWrap}>
        <TextInput
          style={st.searchInput}
          placeholder="Search equipment…"
          placeholderTextColor={colors.textDim}
          value={search}
          onChangeText={setSearch}
          clearButtonMode="while-editing"
        />
      </View>

      {/* Filters */}
      <FilterBar
        onClear={clearFilters}
        filters={[
          {
            key: "type",
            label: "Type",
            placeholder: "All types",
            options: EQUIPMENT_TYPES,
            value: typeFilter,
            onChange: filterSetter(setTypeFilter),
          },
          {
            key: "status",
            label: "Status",
            placeholder: "All statuses",
            options: EQUIPMENT_STATUSES,
            value: statusFilter,
            onChange: filterSetter(setStatusFilter),
          },
        ]}
      />

      <ScrollView ref={listRef} contentContainerStyle={st.body}>
        {loading && <ActivityIndicator color={colors.accent} style={{ marginTop: spacing["2xl"] }} />}
        {err && <Text style={st.errTxt}>{err}</Text>}

        {!loading && items.length === 0 && (
          <View style={st.empty}>
            {debouncedSearch || filtering ? (
              <>
                <Text style={st.emptyTitle}>No matches</Text>
                <Text style={st.emptyDesc}>
                  {!debouncedSearch
                    ? "No equipment matches these filters."
                    : filtering
                      ? `No equipment matching "${debouncedSearch}" fits these filters.`
                      : `No equipment names contain "${debouncedSearch}".`}
                </Text>
              </>
            ) : (
              <>
                <Text style={st.emptyTitle}>No equipment yet</Text>
                <Text style={st.emptyDesc}>Tap "+ New" to add your first piece of kit.</Text>
              </>
            )}
          </View>
        )}

        {groupKeys.map((type) => (
          <View key={type} style={st.group}>
            <Text style={st.groupLabel}>{type}</Text>
            {grouped[type].map((item) => (
              <Pressable
                key={item.id}
                onPress={() => openEdit(item)}
                style={({ hovered }: any) => [st.row, hovered && st.rowHovered]}
              >
                <EquipmentImage
                  uri={item.image_url}
                  name={item.name}
                  equipmentType={item.equipment_type}
                  thumbnail={item.thumbnail}
                  style={st.thumb}
                />

                <View style={st.rowMain}>
                  <Text style={st.rowName}>{item.name}</Text>
                  <View style={st.chips}>
                    <View style={[st.chip, statusChipStyle(item.status)]}>
                      <Text style={[st.chipTxt, statusTextStyle(item.status)]}>
                        {equipmentStatusLabel(item.status)}
                      </Text>
                    </View>
                  </View>
                </View>
                <Text style={st.chevron}>›</Text>
              </Pressable>
            ))}
          </View>
        ))}

        {/* Groups can straddle a page boundary — the list is sorted by type, so
            a split group simply repeats its heading on the next page. */}
        {meta && <Pagination meta={meta} onChange={setPage} disabled={loading} noun="items" />}
      </ScrollView>

      {/* Create / Edit Modal */}
      <Modal
        visible={active && modalVisible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={closeModal}
      >
        <SafeAreaView style={st.modalRoot}>
          {/* Modal header */}
          <View style={st.modalHeader}>
            <Pressable onPress={closeModal} style={st.cancelBtn} disabled={saving || deleting}>
              <Text style={st.cancelTxt}>Cancel</Text>
            </Pressable>
            <Text style={st.modalTitle}>
              {modalMode === "create" ? "New Equipment" : "Edit Equipment"}
            </Text>
            <Pressable onPress={save} style={[st.saveBtn, saving && { opacity: 0.6 }]} disabled={saving || deleting}>
              {saving
                ? <ActivityIndicator color={colors.accent} />
                : <Text style={st.saveTxt}>Save</Text>
              }
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={st.modalBody}>
            {formErr && (
              <View style={st.formErr}>
                <Text style={st.formErrTxt}>{formErr}</Text>
              </View>
            )}

            {/* Photo */}
            <View style={st.field}>
              <Text style={st.fieldLabel}>Photo</Text>
              <View style={st.photoRow}>
                <EquipmentImage
                  uri={preview}
                  name={name}
                  equipmentType={equipmentType}
                  thumbnail={thumbnail}
                  style={st.photo}
                  testID="equipment-photo"
                />
                <View style={st.photoBtns}>
                  <Pressable
                    onPress={pickImage}
                    accessibilityRole="button"
                    style={({ hovered }: any) => [st.photoBtn, hovered && st.photoBtnHovered]}
                    disabled={saving || deleting}
                  >
                    <Text style={st.photoBtnTxt}>{preview ? "Replace photo…" : "Choose photo…"}</Text>
                  </Pressable>
                  {preview && (
                    <Pressable
                      onPress={() => setPreview({ kind: "remove" })}
                      accessibilityRole="button"
                      style={({ hovered }: any) => [st.photoBtn, hovered && st.photoBtnHovered]}
                      disabled={saving || deleting}
                    >
                      <Text style={[st.photoBtnTxt, st.photoBtnDanger]}>Remove photo</Text>
                    </Pressable>
                  )}
                  {/* Says which of the two things is on screen: the illustration
                      is not a photo, and the sheet should not let anyone save
                      thinking it uploaded one. */}
                  <Text style={st.photoHint}>
                    {preview
                      ? "JPEG, PNG or WebP, up to 5 MB."
                      : "No photo — showing the thumbnail below. JPEG, PNG or WebP, up to 5 MB."}
                  </Text>
                </View>
              </View>
            </View>

            {/* Name */}
            <View style={st.field}>
              <Text style={st.fieldLabel}>Name <Text style={st.required}>*</Text></Text>
              <TextInput
                style={[st.input, fieldErrors.name && st.inputInvalid]}
                value={name}
                onChangeText={(v) => {
                  setName(v);
                  // Clear the error as soon as the user edits the offending field.
                  if (fieldErrors.name) setFieldErrors(({ name: _drop, ...rest }) => rest);
                }}
                placeholder="e.g. Olympic Barbell"
                placeholderTextColor={colors.textDim}
                autoFocus={modalMode === "create"}
              />
              {fieldErrors.name?.[0] && (
                <Text style={st.fieldErrTxt}>{fieldErrors.name[0]}</Text>
              )}
            </View>

            {/* Type */}
            <View style={st.field}>
              <Text style={st.fieldLabel}>Type <Text style={st.required}>*</Text></Text>
              <PillSelector
                options={EQUIPMENT_TYPES}
                value={equipmentType}
                onChange={setEquipmentType}
              />
            </View>

            {/* Thumbnail */}
            <View style={st.field}>
              <Text style={st.fieldLabel}>Thumbnail</Text>
              <ThumbnailPicker
                value={thumbnail}
                onChange={setThumbnail}
                name={name}
                equipmentType={equipmentType}
                disabled={saving || deleting}
              />
              {/* Worth saying while a photo is on screen: the picker still
                  responds, and nothing it does is visible until the photo goes. */}
              <Text style={st.fieldHint}>
                {preview
                  ? "Shown if the photo is removed. Automatic follows the name and type."
                  : "Automatic follows the name and type."}
              </Text>
            </View>

            {/* Status */}
            <View style={st.field}>
              <Text style={st.fieldLabel}>Status <Text style={st.required}>*</Text></Text>
              <PillSelector
                options={EQUIPMENT_STATUSES}
                value={status}
                onChange={setStatus}
              />
            </View>

            {/* Notes */}
            <View style={st.field}>
              <Text style={st.fieldLabel}>Notes</Text>
              <TextInput
                style={[st.input, st.inputMulti]}
                value={notes}
                onChangeText={setNotes}
                placeholder="Optional notes…"
                placeholderTextColor={colors.textDim}
                multiline
                numberOfLines={3}
              />
            </View>

            {/* Delete (edit mode only) */}
            {modalMode === "edit" && (
              <Pressable
                onPress={() => setDeleteDialogVisible(true)}
                style={({ hovered }: any) => [st.deleteBtn, hovered && st.deleteBtnHovered]}
                disabled={saving || deleting}
              >
                <Text style={st.deleteTxt}>Delete Equipment</Text>
              </Pressable>
            )}
          </ScrollView>
        </SafeAreaView>
      </Modal>

      <ConfirmDialog
        visible={active && deleteDialogVisible}
        title="Delete Equipment"
        message={`Delete "${selected?.name}"? Exercises that name it keep the label.`}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteDialogVisible(false)}
        loading={deleting}
      />
    </SafeAreaView>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },

  // Header
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  headerTitle: { fontSize: 17, fontWeight: "600", color: colors.text },

  newBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    backgroundColor: colors.accentBg,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.accentBd,
  },
  newBtnTxt: { fontSize: 14, fontWeight: "600", color: colors.accentTxt },

  // Search
  searchWrap: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderColor: colors.border,
  },
  searchInput: {
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: 15,
    color: colors.text,
  },

  // Body
  body: { padding: spacing.lg, paddingBottom: spacing["2xl"] * 2 },
  errTxt: { color: colors.error, marginBottom: spacing.md },
  empty: { alignItems: "center", marginTop: spacing["2xl"] * 2 },
  emptyTitle: { fontSize: 17, fontWeight: "600", color: colors.text, marginBottom: spacing.xs },
  emptyDesc: { fontSize: 14, color: colors.textMuted },

  // Groups
  group: { marginBottom: spacing.xl },
  groupLabel: {
    fontSize: 12,
    fontWeight: "700",
    color: colors.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.8,
    marginBottom: spacing.xs,
  },

  // Row
  row: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    marginBottom: spacing.xs,
    gap: spacing.md,
  },
  rowHovered: { borderColor: colors.borderHi },
  thumb: { width: 44, height: 44, borderRadius: radii.sm, backgroundColor: colors.bg },
  rowMain: { flex: 1 },
  rowName: { fontSize: 15, fontWeight: "500", color: colors.text, marginBottom: spacing.xs },
  chips: { flexDirection: "row", gap: spacing.xs },
  chip: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radii.sm,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipMuted: {},
  chipEmerald: { backgroundColor: colors.emeraldBg, borderColor: colors.emerald },
  chipError: { backgroundColor: colors.errorBg, borderColor: colors.errorBd },
  chipTxt: { fontSize: 11, color: colors.textMuted },
  chipEmeraldTxt: { color: colors.emeraldTxt },
  chipErrorTxt: { color: colors.error },
  chevron: { fontSize: 20, color: colors.textDim },

  // Modal
  modalRoot: { flex: 1, backgroundColor: colors.bg },
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  modalTitle: { fontSize: 17, fontWeight: "600", color: colors.text },
  cancelBtn: { padding: spacing.xs },
  cancelTxt: { fontSize: 15, color: colors.textMuted },
  saveBtn: { padding: spacing.xs, minWidth: 44, alignItems: "center" },
  saveTxt: { fontSize: 15, fontWeight: "600", color: colors.accent },

  // Form
  modalBody: { padding: spacing.lg, paddingBottom: spacing["2xl"] * 2 },
  formErr: {
    backgroundColor: colors.errorBg,
    borderWidth: 1,
    borderColor: colors.errorBd,
    borderRadius: radii.md,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  formErrTxt: { color: colors.error, fontSize: 14 },
  field: { marginBottom: spacing.lg },
  fieldLabel: { fontSize: 13, fontWeight: "600", color: colors.textMuted, marginBottom: spacing.xs, textTransform: "uppercase", letterSpacing: 0.5 },
  required: { color: colors.error },
  input: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: 15,
    color: colors.text,
  },
  inputMulti: { minHeight: 80, textAlignVertical: "top" },
  inputInvalid: { borderColor: colors.errorBd, backgroundColor: colors.errorBg },
  fieldErrTxt: { color: colors.error, fontSize: 13, marginTop: spacing.xs },
  fieldHint: { fontSize: 12, color: colors.textDim, marginTop: spacing.xs },

  // Photo picker
  photoRow: { flexDirection: "row", gap: spacing.md, alignItems: "flex-start" },
  photo: {
    width: 96,
    height: 96,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  // Shrinkable so the buttons wrap instead of pushing the sheet sideways.
  photoBtns: { flex: 1, minWidth: 0, gap: spacing.xs },
  photoBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: "center",
  },
  photoBtnHovered: { borderColor: colors.borderHi, backgroundColor: colors.bg },
  photoBtnTxt: { fontSize: 14, fontWeight: "600", color: colors.accentTxt },
  photoBtnDanger: { color: colors.error },
  photoHint: { fontSize: 12, color: colors.textDim },

  // Delete
  deleteBtn: {
    marginTop: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.errorBd,
    backgroundColor: colors.errorBg,
    alignItems: "center",
  },
  deleteBtnHovered: { backgroundColor: colors.errorHov },
  deleteTxt: { fontSize: 15, fontWeight: "600", color: colors.error },
});
