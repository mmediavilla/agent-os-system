import React, { useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { colors, radii, spacing } from "../theme";

/**
 * Single-select field that opens its options in a sheet.
 *
 * The sibling of PillSelector, for the same job at a different scale: pills
 * stay right for closed sets of a handful (primary muscle, exercise type),
 * while this takes over once the options are a catalog the user grows —
 * equipment went from ten built-ins to thirty-odd rows, at which point the pill
 * row wrapped to four lines and buried the fields under it.
 *
 * Rendered in a Modal rather than an absolutely-positioned menu because the
 * form it sits in is itself a scrolling modal: an in-flow menu would clip at
 * the ScrollView's edge and scroll away from its trigger.
 */
/**
 * How big a caller's icons are drawn. The sheet gets the larger one because it
 * is where the user is comparing options; the trigger only has to confirm
 * which one they left it on, and shares its line with a label and a chevron.
 */
const OPTION_ICON = 32;
const TRIGGER_ICON = 24;

export default function Dropdown<T extends string>({
  options,
  value,
  onChange,
  placeholder = "Select…",
  clearLabel,
  title,
  testID,
  renderIcon,
}: {
  options: readonly T[] | { value: T; label: string }[];
  /**
   * The current selection, compared by value. Typed as `string` rather than `T`
   * for the same reason as PillSelector: it legitimately holds `""` when
   * nothing is chosen, or a value the server returned that is no longer among
   * the options.
   */
  value: string;
  /** Receives `""` when the clear entry is picked, so the field can be emptied. */
  onChange: (v: T | "") => void;
  placeholder?: string;
  /** Adds a leading entry that clears the selection. Omit for required fields. */
  clearLabel?: string;
  /** Heading shown above the options. Defaults to the placeholder. */
  title?: string;
  /**
   * Lands on the trigger. Worth setting where the same names appear elsewhere
   * on screen — the trigger is labelled with its value, so on a list that also
   * tags rows with that value, text alone cannot pick it out.
   */
  testID?: string;
  /**
   * Draws a picture ahead of an option's label, and ahead of the trigger's
   * current selection. Handed the size to draw at, because the sheet and the
   * trigger want different ones and only this component knows which is asking.
   *
   * Supplying it reserves the slot on *every* option row — the clear entry
   * included, which gets an empty one — so the labels stay in a column even
   * where the caller has nothing to draw for a particular value. Return null
   * there rather than a stand-in glyph.
   */
  renderIcon?: (value: T, size: number) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  const items = options.map((o) =>
    typeof o === "string" ? { value: o as T, label: o } : o
  );
  // A selection missing from `options` still shows its own name rather than the
  // placeholder — the caller is expected to append it (see Exercises), but a
  // stale value must never look like an empty field.
  const selectedLabel = items.find((i) => i.value === value)?.label ?? value;

  const choose = (v: T | "") => {
    setOpen(false);
    onChange(v);
  };

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        testID={testID}
        accessibilityRole="button"
        // Named explicitly so the chevron glyph stays out of the spoken label.
        accessibilityLabel={value ? selectedLabel : placeholder}
        accessibilityState={{ expanded: open }}
        style={({ hovered }: any) => [drop.trigger, hovered && drop.triggerHovered]}
      >
        {/* Only once something is chosen — an icon next to the placeholder
            would be a picture of nothing. The trigger is one line and holds no
            space for it, so the slot appears and disappears with the value. */}
        {renderIcon && value !== "" && (
          <View style={drop.triggerIcon}>{renderIcon(value as T, TRIGGER_ICON)}</View>
        )}
        <Text style={[drop.triggerTxt, !value && drop.placeholder]} numberOfLines={1}>
          {value ? selectedLabel : placeholder}
        </Text>
        <Text style={drop.chevron}>▾</Text>
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        {/* The backdrop is the dismiss target, so tapping outside closes the
            sheet the way a native picker does. */}
        <Pressable style={drop.overlay} onPress={() => setOpen(false)}>
          {/* Swallows presses that land on the sheet itself, which would
              otherwise bubble to the backdrop and close it mid-scroll. */}
          <Pressable style={drop.sheet} onPress={() => {}}>
            <Text style={drop.sheetTitle}>{title ?? placeholder}</Text>

            <ScrollView style={drop.list} contentContainerStyle={drop.listBody}>
              {clearLabel && (
                <Pressable
                  onPress={() => choose("")}
                  accessibilityRole="button"
                  accessibilityLabel={clearLabel}
                  accessibilityState={{ selected: value === "" }}
                  aria-selected={value === ""}
                  style={({ hovered }: any) => [drop.opt, hovered && drop.optHovered]}
                >
                  {renderIcon && <View style={drop.optIcon} />}
                  <Text style={[drop.optTxt, drop.clearTxt]}>{clearLabel}</Text>
                  {value === "" && <Text style={drop.check}>✓</Text>}
                </Pressable>
              )}

              {items.map((item) => {
                const active = value === item.value;
                return (
                  <Pressable
                    key={item.value}
                    onPress={() => choose(item.value)}
                    accessibilityRole="button"
                    accessibilityLabel={item.label}
                    accessibilityState={{ selected: active }}
                    aria-selected={active}
                    style={({ hovered }: any) => [
                      drop.opt,
                      hovered && drop.optHovered,
                      active && drop.optActive,
                    ]}
                  >
                    {renderIcon && (
                      <View style={drop.optIcon}>{renderIcon(item.value, OPTION_ICON)}</View>
                    )}
                    <Text style={[drop.optTxt, active && drop.optTxtActive]}>{item.label}</Text>
                    {active && <Text style={drop.check}>✓</Text>}
                  </Pressable>
                );
              })}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const drop = StyleSheet.create({
  trigger: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    // `surface`, not `bg`, to match the TextInputs it sits between; a `bg`
    // trigger reads as recessed next to its sibling fields.
    backgroundColor: colors.surface,
  },
  triggerHovered: { borderColor: colors.borderHi },
  // Fixed rather than intrinsic, so a photo that arrives late cannot reflow the
  // label it sits beside.
  triggerIcon: { width: TRIGGER_ICON, height: TRIGGER_ICON },
  triggerTxt: { flex: 1, fontSize: 15, color: colors.text },
  placeholder: { color: colors.textDim },
  chevron: { fontSize: 12, color: colors.textMuted },

  overlay: {
    flex: 1,
    backgroundColor: "rgba(15, 23, 42, 0.5)",
    justifyContent: "center",
    alignItems: "center",
    padding: spacing["2xl"],
  },
  sheet: {
    width: "100%",
    maxWidth: 360,
    maxHeight: "70%",
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.sm,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 16,
    elevation: 8,
  },
  sheetTitle: {
    fontSize: 12,
    fontWeight: "600",
    color: colors.textDim,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs,
  },
  list: { flexGrow: 0 },
  listBody: { paddingVertical: spacing.xs },
  opt: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  // Held on every row once icons are in play, empty ones included, so the
  // labels line up whether or not the caller had something to draw.
  optIcon: { width: OPTION_ICON, height: OPTION_ICON },
  optHovered: { backgroundColor: colors.bg },
  optActive: { backgroundColor: colors.accentBg },
  // Takes the slack so the check stays pinned right and a long label wraps
  // rather than shouldering it off the row.
  optTxt: { flex: 1, fontSize: 15, color: colors.text },
  optTxtActive: { color: colors.accentTxt, fontWeight: "600" },
  clearTxt: { color: colors.textMuted, fontStyle: "italic" },
  check: { fontSize: 14, color: colors.accentTxt, fontWeight: "700" },
});
