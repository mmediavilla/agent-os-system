import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors, radii, spacing } from "../theme";

/**
 * What the two settings views share: the radio card, and the look of a section.
 *
 * Settings (the HUD's overlay) and Fitness → Settings are the same kind of page
 * in two places, so they draw one control. A choice that looked different in
 * each would read as two different kinds of setting.
 */

/**
 * One card of mutually exclusive options.
 *
 * Generic over the option type so the theme colour, each unit dimension and the
 * default range share it: they are the same control over and over, and all that
 * differs is where the labels come from.
 */
export function RadioGroup<T extends string>({
  groupLabel,
  options,
  selected,
  labelFor,
  descriptionFor,
  leadingFor,
  onSelect,
}: {
  groupLabel: string;
  options: readonly T[];
  selected: T;
  labelFor: (option: T) => string;
  descriptionFor: (option: T) => string;
  /** Something drawn before the label — the theme colour's chip. Decorative. */
  leadingFor?: (option: T) => React.ReactNode;
  onSelect: (option: T) => void;
}) {
  return (
    <View style={settingsStyles.card} accessibilityRole="radiogroup" accessibilityLabel={groupLabel}>
      {options.map((option, i) => {
        const isSelected = selected === option;
        return (
          <Pressable
            key={option}
            onPress={() => onSelect(option)}
            accessibilityRole="radio"
            accessibilityState={{ selected: isSelected, checked: isSelected }}
            aria-checked={isSelected}
            style={({ hovered }: any) => [
              settingsStyles.option,
              i > 0 && settingsStyles.optionDivided,
              hovered && settingsStyles.optionHovered,
            ]}
          >
            {leadingFor?.(option)}

            <View style={settingsStyles.optionText}>
              <Text style={[settingsStyles.optionLabel, isSelected && settingsStyles.optionLabelSelected]}>
                {labelFor(option)}
              </Text>
              <Text style={settingsStyles.optionDesc}>{descriptionFor(option)}</Text>
            </View>

            {/* Decorative — selection is announced via accessibilityState. */}
            <View
              style={[settingsStyles.radio, isSelected && settingsStyles.radioSelected]}
              accessibilityElementsHidden
              importantForAccessibility="no"
            >
              {isSelected && <View style={settingsStyles.radioDot} />}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

export const settingsStyles = StyleSheet.create({
  // No ground: both views sit on glass, and a fill here would paint the HUD
  // behind it back out.
  root: { flex: 1 },

  // Capped but left-aligned, so the cards line up under the overlay's header
  // rather than floating in the middle of a wide window.
  body: {
    padding: spacing.lg,
    gap: spacing.xl,
    maxWidth: 720,
    width: "100%",
  },

  section: { gap: spacing.sm },
  sectionLabel: {
    fontSize: 12,
    fontWeight: "700",
    color: colors.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },

  // A group inside a section. Sentence case, so it reads as a subheading rather
  // than competing with the uppercase section label above.
  group: { gap: spacing.xs },
  groupLabel: { fontSize: 13, fontWeight: "600", color: colors.text },

  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.lg,
    overflow: "hidden",
  },

  option: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  // A border on the option rather than a separate rule, so the first row sits
  // flush against the card's rounded top edge.
  optionDivided: { borderTopWidth: 1, borderTopColor: colors.border },
  optionHovered: { backgroundColor: colors.bg },
  optionText: { flex: 1, gap: 2 },
  optionLabel: { fontSize: 15, fontWeight: "500", color: colors.text },
  optionLabelSelected: { color: colors.accentTxt, fontWeight: "600" },
  optionDesc: { fontSize: 13, color: colors.textMuted },

  radio: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: colors.borderHi,
    alignItems: "center",
    justifyContent: "center",
  },
  radioSelected: { borderColor: colors.accent },
  radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.accent },

  footnote: { fontSize: 12, color: colors.textDim, fontStyle: "italic" },
});
