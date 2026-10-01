import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors, radii, spacing, type } from "../theme";
import DateTimeInput from "./DateTimeInput";

/**
 * What the two Records tabs share: a labelled date, a small text button, the
 * form's styles and today's date. Documents and Deadlines are two pages of the
 * same kind — cards of drafts committed on blur — so a date field that looked
 * different on each would read as two different kinds of date.
 */

/** Today on this browser's clock, as the bare date the server stores. */
export function localToday(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** The only date a field may commit — what the picker hands back, and what the server stores. */
export const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

export const DATE_HINT = "Use a date like 2027-03-14.";

/** Capitalised for a picker; the stored value stays as typed. */
export function kindLabel(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** The vocabulary, plus whatever the row already holds — `kind` is free text. */
export function kindOptions(vocabulary: readonly string[], current: string) {
  const values: string[] = [...vocabulary];
  if (current !== "" && !values.includes(current)) values.push(current);
  return values.map((value) => ({ value, label: kindLabel(value) }));
}

/** In a new tab, through the signed URL — the one way the browser can fetch a filed document. */
export function openFile(url: string) {
  window.open?.(url, "_blank", "noopener");
}

/** A labelled date, on the browser's own picker. */
export function DateField({
  label,
  value,
  onChange,
  onCommit,
  editable,
  accessibilityLabel,
  testID,
}: {
  label: string;
  value: string;
  onChange: (text: string) => void;
  onCommit?: () => void;
  editable: boolean;
  accessibilityLabel: string;
  testID: string;
}) {
  return (
    <View style={recordStyles.dateField}>
      <Text style={recordStyles.dateLabel}>{label}</Text>
      <DateTimeInput
        kind="date"
        value={value}
        onChangeText={onChange}
        onBlur={onCommit}
        onSubmitEditing={onCommit}
        editable={editable}
        accessibilityLabel={accessibilityLabel}
        style={[recordStyles.input, recordStyles.dateInput]}
        testID={testID}
      />
    </View>
  );
}

export function SmallButton({
  label,
  onPress,
  disabled,
  tone = colors.accentTxt,
  testID,
  accessibilityLabel,
}: {
  label: string;
  onPress: () => void;
  disabled: boolean;
  tone?: string;
  testID: string;
  accessibilityLabel: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      style={({ hovered }: any) => [
        recordStyles.small,
        hovered && !disabled && recordStyles.smallHovered,
        disabled && recordStyles.disabled,
      ]}
      testID={testID}
    >
      <Text style={[recordStyles.smallText, { color: tone }]}>{label}</Text>
    </Pressable>
  );
}

export const recordStyles = StyleSheet.create({
  empty: { ...type.small, color: colors.textDim },

  fields: { flexDirection: "row", alignItems: "flex-end", gap: spacing.sm, flexWrap: "wrap" },
  input: {
    fontSize: 13,
    color: colors.text,
    backgroundColor: colors.bg,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  grow: { flex: 1, minWidth: 160 },
  kind: { width: 150 },
  notes: { minHeight: 48, textAlignVertical: "top" },

  dateField: { gap: 2, flexGrow: 1, flexBasis: 140 },
  dateLabel: { ...type.caption, color: colors.textMuted },
  // Wide enough for the browser's date control and its calendar indicator.
  dateInput: { minWidth: 140, fontVariant: ["tabular-nums"] },

  actions: { flexDirection: "row", gap: spacing.xs, flexWrap: "wrap" },
  small: { paddingHorizontal: spacing.sm, paddingVertical: 4, borderRadius: radii.sm, alignSelf: "flex-start" },
  smallHovered: { backgroundColor: colors.bg },
  smallText: { fontSize: 12, fontWeight: "600" },
  disabled: { opacity: 0.45 },
});
