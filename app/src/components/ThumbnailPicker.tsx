import React from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import {
  EQUIPMENT_ARTS,
  EQUIPMENT_ART_LABELS,
  EquipmentArt,
  defaultEquipmentImage,
  equipmentArtImage,
  isEquipmentArt,
} from "../equipmentArt";
import { colors, radii, spacing } from "../theme";

type Props = {
  /** The pinned illustration, or null for "whichever the name and category imply". */
  value: string | null;
  onChange: (v: EquipmentArt | null) => void;
  /** What the Automatic tile previews — the item as it is being typed. */
  name: string;
  equipmentType: string;
  disabled?: boolean;
};

/**
 * Picks which drawing an item shows while it has no photo.
 *
 * "Automatic" is first and is the default, because the derived pick is right
 * for most of the catalog — the picker exists for the rows it is wrong for
 * ("Landmine" is not a gym bag). It previews the drawing the item would get,
 * so choosing it is not a leap of faith, and it stays a *choice of nothing*:
 * selecting it stores null, which keeps following the name as it is edited.
 *
 * The tiles are not disabled while a photo is staged. The thumbnail outlives
 * the photo — removing one later should not mean coming back to set this — and
 * the sheet says as much rather than greying the field out.
 */
export default function ThumbnailPicker({ value, onChange, name, equipmentType, disabled }: Props) {
  // Null, "" and a key this build cannot draw all mean the same thing, and all
  // three land on Automatic — which is what EquipmentImage draws for them too,
  // so the highlighted tile always matches the picture above it.
  const pinned = isEquipmentArt(value) ? value : null;

  const options: { key: string; label: string; uri: string; art: EquipmentArt | null }[] = [
    {
      key: "auto",
      label: "Automatic",
      uri: defaultEquipmentImage(name, equipmentType),
      art: null,
    },
    ...EQUIPMENT_ARTS.map((art) => ({
      key: art,
      label: EQUIPMENT_ART_LABELS[art],
      uri: equipmentArtImage(art),
      art,
    })),
  ];

  return (
    <View style={th.grid}>
      {options.map((option) => {
        const selected = pinned === option.art;
        return (
          <Pressable
            key={option.key}
            onPress={() => onChange(option.art)}
            disabled={disabled}
            accessibilityRole="button"
            // The visible label alone is ambiguous inside the sheet — "Machine"
            // and "Cable" are also Type pills — so the spoken name says which
            // question this answers.
            accessibilityLabel={`${option.label} thumbnail`}
            accessibilityState={{ selected, disabled: Boolean(disabled) }}
            aria-selected={selected}
            testID={`thumbnail-tile-${option.key}`}

            style={({ hovered }: any) => [
              th.tile,
              hovered && !disabled && th.tileHovered,
              selected && th.tileSelected,
            ]}
          >
            <Image
              source={{ uri: option.uri }}
              style={th.art}
              resizeMode="contain"
              testID={`thumbnail-option-${option.key}`}
            />
            <Text style={[th.label, selected && th.labelSelected]} numberOfLines={1}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const th = StyleSheet.create({
  grid: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs },
  // Fixed width so the labels line up in a grid rather than a ragged row of
  // pills; 76 is the widest label ("Kettlebell") at this font size plus padding.
  tile: {
    width: 76,
    alignItems: "center",
    gap: 2,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.xs,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: colors.bg,
  },
  tileHovered: { borderColor: colors.borderHi },
  tileSelected: { backgroundColor: colors.accentBg, borderColor: colors.accentBd },
  art: { width: 40, height: 40 },
  label: { fontSize: 11, color: colors.textMuted, textAlign: "center" },
  labelSelected: { color: colors.accentTxt, fontWeight: "600" },
});
