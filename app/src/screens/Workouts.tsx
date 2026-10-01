import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { api, CreateWorkoutInput, Exercise, errorMessage, Workout, WorkoutSet, WorkoutsResponse } from "../api";
import ConfirmDialog from "../components/ConfirmDialog";
import ErrorBanner from "../components/ErrorBanner";
import TabBar from "../components/TabBar";
import WorkoutForm, { emptyWorkoutForm, WorkoutFormValues } from "../components/WorkoutForm";
import {
  clearUnusedMetrics,
  displayMetric,
  exerciseInputsFrom,
  metricLabel,
  metricsForTitle,
  metricsPresentIn,
  SET_TYPE_LABEL,
  setPayload,
} from "../setMetrics";
import { colors, radii, spacing } from "../theme";
import { useRefreshOnActivate } from "../useRefreshOnActivate";
import { useUnits } from "../UnitsProvider";
import { UnitPrefs } from "../units";

type Props = {
  active: boolean;
  /**
   * Bumped by App.tsx when another screen asks to see the full list — the
   * "View all Workouts" link on Fitness → Home. A counter rather than a
   * boolean because this screen stays mounted: following the link a second
   * time has to re-select the tab, and only a changed value re-runs the effect.
   */
  openAllSignal?: number;
};

/** Which of the two forms a picker selection applies to. */
type FormKind = "create" | "edit";

/** Sub-pages of this screen. */
type WorkoutTab = "log" | "import" | "all";

const WORKOUT_TABS: readonly { value: WorkoutTab; label: string }[] = [
  { value: "all",    label: "View all Workouts" },
  { value: "log",    label: "Log a Workout" },
  { value: "import", label: "Import Hevy CSV" },
];

/** Browsing is the common case, so the screen opens on the full list. */
const DEFAULT_TAB: WorkoutTab = "all";

/** Rows per page on the all-workouts tab. */
const PAGE_SIZE = 20;

/** Backend clamps `limit` to 200. */
const LIST_LIMIT = 200;

// ── Component ─────────────────────────────────────────────────────────────────

