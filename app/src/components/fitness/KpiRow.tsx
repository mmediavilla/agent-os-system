import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { FitnessStats } from "../../api";
import { chart, colors, radii, spacing } from "../../theme";
import { useUnits } from "../../UnitsProvider";
import { fmtCount, fmtWeight } from "./chartMath";
import { panel } from "./panelStyles";

type Props = {
  kpis: FitnessStats["kpis"] | null;
  loading: boolean;
  /** From the workouts summary — "as of today", not scoped to the range. */
  weekCount?: number;
  weekGoal?: number;
  streakDays?: number;
};

export default function KpiRow({ kpis, loading, weekCount, weekGoal, streakDays }: Props) {
  const { units } = useUnits();
  const goal = Math.max(1, weekGoal ?? 4);
  const done = weekCount ?? 0;
  const pct = Math.min(100, (done / goal) * 100);
  const dash = loading || !kpis;

  return (
    <View style={[panel.card, { flexBasis: "auto" }]}>
      <View style={styles.tiles}>
        <Tile label="SESSIONS" value={dash ? "—" : fmtCount(kpis.sessions)} />
        <Tile label="HARD SETS" value={dash ? "—" : fmtCount(kpis.hard_sets)} />
        <Tile label="TONNAGE" value={dash ? "—" : fmtWeight(kpis.tonnage_kg, units.weight)} />
        <Tile label="AVG SESSION" value={dash ? "—" : `${Math.round(kpis.avg_duration_min)}m`} />
        <Tile label="PER WEEK" value={dash ? "—" : `${kpis.sessions_per_week}`} />
      </View>

      {/* Deliberately separated from the tiles above: these two are "as of
          today" and do not move when the range changes. */}
      <View style={styles.footer}>
        <View style={styles.goal}>
          <View style={styles.goalHeader}>
            <Text style={panel.caption}>
              This week · {done} of {goal} workouts
            </Text>
            <Text style={styles.goalPct}>{Math.round(pct)}%</Text>
          </View>
          <View style={styles.track}>
            <View style={[styles.fill, { width: `${pct}%` }]} />
          </View>
        </View>
        <View style={styles.streak}>
          <Text style={styles.streakValue}>{streakDays ?? 0}d</Text>
          <Text style={styles.tileLabel}>STREAK</Text>
        </View>
      </View>
    </View>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.tile}>
      <Text style={styles.tileLabel}>{label}</Text>
      <Text style={styles.tileValue} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  tiles: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  tile: {
    flexBasis: 110,
    flexGrow: 1,
    minWidth: 0,
    backgroundColor: colors.bg,
    borderRadius: radii.md,
    padding: spacing.sm,
  },
  tileLabel: { color: colors.textMuted, fontSize: 10, fontWeight: "600", letterSpacing: 0.8 },
  tileValue: { color: colors.text, fontSize: 20, fontWeight: "700", marginTop: 2 },

  footer: { flexDirection: "row", alignItems: "flex-end", gap: spacing.lg },
  goal: { flex: 1, gap: 6, minWidth: 0 },
  goalHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" },
  goalPct: { color: colors.text, fontWeight: "600", fontSize: 13 },
  track: { height: 8, backgroundColor: chart.track, borderRadius: 4, overflow: "hidden" },
  fill: { height: "100%", borderRadius: 4, backgroundColor: colors.emerald },
  streak: { alignItems: "flex-end" },
  streakValue: { color: colors.text, fontSize: 20, fontWeight: "700" },
});
