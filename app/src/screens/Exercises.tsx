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
  Equipment,
  Exercise,
  ExerciseQuery,
  ExerciseType,
  PageMeta,
  errorMessage,
} from "../api";
import ConfirmDialog from "../components/ConfirmDialog";
import Dropdown from "../components/Dropdown";
import EquipmentImage from "../components/EquipmentImage";
import FilterBar from "../components/FilterBar";
import Pagination, { PAGE_SIZE } from "../components/Pagination";
import PillSelector from "../components/PillSelector";
import { EQUIPMENT_OPTIONS, EXERCISE_TYPES, PRIMARY_MUSCLES } from "../exerciseConstants";
import { colors, radii, spacing } from "../theme";
import { useRefreshOnActivate } from "../useRefreshOnActivate";

type Props = { active: boolean };

/** Fields with an inline error slot in the form; everything else falls back to the banner. */
const INLINE_FIELDS = new Set(["name"]);

/** The equipment picture on a list row. Matches the Equipment screen's own list. */
const ROW_THUMB = 44;

// ── Component ─────────────────────────────────────────────────────────────────

export default function Exercises({ active }: Props) {
  const [exercises, setExercises] = useState<Exercise[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  // Filters and page. All three filters are exact matches, and "" means the
  // filter is off — the same convention Dropdown uses for an empty selection.
  const [muscleFilter, setMuscleFilter] = useState("");
  const [equipmentFilter, setEquipmentFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [page, setPage] = useState(1);
  const [meta, setMeta] = useState<PageMeta | null>(null);

  // Modal
  const [modalVisible, setModalVisible] = useState(false);
  const [modalMode, setModalMode] = useState<"create" | "edit">("create");
  const [selected, setSelected] = useState<Exercise | null>(null);
  const [saving, setSaving] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  // Form fields
  const [name, setName] = useState("");
  const [primaryMuscle, setPrimaryMuscle] = useState<string>(PRIMARY_MUSCLES[0]);
  const [equipment, setEquipment] = useState<string>("");
  const [exerciseType, setExerciseType] = useState<ExerciseType>("weight_reps");
  const [notes, setNotes] = useState("");

  // Delete
  const [deleteDialogVisible, setDeleteDialogVisible] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // The equipment catalog, or null when it is empty or unreachable. Exercises
  // reference equipment by *name*, so the names are the picker's vocabulary —
  // see EQUIPMENT_OPTIONS for what stands in when there is no catalog yet.
  //
  // Whole records rather than names, because the picker also shows each item's
  // picture, and that needs the photo, the pinned thumbnail and the category
  // the drawing is otherwise derived from.
  const [equipmentCatalog, setEquipmentCatalog] = useState<Equipment[] | null>(null);

  // Search, filtering and paging are all served by the API. Keystrokes are
  // debounced, and a sequence guard drops responses that arrive after a newer
  // request has been issued.
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const loadSeq = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search.trim());
      // A new term means a new result set, in which the old page number means
      // nothing — page 3 of "bench" is not page 3 of "bench press".
      setPage(1);
    }, 250);
    return () => clearTimeout(t);
  }, [search]);

  /** Everything the list is currently asking the API for. */
  const query = useMemo<ExerciseQuery>(() => ({
    search: debouncedSearch || undefined,
    primary_muscle: muscleFilter || undefined,
    equipment: equipmentFilter || undefined,
    exercise_type: (typeFilter || undefined) as ExerciseType | undefined,
    page,
    per_page: PAGE_SIZE,
  }), [debouncedSearch, muscleFilter, equipmentFilter, typeFilter, page]);

  const listRef = useRef<ScrollView>(null);

  /**
   * `toTop` is for loads that replace the result set — a new page, term or
   * filter. Leaving the viewport where it was would drop the reader into the
   * middle of rows they have not seen; pressing Next from the footer would be
   * answered with the *end* of the following page. Reloads after a save keep
   * their place instead, so the row just edited stays where it was.
   */
  const load = useCallback(async (q: ExerciseQuery, toTop = false) => {
    const seq = ++loadSeq.current;
    try {
      const res = await api.listExercises(q);
      if (seq !== loadSeq.current) return;
      setExercises(res.data);
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
    setMuscleFilter("");
    setEquipmentFilter("");
    setTypeFilter("");
    setPage(1);
  }, []);

  // Deliberately not folded into `load`: a catalog that fails to fetch must not
  // blank the exercise list or raise the banner, because the picker degrades to
  // its built-in options on its own.
  const loadEquipmentCatalog = useCallback(async () => {
    try {
      const res = await api.listEquipment();
      setEquipmentCatalog(res.data);
    } catch {
      setEquipmentCatalog(null);
    }
  }, []);

  useEffect(() => { loadEquipmentCatalog(); }, [loadEquipmentCatalog]);

  // Kept mounted across navigation, so re-entry refetches under the current term
  // and picks up equipment added on the Equipment screen in between.
  const refresh = useCallback(() => {
    load(query);
    loadEquipmentCatalog();
  }, [load, query, loadEquipmentCatalog]);
  useRefreshOnActivate(active, refresh);

  function openCreate() {
    setModalMode("create");
    setSelected(null);
    setName("");
    setPrimaryMuscle(PRIMARY_MUSCLES[0]);
    setEquipment("");
    setExerciseType("weight_reps");
    setNotes("");
    setFormErr(null);
    setFieldErrors({});
    setModalVisible(true);
  }

  function openEdit(ex: Exercise) {
    setModalMode("edit");
    setSelected(ex);
    setName(ex.name);
    setPrimaryMuscle(ex.primary_muscle);
    setEquipment(ex.equipment ?? "");
    setExerciseType(ex.exercise_type);
    setNotes(ex.notes ?? "");
    setFormErr(null);
    setFieldErrors({});
    setModalVisible(true);
  }

  function closeModal() {
    if (saving || deleting) return;
    setModalVisible(false);
    setDeleteDialogVisible(false);
  }

  async function save() {
    // Only the name needs a client-side check — the other required fields are
    // pill selectors that always hold a valid value, and equipment is optional.
    if (!name.trim()) { setFormErr("Name is required"); return; }
    setSaving(true);
    setFormErr(null);
    setFieldErrors({});
    try {
      const input = {
        name: name.trim(),
        primary_muscle: primaryMuscle,
        equipment: equipment || undefined,
        exercise_type: exerciseType,
        notes: notes.trim() || undefined,
      };
      if (modalMode === "create") {
        await api.createExercise(input);
      } else {
        await api.updateExercise(selected!.id, input);
      }
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
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    setDeleting(true);
    try {
      await api.deleteExercise(selected!.id);
      setDeleteDialogVisible(false);
      setModalVisible(false);
      await load(query);
    } catch (e: any) {
      setFormErr(errorMessage(e));
      setDeleteDialogVisible(false);
    } finally {
      setDeleting(false);
    }
  }

  // ── Derived data ─────────────────────────────────────────────────────────────

  const grouped: Record<string, Exercise[]> = {};
  for (const ex of exercises) {
    const g = ex.primary_muscle;
    if (!grouped[g]) grouped[g] = [];
    grouped[g].push(ex);
  }
  const groupKeys = Object.keys(grouped).sort();

  const exerciseTypeLabel = (t: ExerciseType) =>
    EXERCISE_TYPES.find((x) => x.value === t)?.label ?? t;

  /** The catalog's vocabulary, or the built-in list while there is no catalog. */
  const catalogNames = useMemo(
    () => (equipmentCatalog?.length ? equipmentCatalog.map((e) => e.name) : [...EQUIPMENT_OPTIONS]),
    [equipmentCatalog],
  );

  /**
   * The record behind each name the pickers offer. Names are unique in the
   * catalog, so this is a plain index; a name it does not hold is one of the
   * built-in fallbacks or a value the catalog has since lost, and both draw
   * from the name alone below.
   */
  const equipmentByName = useMemo(
    () => new Map((equipmentCatalog ?? []).map((e) => [e.name, e])),
    [equipmentCatalog],
  );

  /**
   * The picture beside an equipment name in either picker: its uploaded photo,
   * or the illustration it is pinned to, or one derived from its name.
   *
   * A name with no catalog row behind it still gets a drawing — from the name
   * alone, with no category to fall back on. That is what the built-in options
   * are ("Barbell", "Kettlebell", each of which the keyword table knows), and
   * an unrecognised one lands on the gym bag rather than an empty slot.
   */
  const renderEquipmentIcon = useCallback(
    (name: string, size: number) => {
      const item = equipmentByName.get(name);
      return (
        <EquipmentImage
          uri={item?.image_url ?? null}
          name={name}
          equipmentType={item?.equipment_type ?? ""}
          thumbnail={item?.thumbnail ?? null}
          style={{ width: size, height: size, borderRadius: radii.sm }}
        />
      );
    },
    [equipmentByName],
  );

  const equipmentOptions = useMemo(() => {
    // Whatever this exercise already names stays selectable even if the catalog
    // no longer lists it — a deleted item would otherwise show in the trigger
    // with no matching row in the sheet, so reselecting it after browsing the
    // options would be impossible. The filter above the list needs no such
    // appendix: it can only ever hold a value the user picked from this list.
    return equipment && !catalogNames.includes(equipment)
      ? [...catalogNames, equipment]
      : catalogNames;
  }, [catalogNames, equipment]);

  const filtering = Boolean(muscleFilter || equipmentFilter || typeFilter);

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={s.root}>
      {/* Header */}
      <View style={s.header}>
        <Text style={s.headerTitle}>Exercises</Text>
        <Pressable onPress={openCreate} style={s.newBtn}>
          <Text style={s.newBtnTxt}>+ New</Text>
        </Pressable>
      </View>

      {/* Search */}
      <View style={s.searchWrap}>
        <TextInput
          style={s.searchInput}
          placeholder="Search exercises…"
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
            key: "muscle",
            label: "Muscle",
            placeholder: "All muscles",
            options: PRIMARY_MUSCLES,
            value: muscleFilter,
            onChange: filterSetter(setMuscleFilter),
          },
          {
            key: "equipment",
            label: "Equipment",
            placeholder: "All equipment",
            options: catalogNames,
            value: equipmentFilter,
            onChange: filterSetter(setEquipmentFilter),
            renderIcon: renderEquipmentIcon,
          },
          {
            key: "type",
            label: "Type",
            placeholder: "All types",
            options: EXERCISE_TYPES,
            value: typeFilter,
            onChange: filterSetter(setTypeFilter),
          },
        ]}
      />

      <ScrollView ref={listRef} contentContainerStyle={s.body}>
        {loading && <ActivityIndicator color={colors.accent} style={{ marginTop: spacing["2xl"] }} />}
        {err && <Text style={s.errTxt}>{err}</Text>}

        {!loading && exercises.length === 0 && (
          <View style={s.empty}>
            {debouncedSearch || filtering ? (
              <>
                <Text style={s.emptyTitle}>No matches</Text>
                <Text style={s.emptyDesc}>
                  {!debouncedSearch
                    ? "No exercises match these filters."
                    : filtering
                      ? `No exercise matching "${debouncedSearch}" fits these filters.`
                      : `No exercise names contain "${debouncedSearch}".`}
                </Text>
              </>
            ) : (
              <>
                <Text style={s.emptyTitle}>No exercises yet</Text>
                <Text style={s.emptyDesc}>Tap "+ New" to add your first exercise.</Text>
              </>
            )}
          </View>
        )}

        {groupKeys.map((muscle) => (
          <View key={muscle} style={s.group}>
            <Text style={s.groupLabel}>{muscle}</Text>
            {grouped[muscle].map((ex) => (
              <Pressable
                key={ex.id}
                onPress={() => openEdit(ex)}
                style={({ hovered }: any) => [s.row, hovered && s.rowHovered]}
              >
                {/* The equipment's picture, not the exercise's — there is no
                    such thing as a picture of a Bench Press. The slot is held
                    even for an exercise that names no equipment, because a row
                    that skipped it would set its name at a different indent
                    from every other row in the group. */}
                <View style={s.rowThumb}>
                  {ex.equipment ? renderEquipmentIcon(ex.equipment, ROW_THUMB) : null}
                </View>

                <View style={s.rowMain}>
                  <Text style={s.rowName}>{ex.name}</Text>
                  <View style={s.chips}>
                    {ex.equipment ? (
                      <View style={s.chip}>
                        <Text style={s.chipTxt}>{ex.equipment}</Text>
                      </View>
                    ) : null}
                    <View style={[s.chip, s.chipAccent]}>
                      <Text style={[s.chipTxt, s.chipAccentTxt]}>{exerciseTypeLabel(ex.exercise_type)}</Text>
                    </View>
                  </View>
                </View>
                <Text style={s.chevron}>›</Text>
              </Pressable>
            ))}
          </View>
        ))}

        {/* Groups can straddle a page boundary — the list is sorted by muscle,
            so a split group simply repeats its heading on the next page. */}
        {meta && <Pagination meta={meta} onChange={setPage} disabled={loading} noun="exercises" />}
      </ScrollView>

      {/* Create / Edit Modal */}
      <Modal
        visible={active && modalVisible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={closeModal}
      >
        <SafeAreaView style={s.modalRoot}>
          {/* Modal header */}
          <View style={s.modalHeader}>
            <Pressable onPress={closeModal} style={s.cancelBtn} disabled={saving || deleting}>
              <Text style={s.cancelTxt}>Cancel</Text>
            </Pressable>
            <Text style={s.modalTitle}>
              {modalMode === "create" ? "New Exercise" : "Edit Exercise"}
            </Text>
            <Pressable onPress={save} style={[s.saveBtn, saving && { opacity: 0.6 }]} disabled={saving || deleting}>
              {saving
                ? <ActivityIndicator color={colors.accent} />
                : <Text style={s.saveTxt}>Save</Text>
              }
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={s.modalBody}>
            {formErr && (
              <View style={s.formErr}>
                <Text style={s.formErrTxt}>{formErr}</Text>
              </View>
            )}

            {/* Name */}
            <View style={s.field}>
              <Text style={s.fieldLabel}>Name <Text style={s.required}>*</Text></Text>
              <TextInput
                style={[s.input, fieldErrors.name && s.inputInvalid]}
                value={name}
                onChangeText={(v) => {
                  setName(v);
                  // Clear the error as soon as the user edits the offending field.
                  if (fieldErrors.name) setFieldErrors(({ name: _drop, ...rest }) => rest);
                }}
                placeholder="e.g. Incline Bench Press"
                placeholderTextColor={colors.textDim}
                autoFocus={modalMode === "create"}
              />
              {fieldErrors.name?.[0] && (
                <Text style={s.fieldErrTxt}>{fieldErrors.name[0]}</Text>
              )}
            </View>

            {/* Primary Muscle */}
            <View style={s.field}>
              <Text style={s.fieldLabel}>Primary Muscle <Text style={s.required}>*</Text></Text>
              <PillSelector
                options={PRIMARY_MUSCLES}
                value={primaryMuscle}
                onChange={setPrimaryMuscle}
              />
            </View>

            {/* Equipment */}
            <View style={s.field}>
              <Text style={s.fieldLabel}>Equipment</Text>
              <Dropdown
                options={equipmentOptions}
                value={equipment}
                onChange={setEquipment}
                placeholder="Select equipment…"
                title="Equipment"
                testID="equipment-dropdown"
                renderIcon={renderEquipmentIcon}
                // Optional field, so the sheet carries its own way to empty it —
                // a pill row could be cleared by tapping the active pill again.
                // Deliberately not "None": EQUIPMENT_OPTIONS ships that as a
                // real value, and in the empty-catalog fallback the two would
                // render as a duplicate pair of rows meaning different things.
                clearLabel="No equipment"
              />
            </View>

            {/* Type */}
            <View style={s.field}>
              <Text style={s.fieldLabel}>Type <Text style={s.required}>*</Text></Text>
              <PillSelector
                options={EXERCISE_TYPES}
                value={exerciseType}
                onChange={setExerciseType}
              />
            </View>

            {/* Notes */}
            <View style={s.field}>
              <Text style={s.fieldLabel}>Notes</Text>
              <TextInput
                style={[s.input, s.inputMulti]}
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
                style={({ hovered }: any) => [s.deleteBtn, hovered && s.deleteBtnHovered]}
                disabled={saving || deleting}
              >
                <Text style={s.deleteTxt}>Delete Exercise</Text>
              </Pressable>
            )}
          </ScrollView>
        </SafeAreaView>
      </Modal>

      <ConfirmDialog
        visible={active && deleteDialogVisible}
        title="Delete Exercise"
        message={`Delete "${selected?.name}"? This won't affect existing workout sets.`}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteDialogVisible(false)}
        loading={deleting}
      />
    </SafeAreaView>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
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
  },
  rowHovered: { borderColor: colors.borderHi },
  // Sized here rather than by a gap on the row, which would also push the
  // chevron away from the right edge it is anchored to.
  rowThumb: { width: ROW_THUMB, height: ROW_THUMB, marginRight: spacing.md },
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
  chipAccent: { backgroundColor: colors.accentBg, borderColor: colors.accentBd },
  chipTxt: { fontSize: 11, color: colors.textMuted },
  chipAccentTxt: { color: colors.accentTxt },
  chevron: { fontSize: 20, color: colors.textDim, marginLeft: spacing.sm },

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
