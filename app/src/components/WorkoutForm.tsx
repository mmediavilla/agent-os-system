import React from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  emptyExercise,
  emptySet,
  ExerciseInput,
  METRIC_KEYBOARD,
  metricLabel,
  MetricField,
  SET_TYPE_LABEL,
  SetInput,
} from "../setMetrics";
import DateTimeInput from "./DateTimeInput";
import { colors, radii, spacing } from "../theme";
import { useUnits } from "../UnitsProvider";

/**
 * Everything the workout session form collects. Times are kept as separate
 * date/HH:MM strings because that's what the inputs bind to; the caller
 * combines them into `started_at` / `ended_at` when submitting.
 */
export type WorkoutFormValues = {
  title: string;
  date: string;
  startTime: string;
  endTime: string;
  notes: string;
  exercises: ExerciseInput[];
};

function todayLocal() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function nowLocalTime() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Blank form seeded with today's date and the current time. */
export const emptyWorkoutForm = (): WorkoutFormValues => ({
  title: "",
  date: todayLocal(),
  startTime: nowLocalTime(),
  endTime: "",
  notes: "",
  exercises: [emptyExercise()],
});

type Props = {
  value: WorkoutFormValues;
  onChange: (patch: Partial<WorkoutFormValues>) => void;
  /** Metric columns for an exercise title — resolved against the exercise database. */
  metricsFor: (title: string) => MetricField[];
  /** Opens the caller's exercise picker for the given exercise row. */
  onPickExercise: (ei: number) => void;
  onSubmit: () => void;
  submitLabel: string;
  saving: boolean;
};

/**
 * The workout session form, shared by the create card and the edit modal.
 *
 * Exercise and set mutations live here rather than in the caller: both forms
 * previously carried their own identical copies of these six helpers, which is
 * exactly the duplication this component exists to remove. The caller owns the
 * values and just applies the patches it gets back.
 */
export default function WorkoutForm({
  value,
  onChange,
  metricsFor,
  onPickExercise,
  onSubmit,
  submitLabel,
  saving,
}: Props) {
  const { exercises } = value;
  // The form works entirely in display units; WorkoutForm's caller converts
  // back to kilograms and kilometers when it builds the payload.
  const { units } = useUnits();

  const setExercises = (next: ExerciseInput[]) => onChange({ exercises: next });

  const addExercise = () => setExercises([...exercises, emptyExercise()]);

  const removeExercise = (ei: number) =>
    setExercises(exercises.filter((_, i) => i !== ei));

  const addSet = (ei: number) =>
    setExercises(
      exercises.map((e, i) => (i === ei ? { ...e, sets: [...e.sets, emptySet()] } : e))
    );

  const removeSet = (ei: number, si: number) =>
    setExercises(
      exercises.map((e, i) =>
        i === ei ? { ...e, sets: e.sets.filter((_, j) => j !== si) } : e
      )
    );

  const updateSet = (ei: number, si: number, patch: Partial<SetInput>) =>
    setExercises(
      exercises.map((e, i) =>
        i === ei
          ? { ...e, sets: e.sets.map((s, j) => (j === si ? { ...s, ...patch } : s)) }
          : e
      )
    );

  return (
    <>
      <Field
        label="Workout title"
        value={value.title}
        onChange={(title) => onChange({ title })}
        placeholder="e.g. Upper 2 – Hypertrophy / Width Bias"
      />
      <View style={styles.formRow}>
        <Field label="Date" picker="date" value={value.date} onChange={(date) => onChange({ date })} />
        <Field label="Start time" picker="time" value={value.startTime} onChange={(startTime) => onChange({ startTime })} />
        <Field label="End time (optional)" picker="time" value={value.endTime} onChange={(endTime) => onChange({ endTime })} />
      </View>

      {exercises.map((ex, ei) => {
        // Computed once per exercise rather than for the header and every row.
        const metrics = metricsFor(ex.exercise_title);
        return (
          <View key={ei} style={styles.exerciseBlock}>
            <View style={styles.exerciseHeader}>
              <View style={{ flex: 1 }}>
                <Text style={styles.label}>Exercise {ei + 1}</Text>
                <Pressable
                  onPress={() => onPickExercise(ei)}
                  style={[styles.input, styles.pickerBtn]}
                >
                  <Text style={ex.exercise_title ? styles.pickerBtnText : styles.pickerBtnPlaceholder} numberOfLines={1}>
                    {ex.exercise_title || "Select exercise…"}
                  </Text>
                </Pressable>
              </View>
              {exercises.length > 1 && (
                <Pressable onPress={() => removeExercise(ei)} style={styles.removeBtn}>
                  <Text style={styles.removeBtnText}>Remove</Text>
                </Pressable>
              )}
            </View>

            <View style={styles.setHeader}>
              {metrics.map((m) => (
                <Text key={m} style={[styles.label, styles.setCol_num]}>{metricLabel(m, units)}</Text>
              ))}
              {ex.sets.length > 1 && <View style={styles.setCol_del} />}
            </View>

            {ex.sets.map((s, si) => (
              <View key={si} style={styles.setRow}>
                <View style={styles.typeRow}>
                  {(["normal", "warmup", "failure", "dropset"] as const).map((t) => (
                    <Pressable key={t} onPress={() => updateSet(ei, si, { set_type: t })}
                      style={[styles.typePill, s.set_type === t && styles.typePillActive]}>
                      <Text style={[styles.typePillText, s.set_type === t && styles.typePillTextActive]}>
                        {SET_TYPE_LABEL[t]}
                      </Text>
                    </Pressable>
                  ))}
                </View>
                <View style={styles.inputRow}>
                  {metrics.map((m) => (
                    <TextInput
                      key={m}
                      value={s[m]}
                      onChangeText={(v) => updateSet(ei, si, { [m]: v })}
                      placeholder="—"
                      placeholderTextColor={colors.textDim}
                      keyboardType={METRIC_KEYBOARD[m]}
                      style={[styles.input, styles.setCol_num]}
                    />
                  ))}
                  {ex.sets.length > 1 && (
                    <Pressable onPress={() => removeSet(ei, si)} style={styles.setCol_del}>
                      <Text style={styles.removeBtnText}>×</Text>
                    </Pressable>
                  )}
                </View>
              </View>
            ))}

            <Pressable onPress={() => addSet(ei)} style={styles.addSetBtn}>
              <Text style={styles.addSetBtnText}>+ Add set</Text>
            </Pressable>
          </View>
        );
      })}

      <Pressable onPress={addExercise} style={styles.addExerciseBtn}>
        <Text style={styles.addExerciseBtnText}>+ Add exercise</Text>
      </Pressable>

      <Field
        label="Notes (optional)"
        value={value.notes}
        onChange={(notes) => onChange({ notes })}
        placeholder="Session notes…"
        multiline
      />

      <Pressable
        onPress={onSubmit}
        disabled={saving}
        style={({ hovered }: any) => [styles.primary, saving && { opacity: 0.6 }, hovered && !saving && { backgroundColor: colors.accentHov }]}
      >
        {saving ? <ActivityIndicator color={colors.bg} /> : <Text style={styles.primaryText}>{submitLabel}</Text>}
      </Pressable>
    </>
  );
}

