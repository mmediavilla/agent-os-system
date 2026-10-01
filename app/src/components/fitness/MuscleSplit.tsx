import React from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { FitnessStats } from "../../api";
import { chart, colors, spacing } from "../../theme";
import { useUnits } from "../../UnitsProvider";
import { fmtCount, fmtWeight } from "./chartMath";
import { panel } from "./panelStyles";

type Props = {
  data: FitnessStats["muscles"] | null;
  loading: boolean;
};

const MIN_HEIGHT = 200;

/**
 * Hard sets per primary muscle.
 *
 * Measured in sets rather than tonnage because bodyweight work carries no load —
 * a split by kilos would report your core as almost untrained. One hue for every
 * bar: this is a single magnitude, and colouring the muscles differently would
 * imply a categorical distinction that is not there.
 */
export default function MuscleSplit({ data, loading }: Props) {
  const { units } = useUnits();
  const items = data?.items ?? [];
  const max = items.length ? Math.max(...items.map((i) => i.hard_sets)) : 0;

  return (
    <View style={panel.card}>
      <View style={panel.header}>
        <Text style={panel.title}>Muscle split</Text>
        {data && data.total_hard_sets > 0 && (
          <Text style={panel.caption}>{fmtCount(data.total_hard_sets)} hard sets</Text>
        )}
      </View>

      {loading && (
        <View style={[panel.state, { minHeight: MIN_HEIGHT }]}>
          <ActivityIndicator color={colors.emerald} />
        </View>
      )}

      {!loading && items.length === 0 && (
        <View style={[panel.state, { minHeight: MIN_HEIGHT }]}>
          <Text style={panel.empty}>No hard sets in this range.</Text>
        </View>
      )}

      {!loading && items.length > 0 && (
        <View style={{ gap: spacing.sm }}>
          {items.map((m) => (
            <View
              key={m.muscle}
              style={styles.row}
              accessible
              accessibilityLabel={`${m.muscle}: ${m.hard_sets} hard sets, ${Math.round(m.share * 100)} percent, ${fmtWeight(m.tonnage_kg, units.weight)}`}
            >
              <Text style={styles.label} numberOfLines={1}>
                {m.muscle}
              </Text>
              <View style={styles.track}>
                <View
                  testID={`muscle-bar-${m.muscle}`}
                  style={[styles.fill, { width: `${max > 0 ? (m.hard_sets / max) * 100 : 0}%` }]}
                />
              </View>
              <Text style={styles.value}>{m.hard_sets}</Text>
            </View>
          ))}
        </View>
      )}

      {!loading && !!data?.unmatched_sets && (
        <Text style={panel.footnote}>
          {data.unmatched_sets} set{data.unmatched_sets === 1 ? "" : "s"} from exercises not in your
          library
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  label: { width: 84, fontSize: 12, color: colors.textMuted },
  track: { flex: 1, height: 8, backgroundColor: chart.track, borderRadius: 4, overflow: "hidden" },
  fill: { height: "100%", borderRadius: 4, backgroundColor: colors.emerald },
  value: { width: 40, textAlign: "right", fontSize: 12, fontWeight: "600", color: colors.text },
});
