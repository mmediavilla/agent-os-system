import { StyleSheet } from "react-native";
import { colors, radii, spacing } from "../../theme";

/**
 * Shared chrome for the dashboard panels.
 *
 * Scoped to this folder on purpose: the `card` block is duplicated across four
 * screens, and unifying that is a cross-screen refactor with visual risk that
 * does not belong in a feature change.
 */
export const panel = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.lg,
    padding: spacing.lg,
    gap: spacing.md,
    flexBasis: 380,
    flexGrow: 1,
    // React Native defaults flexShrink to 0, unlike the web. Without this a
    // panel refuses to go below its 380 basis and overflows the card on a
    // narrow viewport, clipping the values off the right edge.
    flexShrink: 1,
    minWidth: 0,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
    gap: spacing.sm,
  },
  title: { fontSize: 16, fontWeight: "700", color: colors.text },
  caption: { color: colors.textMuted, fontSize: 12 },
  footnote: { color: colors.textDim, fontSize: 11, fontStyle: "italic" },
  /** Holds the panel's final height so nothing jumps when data lands. */
  state: { alignItems: "center", justifyContent: "center" },
  empty: { color: colors.textMuted, fontSize: 13, textAlign: "center", lineHeight: 19 },
  axisLabel: { color: colors.textDim, fontSize: 9 },
});
