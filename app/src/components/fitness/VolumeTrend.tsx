import React from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { FitnessStats } from "../../api";
import { chart, colors, spacing } from "../../theme";
import { useUnits } from "../../UnitsProvider";
import { barPct, fmtCount, fmtWeight, shortDate } from "./chartMath";
import { panel } from "./panelStyles";

type Props = {
  data: FitnessStats["volume"] | null;
  loading: boolean;
};

const TONNAGE_H = 110;
const SETS_H = 44;
const MIN_HEIGHT = TONNAGE_H + SETS_H + 46;

/** Roughly how many week labels fit before they start colliding. */
const MAX_LABELS = 6;

/**
 * Weekly tonnage above weekly hard sets, sharing one axis.
 *
 * Two small multiples rather than one dual-axis chart: kilograms and set counts
 * are not comparable, so a shared baseline would invite the reader to compare
 * two heights that mean nothing to each other.
 */
export default function VolumeTrend({ data, loading }: Props) {
  const { units } = useUnits();
  const weeks = data?.weeks ?? [];
  const trained = weeks.filter((w) => w.sessions > 0).length;

  const step = Math.max(1, Math.ceil(weeks.length / MAX_LABELS));
  const ticks = weeks.filter((_, i) => i % step === 0).map((w) => w.week_start);

  return (
    <View style={panel.card}>
      <View style={panel.header}>
        <Text style={panel.title}>Volume trend</Text>
        {trained > 0 && (
          <Text style={panel.caption}>
            {trained} active week{trained === 1 ? "" : "s"}
          </Text>
        )}
      </View>

      {loading && (
        <View style={[panel.state, { minHeight: MIN_HEIGHT }]}>
          <ActivityIndicator color={colors.emerald} />
        </View>
      )}

      {!loading && trained === 0 && (
        <View style={[panel.state, { minHeight: MIN_HEIGHT }]}>
          <Text style={panel.empty}>No volume logged in this range.</Text>
        </View>
      )}

      {!loading && trained > 0 && (
        <View>
          <View style={styles.legendRow}>
            <Legend color={chart.tonnage} text={`Tonnage · peak ${fmtWeight(data!.max_tonnage_kg, units.weight)}`} />
          </View>
          <View style={[styles.bars, { height: TONNAGE_H }]}>
            {weeks.map((w) => (
              <Bar
                key={w.week_start}
                testID={`vol-ton-${w.week_start}`}
                pct={barPct(w.tonnage_kg, data!.max_tonnage_kg)}
                color={chart.tonnage}
                label={`Week of ${shortDate(w.week_start)}: ${fmtWeight(w.tonnage_kg, units.weight)} over ${w.sessions} session${w.sessions === 1 ? "" : "s"}`}
              />
            ))}
          </View>

          <View style={styles.legendRow}>
            <Legend color={chart.sets} text={`Hard sets · peak ${fmtCount(data!.max_hard_sets)}`} />
          </View>
          <View style={[styles.bars, { height: SETS_H }]}>
            {weeks.map((w) => (
              <Bar
                key={w.week_start}
                testID={`vol-sets-${w.week_start}`}
                pct={barPct(w.hard_sets, data!.max_hard_sets)}
                color={chart.sets}
              />
            ))}
          </View>

          {/* Spread across the same width rather than parked under their own
              bar: at 53 weeks a per-bar slot is a few pixels wide and clips the
              date to a stub. Ends anchored, middles evenly spaced, still reads
              as an axis. */}
          <View style={styles.axis}>
            {ticks.map((t) => (
              <Text key={t} style={panel.axisLabel} numberOfLines={1}>
                {shortDate(t)}
              </Text>
            ))}
          </View>
        </View>
      )}
    </View>
  );
}

function Bar({
  pct,
  color,
  testID,
  label,
}: {
  pct: number;
  color: string;
  testID: string;
  label?: string;
}) {
  return (
    <View style={styles.slot}>
      <View
        testID={testID}
        accessible={!!label}
        accessibilityLabel={label}
        style={{
          width: "100%",
          maxWidth: 40,
          height: `${pct}%`,
          backgroundColor: color,
          borderTopLeftRadius: 2,
          borderTopRightRadius: 2,
        }}
      />
    </View>
  );
}

function Legend({ color, text }: { color: string; text: string }) {
  return (
    <View style={styles.legend}>
      <View style={[styles.swatch, { backgroundColor: color }]} />
      <Text style={panel.caption}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  // `alignItems: flex-end` is what makes each bar grow up from the baseline;
  // the percentage heights need this fixed-height parent to resolve against.
  bars: { flexDirection: "row", alignItems: "flex-end", gap: 2 },
  // A capped slot stops a four-week range from rendering four wide slabs. No
  // horizontal ScrollView around this: without a definite parent width, these
  // flex slots collapse to nothing and the bars vanish.
  // `height: "100%"` is load-bearing: without it the slot shrinks to fit its
  // content, and the bar's percentage height resolves against nothing.
  slot: { flex: 1, minWidth: 2, maxWidth: 40, height: "100%", alignItems: "center", justifyContent: "flex-end" },
  axis: { flexDirection: "row", justifyContent: "space-between", marginTop: 4, gap: spacing.xs },
  legendRow: { marginTop: spacing.sm, marginBottom: 4 },
  legend: { flexDirection: "row", alignItems: "center", gap: 6 },
  swatch: { width: 8, height: 8, borderRadius: 2 },
});
