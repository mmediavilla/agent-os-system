import React, { useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import {
  CalculationSettings,
  E1RM_FORMULAS,
  E1rmFormula,
  FitnessServerSettings,
  FitnessSettingsPatch,
  NUDGE_TRIGGERS,
  NudgeTrigger,
  WEEK_STARTS,
  WeekStart,
  api,
} from "../api";
import DateTimeInput from "./DateTimeInput";
import { RadioGroup, settingsStyles as ss } from "./SettingsParts";
import { useServerSettings } from "./useServerSettings";
import { useFitnessPrefs } from "../FitnessPrefsProvider";
import { useUnits } from "../UnitsProvider";
import { STATS_RANGES, STATS_RANGE_DESCRIPTIONS, STATS_RANGE_LABELS } from "../fitnessPrefs";
import {
  DIMENSION_LABELS,
  UNIT_DIMENSIONS,
  UNIT_LABELS,
  UNIT_OPTIONS,
  Unit,
  UnitDimension,
  displayValue,
} from "../units";
import { colors, radii, spacing } from "../theme";

/** Where each unit actually shows up, so the choice isn't abstract. */
const UNIT_DESCRIPTIONS: Record<Unit, string> = {
  kg: "Loads and tonnage in kilograms.",
  lb: "Loads and tonnage in pounds.",
  km: "Cardio distances in kilometers.",
  mi: "Cardio distances in miles.",
  cm: "Girths and lengths in centimeters.",
  in: "Girths and lengths in inches.",
};

const DIMENSION_FOOTNOTES: Partial<Record<UnitDimension, string>> = {
  // Said plainly, because nothing on screen demonstrates this one yet.
  measurement: "Body measurements aren't logged in the app yet — this applies when they are.",
};

/**
 * Fitness → Settings: what changes how the training numbers read.
 *
 * **The units moved here from the HUD's Settings** in 12.0 (the owner's call): kilos,
 * kilometres and centimetres only ever appear on the Fitness screens, so the
 * setting sits beside them. Both stay browser-only preferences
 * (`UnitsProvider`, `FitnessPrefsProvider`) — nothing without a browser reads
 * them.
 *
 * **The morning nudge is the exception** (12.1): the scheduler decides whether
 * and when it runs and the worker decides what it says, so those settings are
 * rows on the server, read each time the tab is arrived at. **So are the
 * calculations** (12.2) — the e1RM formula and the week's first day change the
 * numbers the nudge and the assistant read, not only the ones drawn here.
 */
export default function FitnessSettings({ active }: { active: boolean }) {
  const { units, setUnit } = useUnits();
  const { prefs, setPref } = useFitnessPrefs();
  const server = useFitnessServerSettings(active);

  const shown = (canonical: number, unit: Unit) => `${displayValue(canonical, unit)} ${unit}`;

  return (
    <View style={ss.root} testID="fitness-settings">
      {/* Two columns on a wide window — what this browser shows on the left,
          what the machine decides on the right — which wrap into one when
          there is no room for two. Flex wrapping rather than a measured
          breakpoint, so no frame is drawn at the wrong width. */}
      <ScrollView contentContainerStyle={[ss.body, s.columns]}>
        <View style={s.column} testID="fitness-settings-browser">
          <View style={ss.section}>
            <Text style={ss.sectionLabel}>Units</Text>

            {UNIT_DIMENSIONS.map((dimension) => (
              <View key={dimension} style={ss.group}>
                <Text style={ss.groupLabel}>{DIMENSION_LABELS[dimension]}</Text>
                <RadioGroup
                  groupLabel={DIMENSION_LABELS[dimension]}
                  options={UNIT_OPTIONS[dimension]}
                  selected={units[dimension]}
                  labelFor={(u) => UNIT_LABELS[u]}
                  descriptionFor={(u) => UNIT_DESCRIPTIONS[u]}
                  onSelect={(u) => setUnit(dimension, u)}
                />
                {DIMENSION_FOOTNOTES[dimension] ? (
                  <Text style={ss.footnote}>{DIMENSION_FOOTNOTES[dimension]}</Text>
                ) : null}
              </View>
            ))}

            {/* Fixed canonical values — 100kg, 5km, 80cm — so what moves when a
                radio is pressed is only what the setting changes. */}
            <View style={[ss.card, s.sample]} testID="fitness-units-preview">
              {[
                { label: "Bench press", value: `3 × 8 · ${shown(100, units.weight)}` },
                { label: "Treadmill", value: shown(5, units.distance) },
                { label: "Waist", value: shown(80, units.measurement) },
              ].map((row, i) => (
                <View key={row.label} style={[s.sampleRow, i > 0 && ss.optionDivided]}>
                  <Text style={s.sampleLabel}>{row.label}</Text>
                  <Text style={s.sampleValue}>{row.value}</Text>
                </View>
              ))}
            </View>

            <Text style={ss.footnote}>
              Workouts are always stored in kilograms and kilometers — switching a
              unit changes what you see and type, never what's saved.
            </Text>
          </View>

          <View style={ss.section}>
            <Text style={ss.sectionLabel}>Home</Text>

            <View style={ss.group}>
              <Text style={ss.groupLabel}>Default stats range</Text>
              <RadioGroup
                groupLabel="Default stats range"
                options={STATS_RANGES}
                selected={prefs.defaultRange}
                labelFor={(r) => STATS_RANGE_LABELS[r]}
                descriptionFor={(r) => STATS_RANGE_DESCRIPTIONS[r]}
                onSelect={(r) => setPref("defaultRange", r)}
              />
              <Text style={ss.footnote}>
                What Training analytics opens on. The pills on Home still change it
                for the moment.
              </Text>
            </View>
          </View>
        </View>

        <View style={s.column} testID="fitness-settings-machine">
          <Calculations server={server} />

          <MorningNudges server={server} />
        </View>
      </ScrollView>
    </View>
  );
}

type Section = "calculations" | "nudges";

type ServerSettings = ReturnType<typeof useFitnessServerSettings>;

/** The server half of this tab, read on arrival and shared by its two sections. */
const useFitnessServerSettings = (active: boolean) =>
  useServerSettings<FitnessServerSettings, FitnessSettingsPatch, Section>(
    active,
    api.getFitnessSettings,
    api.patchFitnessSettings,
  );

const FORMULA_COPY: Record<E1rmFormula, { label: string; description: string }> = {
  epley: {
    label: "Epley",
    description: "Weight × (1 + reps ÷ 30). A single reads as exactly what was lifted.",
  },
  brzycki: {
    label: "Brzycki",
    description:
      "Weight × 36 ÷ (37 − reps). Lower than Epley under ten reps, higher over it, and a single reads about 3% over the weight.",
  },
};

const WEEK_START_COPY: Record<WeekStart, { label: string; description: string }> = {
  monday: { label: "Monday", description: "Weekly volume and the consistency grid run Monday to Sunday." },
  sunday: { label: "Sunday", description: "Weekly volume and the consistency grid run Sunday to Saturday." },
};

/** How the stats are worked out — the same for Home, the assistant and the nudge. */
function Calculations({ server }: { server: ServerSettings }) {
  const { settings, loadError, saving, save, errorFor } = server;
  const calculations = settings?.calculations ?? null;

  const choose = (patch: Partial<CalculationSettings>) => {
    if (!calculations || saving) return;
    const changed = (Object.keys(patch) as (keyof CalculationSettings)[]).some(
      (k) => patch[k] !== calculations[k],
    );
    if (changed) save("calculations", { calculations: patch });
  };

  const error = errorFor("calculations");

  return (
    <View style={ss.section} testID="fitness-calculations">
      <Text style={ss.sectionLabel}>Calculations</Text>

      {!calculations && !loadError && <ActivityIndicator color={colors.accent} />}
      {/* Said once, here; the nudges below share the same read. */}
      {loadError && <Text style={s.errorNote}>{loadError}</Text>}

      {calculations && (
        <>
          <View style={ss.group}>
            <Text style={ss.groupLabel}>Estimated 1RM</Text>
            <RadioGroup
              groupLabel="Estimated 1RM formula"
              options={E1RM_FORMULAS}
              selected={calculations.e1rm_formula}
              labelFor={(f) => FORMULA_COPY[f].label}
              descriptionFor={(f) => FORMULA_COPY[f].description}
              onSelect={(e1rm_formula) => choose({ e1rm_formula })}
            />
          </View>

          <View style={ss.group}>
            <Text style={ss.groupLabel}>Week starts on</Text>
            <RadioGroup
              groupLabel="Week starts on"
              options={WEEK_STARTS}
              selected={calculations.week_start}
              labelFor={(d) => WEEK_START_COPY[d].label}
              descriptionFor={(d) => WEEK_START_COPY[d].description}
              onSelect={(week_start) => choose({ week_start })}
            />
          </View>
        </>
      )}

      {error && <Text style={s.errorNote}>{error}</Text>}

      <Text style={ss.footnote}>
        Kept on this machine, so Home, the assistant and the morning nudge count
        the same way. Nothing stored changes — records and weeks are worked out
        again each time they are read.
      </Text>
    </View>
  );
}

/** One line each, from what the trigger actually checks (`ProactiveTriggers`). */
const TRIGGER_COPY: Record<NudgeTrigger, { label: string; description: string }> = {
  layoff: { label: "Time off", description: "Four or more days since your last session." },
  volume_drop: {
    label: "Volume drop",
    description: "Last week's hard sets down by more than 30% on the three weeks before.",
  },
  new_pr: { label: "New record", description: "A personal record set yesterday." },
  muscle_gap: {
    label: "Muscle gap",
    description: "A muscle group under 8% of your hard sets over twelve weeks.",
  },
};

/** "7:05" and "07:05" both mean five past seven; anything else is not a time. */
export function normaliseTime(text: string): string | null {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(text);
  if (!m) return null;
  if (Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}

/** Whether, when and about what the assistant speaks unprompted. */
function MorningNudges({ server }: { server: ServerSettings }) {
  const { settings, loadError, saving, errorFor, setErrorFor } = server;
  const [timeDraft, setTimeDraft] = useState("");

  const nudges = settings?.nudges ?? null;

  // Every answer from the server — the first read and each save — resets the
  // draft to what is stored.
  useEffect(() => {
    if (settings) setTimeDraft(settings.nudges.time);
  }, [settings]);

  const save = (patch: NonNullable<FitnessSettingsPatch["nudges"]>) => server.save("nudges", { nudges: patch });
  const error = errorFor("nudges");
  const setError = (message: string | null) => setErrorFor("nudges", message);

  const commitTime = () => {
    if (!nudges) return;
    // An emptied picker is a clear, not a typo — the stored time goes back. The
    // same rule is on an automation's time field.
    if (timeDraft.trim() === "") {
      setTimeDraft(nudges.time);
      setError(null);
      return;
    }
    const time = normaliseTime(timeDraft);
    if (time === null) {
      setError("Use a 24-hour time, like 07:00.");
      return;
    }
    setTimeDraft(time);
    if (time !== nudges.time) save({ time });
  };

  const toggleTrigger = (trigger: NudgeTrigger, on: boolean) => {
    if (!nudges) return;
    const chosen = new Set(nudges.triggers);
    if (on) chosen.add(trigger);
    else chosen.delete(trigger);
    save({ triggers: NUDGE_TRIGGERS.filter((t) => chosen.has(t)) });
  };

  return (
    <View style={ss.section} testID="fitness-nudges">
      <Text style={ss.sectionLabel}>Morning nudges</Text>

      {!nudges && !loadError && <ActivityIndicator color={colors.accent} />}

      {nudges && (
        <>
          <View style={ss.card}>
            <View style={ss.option}>
              <View style={ss.optionText}>
                <Text style={ss.optionLabel}>Nudges</Text>
                <Text style={ss.optionDesc}>
                  A short note on Home when something in your training is worth a
                  word. Most mornings nothing is, and nothing is sent.
                </Text>
              </View>
              <Switch
                testID="nudges-toggle"
                accessibilityLabel="Morning nudges"
                value={nudges.enabled}
                disabled={saving}
                onValueChange={(enabled) => save({ enabled })}
                trackColor={{ true: colors.accent, false: colors.borderHi }}
              />
            </View>

            <View style={[ss.option, ss.optionDivided]}>
              <View style={ss.optionText}>
                <Text style={ss.optionLabel}>Time</Text>
                <Text style={ss.optionDesc}>On {nudges.timezone} time.</Text>
              </View>
              <DateTimeInput
                kind="time"
                testID="nudges-time"
                accessibilityLabel="Nudge time"
                value={timeDraft}
                onChangeText={(text) => {
                  setTimeDraft(text);
                  setError(null);
                }}
                onBlur={commitTime}
                onSubmitEditing={commitTime}
                editable={!saving}
                style={s.timeInput}
              />
            </View>
          </View>

          <View style={ss.group}>
            <Text style={ss.groupLabel}>What a nudge may mention</Text>
            <View style={ss.card}>
              {NUDGE_TRIGGERS.map((trigger, i) => (
                <View key={trigger} style={[ss.option, i > 0 && ss.optionDivided]}>
                  <View style={ss.optionText}>
                    <Text style={[ss.optionLabel, !nudges.enabled && s.labelOff]}>
                      {TRIGGER_COPY[trigger].label}
                    </Text>
                    <Text style={ss.optionDesc}>{TRIGGER_COPY[trigger].description}</Text>
                  </View>
                  <Switch
                    testID={`nudge-trigger-${trigger}`}
                    accessibilityLabel={TRIGGER_COPY[trigger].label}
                    value={nudges.triggers.includes(trigger)}
                    disabled={saving}
                    onValueChange={(on) => toggleTrigger(trigger, on)}
                    trackColor={{ true: colors.accent, false: colors.borderHi }}
                  />
                </View>
              ))}
            </View>
          </View>
        </>
      )}

      {error && <Text style={s.errorNote}>{error}</Text>}

      <Text style={ss.footnote}>
        Decided on this machine, not in this browser: the scheduler and queue
        worker tasks have to be registered, and switching the Anthropic API off in
        Settings silences nudges too.
      </Text>
    </View>
  );
}

const s = StyleSheet.create({
  // The whole width of the overlay (the shared body caps at 720px, which left
  // half of it empty), top-aligned so a short column does not stretch to its
  // neighbour's height.
  columns: {
    maxWidth: "100%",
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "flex-start",
    columnGap: spacing.xl,
  },
  // A column wraps below the other when it cannot have 440px.
  column: { flexGrow: 1, flexShrink: 1, flexBasis: 440, gap: spacing.xl },
  labelOff: { color: colors.textMuted },
  errorNote: { fontSize: 13, color: colors.error },
  timeInput: {
    // The browser's own time control needs the room — see AutomationsView.
    width: 116,
    fontSize: 15,
    textAlign: "center",
    fontVariant: ["tabular-nums"],
    color: colors.text,
    backgroundColor: colors.bg,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  sample: { paddingVertical: spacing.xs },
  sampleRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  sampleLabel: { fontSize: 13, color: colors.textMuted },
  sampleValue: { fontSize: 13, fontWeight: "500", color: colors.text, fontVariant: ["tabular-nums"] },
});