/**
 * A labelled field. `picker` swaps the text box for the browser's own date or
 * time control (`DateTimeInput`) — the three fields that used to ask for
 * `YYYY-MM-DD` and `HH:MM` in a placeholder, which is the format the picker
 * hands back anyway. A placeholder is dropped with it, because neither control
 * shows one.
 */
function Field({ label, value, onChange, placeholder, keyboardType, multiline, picker }: {
  label: string; value: string; onChange: (s: string) => void;
  placeholder?: string; keyboardType?: any; multiline?: boolean; picker?: "date" | "time";
}) {
  return (
    <View style={{ flex: 1 }}>
      <Text style={styles.label}>{label}</Text>
      {picker ? (
        <DateTimeInput kind={picker} value={value} onChangeText={onChange} style={styles.input} />
      ) : (
        <TextInput
          value={value}
          onChangeText={onChange}
          placeholder={placeholder}
          placeholderTextColor={colors.textDim}
          keyboardType={keyboardType}
          multiline={multiline}
          style={[styles.input, multiline && { minHeight: 60, textAlignVertical: "top" }]}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  formRow: { flexDirection: "row", gap: spacing.md },
  label:   { color: colors.textMuted, fontSize: 11, fontWeight: "700", letterSpacing: 0.6, marginBottom: 4 },
  input: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radii.md,
    paddingHorizontal: spacing.sm, paddingVertical: 10,
    backgroundColor: colors.surface, color: colors.text, fontSize: 14,
    outlineStyle: "none" as any,
  },

  exerciseBlock: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.sm,
    backgroundColor: colors.bg,
  },
  exerciseHeader: { flexDirection: "row", gap: spacing.sm, alignItems: "flex-end" },

  setHeader: { flexDirection: "row", gap: spacing.sm, alignItems: "center", paddingHorizontal: 2 },
  setRow:    { flexDirection: "column", gap: spacing.xs },

  setCol_num: { flex: 1, minWidth: 52 },
  setCol_del: { width: 28, alignItems: "center" },

  typeRow:  { flexDirection: "row", gap: spacing.xs },
  inputRow: { flexDirection: "row", gap: spacing.sm, alignItems: "center" },

  typePill:           { flex: 1, paddingVertical: 8, alignItems: "center", borderWidth: 1, borderColor: colors.border, borderRadius: radii.sm, backgroundColor: colors.surface },
  typePillActive:     { backgroundColor: colors.accentBg, borderColor: colors.accentBg },
  typePillText:       { color: colors.textMuted, fontSize: 12, fontWeight: "600" },
  typePillTextActive: { color: colors.accentTxt },

  addSetBtn:     { borderWidth: 1, borderStyle: "dashed", borderColor: colors.borderHi, borderRadius: radii.sm, paddingVertical: 6, alignItems: "center" },
  addSetBtnText: { color: colors.textMuted, fontSize: 12, fontWeight: "600" },

  addExerciseBtn:     { borderWidth: 1, borderStyle: "dashed", borderColor: colors.borderHi, borderRadius: radii.md, paddingVertical: 10, alignItems: "center" },
  addExerciseBtnText: { color: colors.textMuted, fontSize: 13, fontWeight: "600" },

  removeBtn:     { paddingHorizontal: spacing.sm, paddingVertical: 10 },
  removeBtnText: { color: colors.danger, fontSize: 12, fontWeight: "600" },

  primary:     { backgroundColor: colors.accent, paddingVertical: 12, borderRadius: radii.md, alignItems: "center", justifyContent: "center", minHeight: 44 },
  primaryText: { color: colors.bg, fontWeight: "700", fontSize: 14 },

  pickerBtn:            { justifyContent: "center", minHeight: 42 },
  pickerBtnText:        { color: colors.text, fontSize: 14 },
  pickerBtnPlaceholder: { color: colors.textDim, fontSize: 14 },
});
