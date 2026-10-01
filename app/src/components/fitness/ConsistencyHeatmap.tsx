import React, { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { FitnessStats, HeatmapDay } from "../../api";
import { chart, colors, spacing } from "../../theme";
import { useUnits } from "../../UnitsProvider";
import { fmtWeight, fromDayNum, heatLevel, longDate, monthTicks, toDayNum } from "./chartMath";
import { panel } from "./panelStyles";

type Props = {
  data: FitnessStats["heatmap"] | null;
  loading: boolean;
  /** Human phrase for the active window, e.g. "the last 4 weeks". */
  rangeLabel: string;
};

const GUTTER = 30;
const GAP = 3;
const MIN_HEIGHT = 150;

/**
 * Monday, Wednesday and Friday are labelled wherever they fall. Row 0 is
 * whatever day the server's grid starts on (Fitness → Settings → Week starts
 * on), so the rows are read off `from` rather than assumed.
 */
const LABELLED_DAYS: Record<number, string> = { 1: "Mon", 3: "Wed", 5: "Fri" };

export function dayLabels(fromIso: string): string[] {
  const origin = toDayNum(fromIso);
  return Array.from({ length: 7 }, (_, row) => LABELLED_DAYS[fromDayNum(origin + row).dow] ?? "");
}

/**
 * A day-per-cell calendar of training, shaded by hard sets.
 *
 * Built from Views rather than SVG, and laid out column-major — one column per
 * week, seven cells down — so the grid geometry is the same arithmetic the cell
 * lookup uses, with no reliance on wrapping to land days in the right row.
 */
export default function ConsistencyHeatmap({ data, loading, rangeLabel }: Props) {
  const { width } = useWindowDimensions();
  const { units } = useUnits();
  const [hovered, setHovered] = useState<HeatmapDay | null>(null);

  const cell = width < 700 ? 9 : 11;
  const pitch = cell + GAP;

  const start = data ? toDayNum(data.from) : 0;
  const end = data ? toDayNum(data.to) : 0;
  const cols = data ? Math.max(1, Math.ceil((end - start + 1) / 7)) : 0;

  const byDate = new Map((data?.days ?? []).map((d) => [d.date, d]));
  const sessions = (data?.days ?? []).reduce((n, d) => n + d.sessions, 0);

  const summary = data
    ? `${sessions} session${sessions === 1 ? "" : "s"} across ${cols} weeks` +
      (data.max_hard_sets > 0 ? `; busiest day ${data.max_hard_sets} hard sets` : "")
    : "";

  return (
    <View style={[panel.card, { flexBasis: "auto" }]}>
      <View style={panel.header}>
        <Text style={panel.title}>Consistency</Text>
        <Legend cell={cell} />
      </View>

      {loading && (
        <View style={[panel.state, { minHeight: MIN_HEIGHT }]}>
          <ActivityIndicator color={colors.emerald} />
        </View>
      )}

      {!loading && data && (
        <>
          {/* Read before the grid, so a screen reader gets the gist without
              walking every cell. */}
          <Text style={panel.caption}>{summary}</Text>

          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View>
              <View style={styles.row}>
                <View style={{ width: GUTTER }} />
                <View style={{ height: 14, width: cols * pitch }}>
                  {monthTicks(start, cols).map((t) => (
                    <Text
                      key={t.col}
                      style={[panel.axisLabel, styles.monthLabel, { left: t.col * pitch }]}
                    >
                      {t.label}
                    </Text>
                  ))}
                </View>
              </View>

              <View style={styles.row}>
                <View style={{ width: GUTTER, gap: GAP }}>
                  {dayLabels(data.from).map((label, i) => (
                    <View key={i} style={{ height: cell, justifyContent: "center" }}>
                      <Text style={panel.axisLabel}>{label}</Text>
                    </View>
                  ))}
                </View>

                <View style={{ flexDirection: "row", gap: GAP }}>
                  {Array.from({ length: cols }, (_, col) => (
                    <View key={col} style={{ gap: GAP }}>
                      {Array.from({ length: 7 }, (_, row) => {
                        const n = start + col * 7 + row;
                        // Past the window: kept as an invisible spacer so every
                        // column stays the same height.
                        if (n > end) {
                          return <View key={row} style={{ width: cell, height: cell }} />;
                        }
                        const iso = fromDayNum(n).iso;
                        const day = byDate.get(iso);
                        return (
                          <Cell
                            key={row}
                            iso={iso}
                            day={day}
                            size={cell}
                            onHover={setHovered}
                          />
                        );
                      })}
                    </View>
                  ))}
                </View>
              </View>
            </View>
          </ScrollView>

          {/* One shared caption rather than 366 tooltips. */}
          <Text style={[panel.caption, styles.hoverLine]} numberOfLines={1}>
            {hovered
              ? `${longDate(hovered.date)} — ${hovered.hard_sets} hard sets · ${fmtWeight(hovered.tonnage_kg, units.weight)} · ${Math.round(hovered.duration_min)} min`
              : sessions === 0
                ? `No sessions in ${rangeLabel}.`
                : "Hover a day for its detail."}
          </Text>
        </>
      )}
    </View>
  );
}

function Cell({
  iso,
  day,
  size,
  onHover,
}: {
  iso: string;
  day: HeatmapDay | undefined;
  size: number;
  onHover: (d: HeatmapDay | null) => void;
}) {
  const { units } = useUnits();

  const style = {
    width: size,
    height: size,
    borderRadius: 2,
    backgroundColor: chart.heatmap[heatLevel(day?.hard_sets ?? 0)],
  };

  // Only days that happened are focusable or labelled — labelling all 366 would
  // bury the panel under tab stops.
  if (!day) {
    return <View testID={`heat-${iso}`} importantForAccessibility="no-hide-descendants" style={style} />;
  }

  return (
    <Pressable
      testID={`heat-${iso}`}
      accessibilityRole="button"
      accessibilityLabel={`${longDate(iso)}: ${day.sessions} session${day.sessions === 1 ? "" : "s"}, ${day.hard_sets} hard sets, ${fmtWeight(day.tonnage_kg, units.weight)}`}
      onHoverIn={() => onHover(day)}
      onHoverOut={() => onHover(null)}
      onPress={() => onHover(day)}
      style={style}
    />
  );
}

function Legend({ cell }: { cell: number }) {
  return (
    <View style={styles.legend}>
      <Text style={panel.axisLabel}>Less</Text>
      {chart.heatmap.map((c) => (
        <View key={c} style={{ width: cell, height: cell, borderRadius: 2, backgroundColor: c }} />
      ))}
      <Text style={panel.axisLabel}>More</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", gap: spacing.xs },
  monthLabel: { position: "absolute", top: 0, width: 40 },
  legend: { flexDirection: "row", alignItems: "center", gap: 3 },
  hoverLine: { minHeight: 16 },
});
