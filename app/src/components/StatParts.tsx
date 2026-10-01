import React from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { Finding, Severity } from "../api";
import * as fmt from "../hudFormat";
import { Polled } from "../polling";
import { chart, colors, radii, spacing, type } from "../theme";
import { settingsStyles } from "./SettingsParts";

/**
 * The readout cards that Stats and Assistant → Activity share.
 *
 * Two pages of the same kind — numbers on cards that wrap across a glass
 * overlay — so they draw one card, one line and one tile. A number that looked
 * different on each would read as two different kinds of number.
 *
 * **Readouts only.** Nothing here is a button. The pages that add their own —
 * Stats' Diagnose, Profile's Revoke — sit inside `GlassOverlay`, whose
 * `reachable(open)` is what keeps a greyed control in a shut layer from staying
 * clickable (the disabled-`Pressable` trap).
 */

export type Note = { text: string; warn?: boolean };

/**
 * One scrolling page of wrapping cards. The `ScrollView` stays the root's
 * direct child: the overlay's body carries `minHeight: 0`, and an extra flex
 * View between without it would stop the page scrolling.
 */
export function StatPage({ testID, children }: { testID: string; children: React.ReactNode }) {
  return (
    <View style={statStyles.root} testID={testID}>
      <ScrollView contentContainerStyle={[statStyles.body, statStyles.cards]}>{children}</ScrollView>
    </View>
  );
}

export function Card({
  testID,
  title,
  right,
  footnote,
  wide = false,
  children,
}: {
  testID: string;
  title: string;
  right?: string;
  footnote?: Note;
  /** The page's full width, rather than wrapping beside another card. */
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <View style={[statStyles.card, statStyles.cardBox, wide && statStyles.cardWide]} testID={testID}>
      <View style={statStyles.cardHead}>
        <Text style={statStyles.sectionLabel}>{title}</Text>
        {right && <Text style={statStyles.cardRight}>{right}</Text>}
      </View>
      {children}
      {footnote && <Text style={[statStyles.note, footnote.warn && statStyles.noteWarn]}>{footnote.text}</Text>}
    </View>
  );
}

