import React from "react";
import { Image, StyleProp, StyleSheet, View, ViewStyle } from "react-native";
import { defaultEquipmentImage } from "../equipmentArt";
import { colors } from "../theme";

type Props = {
  /** The uploaded photo, or null to draw the default illustration instead. */
  uri: string | null;
  name: string;
  equipmentType: string;
  /**
   * The illustration this item is pinned to, or null to let its name and
   * category choose one. Ignored while there is a photo.
   */
  thumbnail?: string | null;
  /** Size and corner radius — the caller owns those; everything else is here. */
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/**
 * An equipment item's picture: its uploaded photo, or — when it has none — the
 * illustration it is pinned to, falling back to one chosen from its name and
 * category.
 *
 * Decorative in every case. Every place this renders sits next to the item's
 * name, so an alt text would only make screen readers say it twice.
 */
export default function EquipmentImage({ uri, name, equipmentType, thumbnail, style, testID }: Props) {
  return (
    <View style={[st.box, style, !uri && st.empty]} testID={testID}>
      {uri ? (
        <Image
          source={{ uri }}
          style={st.fill}
          resizeMode="cover"
          testID={testID && `${testID}-photo`}
        />
      ) : (
        <Image
          source={{ uri: defaultEquipmentImage(name, equipmentType, thumbnail) }}
          style={st.fill}
          resizeMode="contain"
          testID={testID && `${testID}-default`}
        />
      )}
    </View>
  );
}

const st = StyleSheet.create({
  // overflow:hidden is what makes the caller's borderRadius clip the photo,
  // which used to be the Image's own job before it gained a wrapper.
  box: {
    backgroundColor: colors.bg,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  // Only without a photo: a real picture supplies its own edge, a drawing on a
  // bare fill does not.
  empty: { borderWidth: 1, borderColor: colors.border },
  fill: { width: "100%", height: "100%" },
});
