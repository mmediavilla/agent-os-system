import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { colors, radii, spacing } from "../theme";

export default function ErrorBanner({ text }: { text: string }) {
  return (
    <View style={styles.errBox}><Text style={styles.errText}>{text}</Text></View>
  );
}

const styles = StyleSheet.create({
  errBox: {
    backgroundColor: colors.errorBgAlt,
    borderColor: colors.errorBdAlt,
    borderWidth: 1,
    borderRadius: radii.md,
    padding: spacing.md,
  },
  errText: { color: colors.errorTxt, fontSize: 13 },
});
