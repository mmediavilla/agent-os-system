import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors, radii, spacing } from "../theme";

/**
 * Equal-width segmented control for switching between sub-pages of a screen.
 *
 * Selection only — it does not render the panels. Callers keep every panel
 * mounted and hide the inactive ones (see Workouts.tsx), so switching tabs
 * never wipes in-progress form state.
 */
export default function TabBar<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly { value: T; label: string }[];
  /**
   * The selected tab, compared by value. Typed as `string` rather than `T` for
   * the same reason as PillSelector in Exercises.tsx: it may legitimately hold
   * a value that is not (or is no longer) in `options`. `onChange` stays
   * narrowed to `T`, so only valid tabs can be picked.
   */
  value: string;
  onChange: (v: T) => void;
}) {
  return (
    <View style={styles.row} accessibilityRole="tablist" role="tablist">
      {options.map((opt) => {
        const active = value === opt.value;
        return (
          <Pressable
            key={opt.value}
            onPress={() => onChange(opt.value)}
            // Both spellings: RN Web 0.21 reads aria-*, older native reads
            // accessibilityRole/State. Same convention as the sidebar in App.tsx.
            accessibilityRole="tab"
            role="tab"
            accessibilityState={{ selected: active }}
            aria-selected={active}
            style={({ hovered }: any) => [
              styles.tab,
              active && styles.tabActive,
              !active && hovered && styles.tabHovered,
            ]}
          >
            <Text style={[styles.label, active && styles.labelActive]}>{opt.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", gap: spacing.xs },
  tab: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: spacing.sm,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 44,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
  },
  tabActive:  { backgroundColor: colors.accentBg, borderColor: colors.accentBd },
  tabHovered: { backgroundColor: colors.bg },
  label:       { color: colors.textMuted, fontSize: 13, fontWeight: "600", textAlign: "center" },
  labelActive: { color: colors.accentTxt },
});
