import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Dropdown from "./Dropdown";
import { colors, radii, spacing } from "../theme";

/** One dropdown in the bar. An empty `value` means the filter is not applied. */
export type FilterSpec = {
  /** Stable key for the row; also the default testID suffix. */
  key: string;
  /** Field label above the control. */
  label: string;
  /** Trigger text while nothing is selected — phrase it as the unfiltered set. */
  placeholder: string;
  options: readonly string[] | { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
  /** Passed straight to the Dropdown — see `renderIcon` there. */
  renderIcon?: (value: string, size: number) => React.ReactNode;
};

/**
 * Row of exact-match filters above a list.
 *
 * Dropdowns rather than pills, for the reason given in Dropdown itself: these
 * sit above the content the user came to read, and a pill row per field would
 * push the first row of the list off the screen. Each one clears itself through
 * the sheet's own leading entry, and the Clear button resets the whole bar in
 * one press once anything is set.
 */
export default function FilterBar({
  filters,
  onClear,
}: {
  filters: FilterSpec[];
  /** Called by the Clear button. Reset every filter, and go back to page one. */
  onClear: () => void;
}) {
  const active = filters.filter((f) => f.value !== "");

  return (
    <View style={f.root}>
      <View style={f.fields}>
        {filters.map((filter) => (
          <View key={filter.key} style={f.field}>
            <Text style={f.label}>{filter.label}</Text>
            <Dropdown
              options={filter.options}
              value={filter.value}
              onChange={(v) => filter.onChange(v)}
              placeholder={filter.placeholder}
              title={filter.label}
              // The trigger is labelled with its own value, which the list
              // below also renders as a chip — text alone cannot pick it out.
              testID={`filter-${filter.key}`}
              clearLabel={filter.placeholder}
              renderIcon={filter.renderIcon}
            />
          </View>
        ))}
      </View>

      {active.length > 0 && (
        <Pressable
          onPress={onClear}
          accessibilityRole="button"
          style={({ hovered }: any) => [f.clearBtn, hovered && f.clearBtnHovered]}
        >
          <Text style={f.clearTxt}>
            Clear {active.length === 1 ? "filter" : `${active.length} filters`}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

const f = StyleSheet.create({
  root: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderColor: colors.border,
    gap: spacing.sm,
  },
  // Wraps to as many rows as the viewport needs, so a phone gets one field per
  // line instead of three unreadably narrow triggers.
  fields: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  // `flexBasis` keeps a field from collapsing below a readable width while
  // still letting three sit side by side on a desktop.
  field: { flexGrow: 1, flexShrink: 1, flexBasis: 180, minWidth: 0, gap: spacing.xs },
  label: {
    fontSize: 11,
    fontWeight: "600",
    color: colors.textDim,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  clearBtn: {
    alignSelf: "flex-start",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
  },
  clearBtnHovered: { borderColor: colors.borderHi },
  clearTxt: { fontSize: 13, fontWeight: "600", color: colors.textMuted },
});
