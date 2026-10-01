import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { PageMeta } from "../api";
import { colors, radii, spacing } from "../theme";

/**
 * Page size offered by the catalog screens.
 *
 * One fixed size rather than a picker: the lists group their rows under
 * headings, and letting the user resize the page only changes where those
 * groups get cut. Twenty-five fills a desktop viewport without the row count
 * ever making the screen feel like a table dump.
 */
export const PAGE_SIZE = 25;

/**
 * Footer for a paginated list: what this page covers, and the way to the next.
 *
 * Renders nothing at all while there is only one page. A list that fits on one
 * screen has nothing to navigate, and a permanently disabled Prev/Next pair
 * reads as broken rather than as "you have seen everything".
 */
export default function Pagination({
  meta,
  onChange,
  disabled = false,
  /** Plural noun for the count line — "exercises", "equipment". */
  noun,
}: {
  meta: PageMeta;
  onChange: (page: number) => void;
  disabled?: boolean;
  noun: string;
}) {
  if (meta.last_page <= 1) return null;

  const first = meta.page <= 1;
  const last = meta.page >= meta.last_page;

  return (
    <View style={p.root}>
      <Text style={p.range}>
        {meta.from}–{meta.to} of {meta.total} {noun}
      </Text>

      <View style={p.controls}>
        <PageBtn
          label="‹ Prev"
          // Named for a screen reader, which has no chevron to read.
          a11yLabel="Previous page"
          onPress={() => onChange(meta.page - 1)}
          disabled={disabled || first}
        />
        <Text style={p.pageTxt}>
          Page {meta.page} of {meta.last_page}
        </Text>
        <PageBtn
          label="Next ›"
          a11yLabel="Next page"
          onPress={() => onChange(meta.page + 1)}
          disabled={disabled || last}
        />
      </View>
    </View>
  );
}

function PageBtn({
  label,
  a11yLabel,
  onPress,
  disabled,
}: {
  label: string;
  a11yLabel: string;
  onPress: () => void;
  disabled: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={a11yLabel}
      accessibilityState={{ disabled }}
      style={({ hovered }: any) => [
        p.btn,
        hovered && !disabled && p.btnHovered,
        disabled && p.btnDisabled,
      ]}
    >
      <Text style={[p.btnTxt, disabled && p.btnTxtDisabled]}>{label}</Text>
    </Pressable>
  );
}

const p = StyleSheet.create({
  root: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    // Wraps on a narrow viewport rather than squeezing the range line into a
    // column one word wide.
    flexWrap: "wrap",
    gap: spacing.md,
    marginTop: spacing.lg,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderColor: colors.border,
  },
  range: { fontSize: 13, color: colors.textMuted },
  controls: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  pageTxt: { fontSize: 13, color: colors.textMuted, minWidth: 96, textAlign: "center" },
  btn: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  btnHovered: { borderColor: colors.borderHi, backgroundColor: colors.bg },
  btnDisabled: { opacity: 0.45 },
  btnTxt: { fontSize: 14, fontWeight: "600", color: colors.accentTxt },
  btnTxtDisabled: { color: colors.textDim },
});
