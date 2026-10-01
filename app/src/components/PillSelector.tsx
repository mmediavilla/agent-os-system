import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors, radii, spacing } from "../theme";

/** Which accent an active pill takes. Fitness is the app's emerald category. */
type Tone = "accent" | "emerald";

export default function PillSelector<T extends string>({
  options,
  value,
  onChange,
  tone = "accent",
}: {
  options: readonly T[] | { value: T; label: string }[];
  /**
   * The currently selected option, compared by value. Typed as `string` rather
   * than `T` because it legitimately holds non-options: `""` when nothing is
   * selected, or a value the server returned that is no longer in `options`.
   * `onChange` stays narrowed to `T`, so only valid options can be picked.
   */
  value: string;
  onChange: (v: T) => void;
  tone?: Tone;
}) {
  const items = options.map((o) =>
    typeof o === "string" ? { value: o as T, label: o } : o
  );
  const activeStyle = tone === "emerald" ? pill.chipEmerald : pill.chipActive;
  const activeLabel = tone === "emerald" ? pill.labelEmerald : pill.labelActive;

  return (
    <View style={pill.row}>
      {items.map((item) => {
        const active = value === item.value;
        return (
          <Pressable
            key={item.value}
            onPress={() => onChange(item.value)}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            aria-selected={active}
            style={[pill.chip, active && activeStyle]}
          >
            <Text style={[pill.label, active && activeLabel]}>{item.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const pill = StyleSheet.create({
  row: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs },
  chip: {
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.xs,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
  },
  chipActive: {
    backgroundColor: colors.accentBg,
    borderColor: colors.accentBd,
  },
  chipEmerald: {
    backgroundColor: colors.emeraldBg,
    borderColor: colors.emerald,
  },
  label: { fontSize: 13, color: colors.textMuted, fontWeight: "500" },
  labelActive: { color: colors.accentTxt },
  labelEmerald: { color: colors.emeraldTxt },
});
