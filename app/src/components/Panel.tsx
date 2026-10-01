import React from "react";
import { StyleProp, StyleSheet, Text, View, ViewStyle } from "react-native";
import { colors, hud, radii, spacing, type } from "../theme";

/**
 * A titled box.
 *
 * Every screen in this app already draws one — `styles.card` on what was the
 * Dashboard, `styles.panel` on Fitness, the section boxes on Workouts — each
 * with its own padding, its own idea of how big an eyebrow is, and its own
 * header row. The HUD would have made a fourth, and a HUD is *made of* these:
 * six of them on one screen, side by side, where a 2px difference in header
 * height between two neighbours is the thing you see instead of the data.
 *
 * So the header is the component's decision and the body is the caller's. A
 * panel takes an `eyebrow` (the all-caps role), a `title`, and a `right` slot
 * for the one control or readout that belongs beside the title — a status pill,
 * a unit, a refresh time — and nothing else. Anything more elaborate is a
 * screen composing panels, not a panel growing options.
 *
 * It reads `colors.*` like everything else, which is what makes it re-theme
 * inside a `data-hud` subtree with no HUD-specific code: same component, same
 * tokens, different values arriving through the cascade.
 *
 * `corners` is the one exception — the instrument brackets, drawn from
 * `--h-bracket`, which only has a value inside the HUD. It is off by default
 * for that reason.
 */
export default function Panel({
  eyebrow,
  title,
  right,
  footer,
  corners = false,
  children,
  style,
  bodyStyle,
  testID,
}: {
  eyebrow?: string;
  title?: string;
  right?: React.ReactNode;
  footer?: React.ReactNode;
  corners?: boolean;
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  bodyStyle?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const hasHeader = !!(eyebrow || title || right);

  return (
    <View style={[s.panel, style]} testID={testID}>
      {corners && <Corners />}

      {hasHeader && (
        <View style={s.header}>
          <View style={s.headerText}>
            {!!eyebrow && <Text style={s.eyebrow}>{eyebrow}</Text>}
            {/* `header` rather than a plain Text: a screen of eight panels is
                unnavigable by screen reader without landmarks in it. */}
            {!!title && (
              <Text style={s.title} accessibilityRole="header">
                {title}
              </Text>
            )}
          </View>
          {!!right && <View style={s.right}>{right}</View>}
        </View>
      )}

      <View style={[s.body, hasHeader && s.bodySpaced, bodyStyle]}>{children}</View>

      {!!footer && <View style={s.footer}>{footer}</View>}
    </View>
  );
}

/**
 * Four corner ticks — two short rules meeting at each corner, inset from the
 * radius so they read as brackets around the panel rather than as a second
 * border that failed to close.
 */
function Corners() {
  return (
    <View style={s.corners} testID="panel-corners">
      <View style={[s.corner, s.cornerTL]} />
      <View style={[s.corner, s.cornerTR]} />
      <View style={[s.corner, s.cornerBL]} />
      <View style={[s.corner, s.cornerBR]} />
    </View>
  );
}

const CORNER = 12;

const s = StyleSheet.create({
  panel: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.lg,
    padding: spacing.lg,
    // Without this a corner tick paints over the rounded edge it is bracketing.
    overflow: "hidden",
  },

  header: { flexDirection: "row", alignItems: "flex-start", gap: spacing.sm },
  headerText: { flex: 1, gap: 2 },
  right: { flexShrink: 0 },
  eyebrow: { ...type.label, color: colors.textMuted },
  title: { ...type.heading, color: colors.text },

  body: { gap: spacing.sm },
  bodySpaced: { marginTop: spacing.md },

  footer: {
    marginTop: spacing.md,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },

  corners: { ...StyleSheet.absoluteFillObject, pointerEvents: "none" },
  corner: {
    position: "absolute",
    width: CORNER,
    height: CORNER,
    borderColor: hud.bracket,
  },
  cornerTL: { top: 5, left: 5, borderTopWidth: 1, borderLeftWidth: 1 },
  cornerTR: { top: 5, right: 5, borderTopWidth: 1, borderRightWidth: 1 },
  cornerBL: { bottom: 5, left: 5, borderBottomWidth: 1, borderLeftWidth: 1 },
  cornerBR: { bottom: 5, right: 5, borderBottomWidth: 1, borderRightWidth: 1 },
});