export default function Workouts({ active, openAllSignal = 0 }: Props) {
  const [workouts, setWorkouts] = useState<WorkoutsResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<WorkoutTab>(DEFAULT_TAB);
  /** Zero-based page of the all-workouts list. Clamped at render (see pageIndex). */
  const [page, setPage] = useState(0);

  // Create form
  const [form, setForm] = useState<WorkoutFormValues>(emptyWorkoutForm);
  const [saving, setSaving] = useState(false);

  // CSV import state
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState<string | null>(null);

  // ── Detail / edit / delete state ─────────────────────────────────────────────
  const [selectedWorkout, setSelectedWorkout] = useState<Workout | null>(null);
  const [detailSets,      setDetailSets]      = useState<WorkoutSet[]>([]);
  const [detailLoading,   setDetailLoading]   = useState(false);
  const [modalMode,       setModalMode]       = useState<"view" | "edit">("view");
  const [modalVisible,    setModalVisible]    = useState(false);

  // Edit form
  const [editForm,   setEditForm]   = useState<WorkoutFormValues>(emptyWorkoutForm);
  const [editSaving, setEditSaving] = useState(false);

  // Delete state
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [deleteDialogVisible, setDeleteDialogVisible] = useState(false);
  const [pendingDeleteWorkout, setPendingDeleteWorkout] = useState<Workout | null>(null);

  // Error shown inside the modal (separate from the main-page error banner)
  const [modalErr, setModalErr] = useState<string | null>(null);

  // Exercise picker
  const [availableExercises, setAvailableExercises] = useState<Exercise[]>([]);
  const [pickerVisible, setPickerVisible] = useState(false);
  const [pickerTarget,  setPickerTarget]  = useState<{ form: FormKind; ei: number } | null>(null);
  const [pickerSearch,  setPickerSearch]  = useState("");

  // Both forms are filled in, and both payloads are built, in these units.
  const { units } = useUnits();

  const patchForm = useCallback(
    (patch: Partial<WorkoutFormValues>) => setForm((prev) => ({ ...prev, ...patch })),
    [],
  );

  const patchEditForm = useCallback(
    (patch: Partial<WorkoutFormValues>) => setEditForm((prev) => ({ ...prev, ...patch })),
    [],
  );

  const reload = useCallback(async () => {
    try {
      const w = await api.listWorkouts({ limit: LIST_LIMIT });
      setWorkouts(w);
      setErr(null);
    } catch (e) {
      setErr(errorMessage(e));
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const loadExercises = useCallback(() => {
    api.listExercises().then((r) => setAvailableExercises(r.data)).catch(() => {});
  }, []);

  useEffect(() => { loadExercises(); }, [loadExercises]);

  // Kept mounted across navigation, so re-entry refetches both the workout list
  // and the picker's exercise list (which the Exercises screen may have changed).
  const refresh = useCallback(() => { reload(); loadExercises(); }, [reload, loadExercises]);
  useRefreshOnActivate(active, refresh);

  // Arriving from the Fitness → Home link lands on the first page of the full
  // list. That is already the default tab, but this screen stays mounted, so
  // the user may have left it on Log or Import — the signal pulls it back, and
  // resets the page. Skipped on mount (the signal starts at 0).
  useEffect(() => {
    if (openAllSignal > 0) { setTab("all"); setPage(0); }
  }, [openAllSignal]);

  const openPicker = (form: FormKind, ei: number) => {
    setPickerTarget({ form, ei });
    setPickerSearch("");
    setPickerVisible(true);
  };

  /**
   * Metric columns for an exercise, resolved by name against the exercise
   * database. Falls back to weight+reps for titles with no matching record
   * (CSV imports predate the exercises table).
   */
  const metricsFor = useCallback(
    (title: string) => metricsForTitle(availableExercises, title),
    [availableExercises],
  );

  /**
   * Apply a picked exercise to its row, blanking metrics the new type doesn't
   * use. Without this, values typed for the previous exercise stay in state
   * after their inputs stop rendering and get saved invisibly.
   */
  const selectExercise = (name: string) => {
    if (!pickerTarget) return;
    const metrics = metricsFor(name);
    const { form: kind, ei } = pickerTarget;
    const applyTo = (prev: WorkoutFormValues): WorkoutFormValues => ({
      ...prev,
      exercises: prev.exercises.map((ex, i) =>
        i === ei
          ? { ...ex, exercise_title: name, sets: ex.sets.map((s) => clearUnusedMetrics(s, metrics)) }
          : ex
      ),
    });
    if (kind === "create") setForm(applyTo);
    else setEditForm(applyTo);
  };

  // ── Submit (create) ───────────────────────────────────────────────────────────

  const submitWorkout = async () => {
    if (!form.title.trim() || !form.date || !form.startTime) return;
    if (form.endTime && form.endTime < form.startTime) {
      setErr("End time can't be before start time. For sessions past midnight leave end time blank.");
      return;
    }
    setSaving(true);
    try {
      await api.createWorkout(workoutPayload(form, units));
      setForm(emptyWorkoutForm());
      await reload();
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  // ── Open workout detail modal ─────────────────────────────────────────────────

  const openWorkout = async (w: Workout) => {
    setSelectedWorkout(w);
    setDetailSets([]);
    setModalMode("view");
    setModalErr(null);
    setModalVisible(true);
    setDetailLoading(true);
    try {
      const full = await api.getWorkout(w.id);
      setDetailSets(full.sets ?? []);
    } catch (e) {
      setModalErr(errorMessage(e));
    } finally {
      setDetailLoading(false);
    }
  };

  // ── Enter edit mode — seeds edit form from current detail data ────────────────

  const enterEditMode = () => {
    if (!selectedWorkout) return;
    const pad = (n: number) => String(n).padStart(2, "0");
    const hhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const start = new Date(selectedWorkout.started_at);

    setEditForm({
      title:     selectedWorkout.title,
      date:      `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`,
      startTime: hhmm(start),
      endTime:   selectedWorkout.ended_at ? hhmm(new Date(selectedWorkout.ended_at)) : "",
      notes:     selectedWorkout.notes ?? "",
      exercises: exerciseInputsFrom(detailSets, units),
    });
    setModalMode("edit");
  };

  // ── Submit edit ───────────────────────────────────────────────────────────────

  const submitEdit = async () => {
    if (!selectedWorkout) return;
    if (!editForm.title.trim() || !editForm.date || !editForm.startTime) return;
    if (editForm.endTime && editForm.endTime < editForm.startTime) {
      setModalErr("End time can't be before start time.");
      return;
    }
    setEditSaving(true);
    try {
      const updated = await api.updateWorkout(selectedWorkout.id, workoutPayload(editForm, units));
      setSelectedWorkout(updated);
      setDetailSets(updated.sets ?? []);
      setModalErr(null);
      setModalMode("view");
      await reload();
    } catch (e) {
      setModalErr(errorMessage(e));
    } finally {
      setEditSaving(false);
    }
  };

  // ── Delete ────────────────────────────────────────────────────────────────────

  const confirmDelete = (w: Workout) => {
    setPendingDeleteWorkout(w);
    setDeleteDialogVisible(true);
  };

  const handleCancelDelete = () => {
    setDeleteDialogVisible(false);
    setPendingDeleteWorkout(null);
  };

  const doDelete = async () => {
    if (!pendingDeleteWorkout) return;
    const w = pendingDeleteWorkout;
    setDeletingId(w.id);
    try {
      await api.deleteWorkout(w.id);
      if (selectedWorkout?.id === w.id) {
        setModalVisible(false);
        setSelectedWorkout(null);
      }
      await reload();
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setDeletingId(null);
      setDeleteDialogVisible(false);
      setPendingDeleteWorkout(null);
    }
  };

  // ── CSV import ────────────────────────────────────────────────────────────────

  const onPickCsv = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".csv,text/csv";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      setImporting(true);
      setImportMsg(null);
      try {
        const r = await api.importWorkoutsCsv(file);
        setImportMsg(
          `Imported ${r.imported_sessions} sessions (${r.imported_sets} sets), skipped ${r.skipped_sessions}.`
        );
        await reload();
      } catch (e) {
        setImportMsg(`Import failed: ${errorMessage(e)}`);
      } finally {
        setImporting(false);
      }
    };
    input.click();
  };

  // ── Render ────────────────────────────────────────────────────────────────────

  // What the pager walks: the rows this fetch actually returned, which the
  // backend clamps to LIST_LIMIT. `total` is the whole table — the two differ
  // once the database outgrows the cap, and the label must not conflate them.
  const listed    = workouts?.data.length ?? 0;
  const total     = workouts?.meta?.total ?? listed;
  const unlisted  = Math.max(0, total - listed);
  const pageCount = Math.max(1, Math.ceil(listed / PAGE_SIZE));
  // Deleting the last rows can leave `page` past the end, so clamp here rather
  // than resetting on every reload — that would bounce the user back to page 1.
  const pageIndex = Math.min(page, pageCount - 1);
  const pageStart = pageIndex * PAGE_SIZE;
  const pageRows  = workouts?.data.slice(pageStart, pageStart + PAGE_SIZE) ?? [];

  return (
    <ScrollView contentContainerStyle={styles.scroll}>
      <Text style={styles.h1}>Workouts</Text>
      <Text style={styles.muted}>Browse everything you've trained, log a session, or import a Hevy CSV. Your latest five are on Fitness → Home.</Text>

      {err && <ErrorBanner text={err} />}

      <TabBar options={WORKOUT_TABS} value={tab} onChange={setTab} />

      {/* Sub-pages stay mounted and are hidden rather than unmounted, so switching
          tabs doesn't wipe a half-filled form or the last import result. Same
          contract the screens themselves follow in App.tsx. */}

      {/* Full workout list — the default tab, so it leads here too. */}
      <View style={[styles.card, tab !== "all" && styles.hidden]}>
        <Text style={styles.cardTitle}>All workouts</Text>
        {!workouts && <ActivityIndicator color={colors.accent} />}
        {workouts && workouts.data.length === 0 && (
          <Text style={styles.muted}>No workouts yet. Log one or import a CSV.</Text>
        )}
        {workouts && listed > 0 && (
          <Text style={styles.muted}>
            Showing {pageStart + 1}–{pageStart + pageRows.length} of {listed} workout
            {listed !== 1 ? "s" : ""}, newest first.
          </Text>
        )}
        {unlisted > 0 && (
          <Text style={styles.muted}>
            Only the {listed} most recent of your {total} workouts are loaded —{" "}
            {unlisted} older {unlisted !== 1 ? "sessions aren't" : "session isn't"} listed here.
          </Text>
        )}
        {pageRows.map((w) => (
          <WorkoutRow
            key={w.id}
            w={w}
            onView={() => openWorkout(w)}
            onDelete={() => confirmDelete(w)}
            deleting={deletingId === w.id}
          />
        ))}
        {pageCount > 1 && (
          <Pager
            page={pageIndex}
            pageCount={pageCount}
            onChange={setPage}
          />
        )}
      </View>

      {/* Add workout form */}
      <View style={[styles.card, tab !== "log" && styles.hidden]}>
        <Text style={styles.cardTitle}>Log a workout</Text>
        <WorkoutForm
          value={form}
          onChange={patchForm}
          metricsFor={metricsFor}
          onPickExercise={(ei) => openPicker("create", ei)}
          onSubmit={submitWorkout}
          submitLabel="Save workout"
          saving={saving}
        />
      </View>

      {/* CSV import */}
      <View style={[styles.card, tab !== "import" && styles.hidden]}>
        <Text style={styles.cardTitle}>Import Hevy CSV</Text>
        <Text style={styles.muted}>
          Export from Hevy → History → Export. Expected columns:{" "}
          <Text style={styles.mono}>title, start_time, end_time, exercise_title, set_index, set_type, weight_kg, reps, rpe, …</Text>
        </Text>
        <Pressable onPress={onPickCsv} disabled={importing}
          style={({ hovered }: any) => [styles.secondary, hovered && { borderColor: colors.accent }]}>
          {importing ? <ActivityIndicator color={colors.accent} /> : <Text style={styles.secondaryText}>Choose CSV file…</Text>}
        </Pressable>
        {importMsg && <Text style={[styles.muted, { marginTop: spacing.sm }]}>{importMsg}</Text>}
      </View>

      {/* ── Workout detail / edit modal ──────────────────────────────────────── */}
      <Modal
        animationType="slide"
        transparent={false}
        visible={active && modalVisible}
        onRequestClose={() => { setModalVisible(false); setModalMode("view"); setModalErr(null); }}
        presentationStyle="pageSheet"
      >
        <SafeAreaView style={styles.modalContainer}>
          <ScrollView contentContainerStyle={styles.modalScroll}>

            {/* Header */}
            <View style={styles.modalHeader}>
              <Pressable onPress={() => { setModalVisible(false); setModalMode("view"); setModalErr(null); }}>
                <Text style={styles.modalClose}>← Close</Text>
              </Pressable>
              <Text style={styles.modalTitle} numberOfLines={1}>{selectedWorkout?.title}</Text>
              {modalMode === "view" ? (
                <Pressable onPress={enterEditMode} disabled={detailLoading}>
                  <Text style={[styles.modalEdit, detailLoading && { opacity: 0.3 }]}>Edit</Text>
                </Pressable>
              ) : (
                <Pressable onPress={() => setModalMode("view")} disabled={editSaving}>
                  <Text style={[styles.modalEdit, { color: colors.textMuted }]}>Cancel</Text>
                </Pressable>
              )}
            </View>

            {modalErr && <ErrorBanner text={modalErr} />}

            {detailLoading && (
              <ActivityIndicator color={colors.accent} style={{ marginTop: spacing.lg }} />
            )}

            {/* View mode */}
            {!detailLoading && modalMode === "view" && selectedWorkout && (
              <WorkoutDetailView
                workout={selectedWorkout}
                sets={detailSets}
                onDelete={() => confirmDelete(selectedWorkout)}
              />
            )}

            {/* Edit mode */}
            {modalMode === "edit" && (
              <View style={{ gap: spacing.md }}>
                <WorkoutForm
                  value={editForm}
                  onChange={patchEditForm}
                  metricsFor={metricsFor}
                  onPickExercise={(ei) => openPicker("edit", ei)}
                  onSubmit={submitEdit}
                  submitLabel="Save changes"
                  saving={editSaving}
                />
              </View>
            )}

          </ScrollView>
        </SafeAreaView>
      </Modal>

      {/* Exercise picker modal */}
      <Modal
        visible={active && pickerVisible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setPickerVisible(false)}
      >
        <SafeAreaView style={styles.modalContainer}>
          <View style={styles.modalHeader}>
            <Pressable onPress={() => setPickerVisible(false)}>
              <Text style={styles.modalClose}>Cancel</Text>
            </Pressable>
            <Text style={[styles.modalTitle, { textAlign: "center" }]}>Select Exercise</Text>
            <View style={{ width: 60 }} />
          </View>
          <View style={styles.pickerSearchWrap}>
            <TextInput
              style={styles.input}
              value={pickerSearch}
              onChangeText={setPickerSearch}
              placeholder="Search…"
              placeholderTextColor={colors.textDim}
              autoFocus
            />
          </View>
          <FlatList
            data={availableExercises.filter((e) =>
              !pickerSearch.trim() || e.name.toLowerCase().includes(pickerSearch.toLowerCase())
            )}
            keyExtractor={(e) => String(e.id)}
            renderItem={({ item }) => (
              <Pressable
                style={({ hovered }: any) => [styles.pickerRow, hovered && styles.pickerRowHovered]}
                onPress={() => {
                  selectExercise(item.name);
                  setPickerVisible(false);
                }}
              >
                <Text style={styles.pickerItemName}>{item.name}</Text>
                <Text style={styles.pickerItemMeta}>
                  {item.primary_muscle}{item.equipment ? ` · ${item.equipment}` : ""}
                </Text>
              </Pressable>
            )}
            ListEmptyComponent={
              <Text style={[styles.muted, { padding: spacing.lg, textAlign: "center" }]}>
                {availableExercises.length === 0
                  ? "No exercises yet. Add some under Fitness → Exercises."
                  : "No matching exercises."}
              </Text>
            }
          />
        </SafeAreaView>
      </Modal>

      <ConfirmDialog
        visible={active && deleteDialogVisible}
        title="Delete workout"
        message={`Delete "${pendingDeleteWorkout?.title}"? This cannot be undone.`}
        confirmLabel="Delete"
        destructive
        loading={deletingId !== null}
        onConfirm={doDelete}
        onCancel={handleCancelDelete}
      />
    </ScrollView>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Form values → API payload. Exercises with no title picked are dropped, and a
 * blank end time is omitted rather than sent as an empty string.
 *
 * `units` is what the form's numbers were entered in; `setPayload` converts
 * them back to the kilograms and kilometers the API stores.
 */
function workoutPayload(f: WorkoutFormValues, units: UnitPrefs): CreateWorkoutInput {
  return {
    title:      f.title.trim(),
    started_at: `${f.date}T${f.startTime}:00`,
    ended_at:   f.endTime ? `${f.date}T${f.endTime}:00` : undefined,
    notes:      f.notes.trim() || undefined,
    exercises:  f.exercises
      .filter((e) => e.exercise_title.trim())
      .map((e) => ({
        exercise_title: e.exercise_title.trim(),
        exercise_notes: e.exercise_notes.trim() || undefined,
        sets: e.sets.map((s) => setPayload(s, units)),
      })),
  };
}

// ── Sub-components ────────────────────────────────────────────────────────────

/**
 * Prev/next pager for the all-workouts list. Paging is client-side over the
 * single list fetch — see LIST_LIMIT.
 */
function Pager({ page, pageCount, onChange }: {
  /** Zero-based, already clamped by the caller. */
  page: number;
  pageCount: number;
  onChange: (p: number) => void;
}) {
  const first = page === 0;
  const last  = page === pageCount - 1;

  return (
    <View style={styles.pager}>
      <Pressable
        onPress={() => onChange(page - 1)}
        disabled={first}
        accessibilityRole="button"
        accessibilityState={{ disabled: first }}
        style={({ hovered }: any) => [
          styles.pagerBtn,
          first && styles.pagerBtnDisabled,
          !first && hovered && { borderColor: colors.accent },
        ]}
      >
        <Text style={[styles.pagerBtnText, first && styles.pagerBtnTextDisabled]}>← Previous</Text>
      </Pressable>

      <Text style={styles.pagerStatus}>Page {page + 1} of {pageCount}</Text>

      <Pressable
        onPress={() => onChange(page + 1)}
        disabled={last}
        accessibilityRole="button"
        accessibilityState={{ disabled: last }}
        style={({ hovered }: any) => [
          styles.pagerBtn,
          last && styles.pagerBtnDisabled,
          !last && hovered && { borderColor: colors.accent },
        ]}
      >
        <Text style={[styles.pagerBtnText, last && styles.pagerBtnTextDisabled]}>Next →</Text>
      </Pressable>
    </View>
  );
}

function WorkoutRow({ w, onView, onDelete, deleting }: {
  w: Workout;
  onView: () => void;
  onDelete: () => void;
  deleting: boolean;
}) {
  const date     = new Date(w.started_at).toLocaleDateString();
  const duration = w.duration_minutes != null ? `${w.duration_minutes} min` : null;
  const exCount  = w.exercise_count ?? 0;
  const setCount = w.set_count ?? 0;

  return (
    <View style={styles.wkRow}>
      <View style={{ flex: 1 }}>
        <Text style={styles.wkTitle}>{w.title}</Text>
        <Text style={styles.muted}>
          {date}{duration ? ` · ${duration}` : ""}
        </Text>
        <Text style={styles.muted}>
          {exCount} exercise{exCount !== 1 ? "s" : ""} · {setCount} set{setCount !== 1 ? "s" : ""}
        </Text>
        {w.notes ? <Text style={[styles.muted, { marginTop: 2 }]} numberOfLines={2}>{w.notes}</Text> : null}
      </View>
      <View style={styles.wkActions}>
        <Pressable onPress={onView} style={styles.wkActionBtn}>
          <Text style={styles.wkActionText}>View</Text>
        </Pressable>
        {deleting
          ? <ActivityIndicator size="small" color={colors.danger} style={{ width: 40 }} />
          : (
            <Pressable onPress={onDelete} style={styles.wkActionBtn}>
              <Text style={[styles.wkActionText, { color: colors.danger }]}>Delete</Text>
            </Pressable>
          )
        }
      </View>
    </View>
  );
}

function WorkoutDetailView({ workout, sets, onDelete }: {
  workout: Workout;
  sets: WorkoutSet[];
  onDelete: () => void;
}) {
  const { units } = useUnits();
  const date     = new Date(workout.started_at).toLocaleDateString();
  const duration = workout.duration_minutes != null ? `${workout.duration_minutes} min` : null;

  // Group sets by exercise_title, preserving insertion order via set_index
  const exerciseMap = new Map<string, WorkoutSet[]>();
  [...sets]
    .sort((a, b) => a.set_index - b.set_index)
    .forEach((s) => {
      if (!exerciseMap.has(s.exercise_title)) exerciseMap.set(s.exercise_title, []);
      exerciseMap.get(s.exercise_title)!.push(s);
    });

  return (
    <View style={{ gap: spacing.md }}>
      <Text style={styles.muted}>
        {date}{duration ? ` · ${duration}` : ""}
      </Text>
      {workout.notes ? <Text style={styles.muted}>{workout.notes}</Text> : null}

      {sets.length === 0 && (
        <Text style={styles.muted}>No exercise data recorded.</Text>
      )}

      {Array.from(exerciseMap.entries()).map(([exTitle, exSets]) => {
        // Computed once per exercise rather than per row.
        const metrics = metricsPresentIn(exSets);
        return (
        <View key={exTitle} style={styles.detailExercise}>
          <Text style={styles.detailExTitle}>{exTitle}</Text>
          {exSets[0].exercise_notes
            ? <Text style={styles.muted}>{exSets[0].exercise_notes}</Text>
            : null}

          {/* Flat row layout from #10 (nested flex:0 wrappers overlapped on RNW),
              with the columns driven by whichever metrics these sets carry. */}
          <View style={styles.detailSetHeader}>
            <Text style={[styles.label, styles.setCol_type]}>TYPE</Text>
            {metrics.map((m) => (
              <Text key={m} style={[styles.label, styles.setCol_num]}>{metricLabel(m, units)}</Text>
            ))}
          </View>

          {exSets.map((s, si) => (
            <View key={si} style={styles.detailSetRow}>
              <View style={styles.detailTypeBadge}>
                <Text style={styles.detailTypeText}>
                  {SET_TYPE_LABEL[s.set_type]}
                </Text>
              </View>
              {metrics.map((m) => (
                <Text key={m} style={[styles.input, styles.setCol_num, styles.detailCell]}>
                  {displayMetric(s, m, units)}
                </Text>
              ))}
            </View>
          ))}
        </View>
        );
      })}

      <Pressable onPress={onDelete} style={styles.deleteBtn}>
        <Text style={styles.deleteBtnText}>Delete this workout</Text>
      </Pressable>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  scroll: { padding: spacing.lg, gap: spacing.lg, maxWidth: 900, alignSelf: "center", width: "100%" },
  h1:     { fontSize: 24, fontWeight: "700", color: colors.text },
  muted:  { color: colors.textMuted, fontSize: 13, lineHeight: 19 },
  mono:   { fontFamily: "monospace", fontSize: 12 },

  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.lg,
    padding: spacing.lg,
    gap: spacing.md,
  },
  cardTitle: { fontSize: 16, fontWeight: "700", color: colors.text },

  hidden: { display: "none" },

  pager: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm, paddingTop: spacing.sm },
  pagerBtn: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radii.md,
    paddingHorizontal: spacing.md, paddingVertical: 8, minHeight: 36,
    justifyContent: "center", backgroundColor: colors.surface,
  },
  pagerBtnDisabled:     { opacity: 0.4 },
  pagerBtnText:         { color: colors.accent, fontSize: 13, fontWeight: "600" },
  pagerBtnTextDisabled: { color: colors.textDim },
  pagerStatus:          { color: colors.textMuted, fontSize: 13 },

  label: { color: colors.textMuted, fontSize: 11, fontWeight: "700", letterSpacing: 0.6, marginBottom: 4 },
  input: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radii.md,
    paddingHorizontal: spacing.sm, paddingVertical: 10,
    backgroundColor: colors.surface, color: colors.text, fontSize: 14,
    outlineStyle: "none" as any,
  },

  setCol_num: { flex: 1, minWidth: 52 },

  secondary:     { borderWidth: 1, borderStyle: "dashed", borderColor: colors.borderHi, borderRadius: radii.md, paddingVertical: 16, alignItems: "center" },
  secondaryText: { color: colors.textMuted, fontSize: 13, fontWeight: "600" },

  wkRow:   { flexDirection: "row", paddingVertical: spacing.sm, borderBottomColor: colors.border, borderBottomWidth: 1, alignItems: "center" },
  wkTitle: { fontWeight: "600", color: colors.text, fontSize: 14 },

  wkActions:    { flexDirection: "row", gap: 4, alignItems: "center", marginLeft: spacing.sm },
  wkActionBtn:  { paddingHorizontal: spacing.sm, paddingVertical: 6 },
  wkActionText: { color: colors.accent, fontSize: 13, fontWeight: "600" },

  // Modal
  modalContainer: { flex: 1, backgroundColor: colors.bg },
  modalScroll:    { padding: spacing.lg, gap: spacing.lg },
  modalHeader: {
    flexDirection: "row", alignItems: "center",
    justifyContent: "space-between",
    paddingBottom: spacing.md,
    borderBottomColor: colors.border, borderBottomWidth: 1,
  },
  modalTitle: { flex: 1, fontWeight: "700", fontSize: 16, color: colors.text, marginHorizontal: spacing.sm },
  modalClose: { color: colors.accent, fontWeight: "600", fontSize: 14 },
  modalEdit:  { color: colors.accent, fontWeight: "600", fontSize: 14 },

  // Detail view
  detailExercise: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radii.md,
    padding: spacing.md, gap: spacing.sm, backgroundColor: colors.surface,
  },
  detailExTitle:   { fontWeight: "700", color: colors.text, fontSize: 14 },
  detailCell:      { backgroundColor: colors.bg, color: colors.textMuted },
  detailSetHeader: { flexDirection: "row", gap: spacing.sm, alignItems: "center" },
  detailSetRow:    { flexDirection: "row", gap: spacing.sm, alignItems: "center" },
  detailTypeBadge: { minWidth: 72, paddingHorizontal: spacing.sm, paddingVertical: 6, alignItems: "center", backgroundColor: colors.accentBg, borderRadius: radii.sm },
  detailTypeText:  { color: colors.accentTxt, fontSize: 12, fontWeight: "600" },
  setCol_type:     { minWidth: 72 },

  // Delete button
  deleteBtn: {
    borderWidth: 1, borderColor: colors.errorBdAlt, borderRadius: radii.md,
    paddingVertical: 12, alignItems: "center",
    backgroundColor: colors.errorBgAlt,
  },
  deleteBtnText: { color: colors.error, fontWeight: "600", fontSize: 14 },

  // Exercise picker
  pickerSearchWrap: {
    padding: spacing.md,
    borderBottomWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  pickerRow: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderColor: colors.border,
  },
  pickerRowHovered: { backgroundColor: colors.bg },
  pickerItemName:   { fontSize: 15, fontWeight: "500", color: colors.text },
  pickerItemMeta:   { fontSize: 12, color: colors.textMuted, marginTop: 2 },
});