/** A label and a value on one line, with a status marker when there is a tone. */
export function Line({
  testID,
  label,
  value,
  tone,
  dim,
  mono,
}: {
  testID?: string;
  label: string;
  value: string;
  tone?: string;
  dim?: boolean;
  mono?: boolean;
}) {
  return (
    <View style={statStyles.lineRow} testID={testID}>
      {tone !== undefined && <View style={[statStyles.marker, { backgroundColor: tone }]} />}
      <Text style={[statStyles.lineLabel, mono && statStyles.mono]} numberOfLines={1}>
        {label}
      </Text>
      <Text style={[statStyles.lineValue, dim && statStyles.dim]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

/** A labelled bar: how much of something is in use. */
export function Meter({
  testID,
  label,
  value,
  percent,
  tone = colors.accent,
}: {
  testID?: string;
  label: string;
  value: string;
  percent: number;
  tone?: string;
}) {
  const width = `${Math.max(0, Math.min(100, percent))}%` as const;

  return (
    <View style={statStyles.meter} testID={testID}>
      <View style={statStyles.lineRow}>
        <Text style={statStyles.lineLabel}>{label}</Text>
        <Text style={statStyles.lineValue}>{value}</Text>
      </View>
      <View style={statStyles.track}>
        <View style={[statStyles.fill, { width, backgroundColor: tone }]} />
      </View>
    </View>
  );
}

export function Tiles({ children }: { children: React.ReactNode }) {
  return <View style={statStyles.tiles}>{children}</View>;
}

/** An uppercase label over a large value — `KpiRow`'s tile, drawn here rather than imported (see `cardBox`). */
export function Tile({ label, value }: { label: string; value: string }) {
  return (
    <View style={statStyles.tile}>
      <Text style={statStyles.tileLabel}>{label}</Text>
      <Text style={statStyles.tileValue} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

/** The colour of each severity. Amber is "look at this"; red is broken. */
export const SEVERITY_TONE = {
  ok: colors.emerald,
  warn: colors.amber,
  problem: colors.error,
} satisfies Record<Severity, string>;

/** Stats' vitals: always four to a row, whatever the width, so the eight make two rows. */
export function VitalTiles({ children }: { children: React.ReactNode }) {
  return <View style={statStyles.vitals}>{children}</View>;
}

/**
 * A reading and its state: a label, a value, and a state word in the state's
 * colour — the word as well as the colour, so the state is never colour alone.
 * `percent` adds a bar under the value (the machine's three live tiles).
 */
export function VitalTile({
  testID,
  label,
  value,
  state,
  tone,
  percent,
  detail,
}: {
  testID: string;
  label: string;
  value: string;
  state: string;
  tone: string;
  percent?: number;
  detail?: string;
}) {
  return (
    <View style={[statStyles.vital, { borderTopColor: tone }]} testID={testID}>
      <View style={statStyles.vitalHead}>
        <Text style={statStyles.tileLabel} numberOfLines={1}>
          {label.toUpperCase()}
        </Text>
        <Text style={[statStyles.vitalState, { color: tone }]} numberOfLines={1}>
          {state}
        </Text>
      </View>
      <Text style={[statStyles.tileValue, value === "—" && statStyles.dim]} numberOfLines={1}>
        {value}
      </Text>
      {percent !== undefined && (
        <View style={statStyles.track}>
          <View style={[statStyles.fill, { width: `${Math.max(0, Math.min(100, percent))}%`, backgroundColor: tone }]} />
        </View>
      )}
      {detail !== undefined && (
        <Text style={statStyles.vitalDetail} numberOfLines={1}>
          {detail}
        </Text>
      )}
    </View>
  );
}

/**
 * One finding that needs attention: ruled on the left in its severity's colour,
 * its title and one sentence, then what to do — a soft fix Troubleshoot may
 * run, or what the owner has to do themselves. The manual step is selectable,
 * because it usually ends in a command to copy.
 */
export function FindingRow({ finding }: { finding: Finding }) {
  return (
    <View style={[statStyles.finding, { borderLeftColor: SEVERITY_TONE[finding.severity] }]} testID={`finding-${finding.key}`}>
      <Text style={statStyles.findingTitle}>{finding.title}</Text>
      <Text style={statStyles.findingDetail}>{finding.detail}</Text>
      {finding.fix && (
        <Text style={[statStyles.findingAction, { color: colors.emerald }]} testID={`finding-${finding.key}-fix`}>
          Soft fix · {finding.fix.label}
        </Text>
      )}
      {finding.manual && (
        <Text selectable style={[statStyles.findingAction, { color: colors.amber }]} testID={`finding-${finding.key}-manual`}>
          Needs you · {finding.manual}
        </Text>
      )}
    </View>
  );
}

/** A subheading and the lines under it, inside a card. */
export function Group({ testID, label, children }: { testID?: string; label: string; children: React.ReactNode }) {
  return (
    <View style={statStyles.group} testID={testID}>
      <Text style={statStyles.groupLabel}>{label}</Text>
      {children}
    </View>
  );
}

/** How long ago an instant was, or "never". */
export function since(iso: string | null): string {
  if (iso === null) return "never";
  const at = Date.parse(iso);
  return Number.isNaN(at) ? "—" : fmt.age((Date.now() - at) / 1000);
}

/** An instant as a date and time on this browser's clock, or "never". */
export function when(iso: string | null): string {
  if (iso === null) return "never";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "—";
  return at.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** The line under a card when its last refresh failed: the old numbers stay. */
export function errorNote(polled: Polled<unknown>): Note | undefined {
  if (!polled.error) return undefined;
  return polled.data
    ? { text: "Couldn't refresh — showing the last reading.", warn: true }
    : { text: polled.error, warn: true };
}

export const statStyles = {
  // Settings' page and card look, so these read as the same kind of page.
  ...settingsStyles,
  ...StyleSheet.create({
    // `settingsStyles.body` caps the page at 720px, which suits one column of
    // radio cards; here the cards wrap across the overlay's full width, or half
    // of a wide window would stay empty (the bug `FitnessSettings` fixed).
    cards: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "flex-start",
      maxWidth: "100%",
      columnGap: spacing.lg,
      rowGap: spacing.lg,
    },

    // Knowingly the same geometry as `fitness/panelStyles`' `card`. That module
    // is scoped to its folder on purpose — unifying the two is a cross-screen
    // refactor with visual risk — so this does not import across the boundary.
    // `flexShrink: 1` because React Native defaults it to 0, and a card would
    // otherwise refuse to go under its basis and clip on a narrow window.
    cardBox: {
      flexBasis: 340,
      flexGrow: 1,
      flexShrink: 1,
      minWidth: 0,
      padding: spacing.lg,
      gap: spacing.md,
    },
    cardWide: { flexBasis: "100%" },
    cardHead: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: spacing.sm },
    cardRight: { ...type.caption, color: colors.textDim },

    group: { gap: spacing.xs },
    groupLabel: { ...type.caption, color: colors.textMuted, fontWeight: "600" },

    lineRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
    marker: { width: 6, height: 6, borderRadius: 3 },
    lineLabel: { ...type.small, color: colors.text, flex: 1, minWidth: 0 },
    lineValue: { ...type.readout, color: colors.textMuted, flexShrink: 1 },
    mono: { ...type.readout, fontWeight: "400" },
    dim: { color: colors.textDim },

    meter: { gap: 6 },
    track: { height: 6, backgroundColor: chart.track, borderRadius: 3, overflow: "hidden" },
    fill: { height: "100%", borderRadius: 3 },

    tiles: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
    tile: {
      flexBasis: 90,
      flexGrow: 1,
      minWidth: 0,
      backgroundColor: colors.bg,
      borderRadius: radii.md,
      padding: spacing.sm,
    },
    tileLabel: { ...type.micro, color: colors.textMuted, letterSpacing: 0.8 },
    tileValue: { ...type.readout, fontSize: 20, lineHeight: 26, color: colors.text, marginTop: 2 },

    // `22%` plus the gap is four to a row at every width — a phone included,
    // where each value is still one short number.
    vitals: { flexDirection: "row", flexWrap: "wrap", columnGap: spacing.sm, rowGap: spacing.sm },
    vital: {
      flexBasis: "22%",
      flexGrow: 1,
      minWidth: 0,
      gap: 4,
      backgroundColor: colors.bg,
      borderRadius: radii.md,
      borderTopWidth: 2,
      padding: spacing.sm,
    },
    vitalHead: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: spacing.xs },
    vitalState: { ...type.micro, flexShrink: 1 },
    vitalDetail: { ...type.caption, color: colors.textDim },

    finding: { borderLeftWidth: 3, paddingLeft: spacing.md, gap: 2 },
    findingTitle: { ...type.small, color: colors.text, fontWeight: "600" },
    findingDetail: { ...type.small, color: colors.textMuted },
    findingAction: { ...type.caption, marginTop: 2 },

    note: { ...type.caption, color: colors.textDim, fontStyle: "italic" },
    noteWarn: { color: colors.amber, fontStyle: "normal" },
  }),
};
