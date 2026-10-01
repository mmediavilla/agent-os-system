import React from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { E1rmFormula, FitnessStats, Lift } from "../../api";
import { colors, radii, spacing } from "../../theme";
import { useUnits } from "../../UnitsProvider";
import { UNIT_SPOKEN, UnitPrefs, displayValue } from "../../units";
import { baselineRange, fmtWeight, scaledPct, shortDate } from "./chartMath";
import { panel } from "./panelStyles";

type Props = {
  data: FitnessStats["strength"] | null;
  loading: boolean;
  /** The formula the server used; unknown until the stats arrive. */
  formula?: E1rmFormula;
};

const FORMULA_NAMES: Record<E1rmFormula, string> = { epley: "Epley", brzycki: "Brzycki" };

const CHART_H = 56;
const MIN_HEIGHT = 260;

/**
 * Estimated-1RM trend for the most-trained lifts, plus recent records.
 *
 * The columns use a suppressed zero — a 120→150kg climb plotted from the origin
 * looks like a flat line — so every block labels its own endpoints and says the
 * axis is scaled. An unlabelled truncated axis is the classic chart lie.
 */
export default function StrengthProgression({ data, loading, formula }: Props) {
  const { units } = useUnits();
  const lifts = data?.lifts ?? [];
  const prs = data?.recent_prs ?? [];

  return (
    <View style={[panel.card, { flexBasis: "auto" }]}>
      <View style={panel.header}>
        <Text style={panel.title}>Strength progression</Text>
        <Text style={panel.caption}>
          {formula ? `${FORMULA_NAMES[formula]} estimated 1RM` : "Estimated 1RM"}
        </Text>
      </View>

      {loading && (
        <View style={[panel.state, { minHeight: MIN_HEIGHT }]}>
          <ActivityIndicator color={colors.emerald} />
        </View>
      )}

      {!loading && lifts.length === 0 && (
        <View style={[panel.state, { minHeight: MIN_HEIGHT }]}>
          <Text style={panel.empty}>
            Not enough data yet — a lift needs 3+ sessions with weight and reps to chart.
          </Text>
        </View>
      )}

      {!loading && lifts.length > 0 && (
        <>
          <View style={styles.grid}>
            {lifts.map((l) => (
              <LiftChart key={l.exercise_title} lift={l} units={units} />
            ))}
          </View>

          {prs.length > 0 && (
            <View style={styles.prs}>
              <Text style={styles.prsTitle}>Recent records</Text>
              {prs.map((p) => (
                <View key={`${p.exercise_title}-${p.date}`} style={styles.prRow}>
                  <Text style={styles.prDate}>{shortDate(p.date)}</Text>
                  <Text style={styles.prName} numberOfLines={1}>
                    {p.exercise_title}
                  </Text>
                  <Text style={styles.prSet}>
                    {fmtWeight(p.weight_kg, units.weight)} × {p.reps}
                  </Text>
                  <Text style={styles.prGain}>+{p.gain_pct}%</Text>
                </View>
              ))}
            </View>
          )}
        </>
      )}
    </View>
  );
}

function LiftChart({ lift, units }: { lift: Lift; units: UnitPrefs }) {
  const values = lift.points.map((p) => p.e1rm_kg);
  const { lo, hi } = baselineRange(values);
  const up = lift.change_pct > 0;
  const flat = lift.change_pct === 0;

  return (
    <View style={styles.lift}>
      <View style={styles.liftHeader}>
        <Text style={styles.liftName} numberOfLines={1}>
          {lift.exercise_title}
        </Text>
        <Text
          style={[
            styles.change,
            { color: flat ? colors.textMuted : up ? colors.emeraldTxt : colors.error },
          ]}
        >
          {up ? "+" : ""}
          {lift.change_pct}%
        </Text>
      </View>
      <Text style={panel.caption}>
        {lift.primary_muscle ?? "Unknown"} · {lift.points.length} sessions
      </Text>

      <View
        style={styles.bars}
        accessible
        // Spelled out rather than reusing fmtWeight: a screen reader announces
        // "kg" as two letters, and these numbers are read aloud, not seen.
        accessibilityLabel={`${lift.exercise_title}: estimated 1RM from ${displayValue(lift.first_e1rm_kg, units.weight)} to ${displayValue(lift.latest_e1rm_kg, units.weight)} ${UNIT_SPOKEN[units.weight]} over ${lift.points.length} sessions, best ${displayValue(lift.best_e1rm_kg, units.weight)}`}
      >
        {lift.points.map((p) => (
          <View key={p.date} style={styles.slot}>
            <View
              testID={`lift-${lift.exercise_title}-${p.date}`}
              style={[styles.bar, { height: `${scaledPct(p.e1rm_kg, lo, hi)}%` }]}
            />
          </View>
        ))}
      </View>

      <View style={styles.liftFooter}>
        <Text style={styles.endpoint}>{fmtWeight(lift.first_e1rm_kg, units.weight)}</Text>
        <Text style={panel.footnote}>scaled to range</Text>
        <Text style={[styles.endpoint, styles.endpointStrong]}>{fmtWeight(lift.latest_e1rm_kg, units.weight)}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: "row", flexWrap: "wrap", gap: spacing.md },
  lift: {
    flexBasis: 240,
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
    backgroundColor: colors.bg,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: 4,
  },
  liftHeader: { flexDirection: "row", justifyContent: "space-between", gap: spacing.xs },
  liftName: { flex: 1, fontSize: 13, fontWeight: "600", color: colors.text },
  change: { fontSize: 13, fontWeight: "700" },
  bars: {
    flexDirection: "row",
    alignItems: "flex-end",
    height: CHART_H,
    gap: 2,
    marginTop: spacing.xs,
  },
  // See VolumeTrend: the slot must fill the fixed-height row, or the bar has no
  // height to take a percentage of.
  slot: { flex: 1, minWidth: 3, maxWidth: 18, height: "100%", justifyContent: "flex-end" },
  bar: { width: "100%", backgroundColor: colors.emerald, borderTopLeftRadius: 2, borderTopRightRadius: 2 },
  liftFooter: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  endpoint: { fontSize: 11, color: colors.textMuted, fontWeight: "600" },
  endpointStrong: { color: colors.text },

  prs: { gap: 2, marginTop: spacing.xs },
  prsTitle: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.8,
    color: colors.textMuted,
    marginBottom: 2,
  },
  prRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: 5,
    borderBottomColor: colors.border,
    borderBottomWidth: 1,
  },
  prDate: { width: 52, fontSize: 11, color: colors.textDim },
  prName: { flex: 1, fontSize: 13, color: colors.text },
  prSet: { fontSize: 12, color: colors.textMuted },
  prGain: { width: 52, textAlign: "right", fontSize: 12, fontWeight: "700", color: colors.emeraldTxt },
});
