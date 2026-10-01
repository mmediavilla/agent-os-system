import React from "react";
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { colors, radii, spacing } from "../theme";

type Props = {
  visible: boolean;
  title: string;
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
  confirmLabel?: string;
  destructive?: boolean;
  loading?: boolean;
};

export default function ConfirmDialog({
  visible,
  title,
  message,
  onConfirm,
  onCancel,
  confirmLabel = "Delete",
  destructive = true,
  loading = false,
}: Props) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={loading ? undefined : onCancel}
    >
      <View style={styles.overlay}>
        <View style={styles.card}>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.message}>{message}</Text>
          <View style={styles.buttons}>
            <Pressable
              onPress={onCancel}
              disabled={loading}
              style={({ hovered }: any) => [
                styles.btn,
                styles.cancelBtn,
                hovered && !loading && styles.cancelBtnHovered,
                loading && { opacity: 0.5 },
              ]}
            >
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={onConfirm}
              disabled={loading}
              style={({ hovered }: any) => [
                styles.btn,
                destructive ? styles.destructiveBtn : styles.confirmBtn,
                hovered && !loading && (destructive ? styles.destructiveBtnHovered : styles.confirmBtnHovered),
                loading && { opacity: 0.7 },
              ]}
            >
              {loading
                ? <ActivityIndicator color={destructive ? colors.error : colors.accentTxt} />
                : <Text style={destructive ? styles.destructiveText : styles.confirmText}>{confirmLabel}</Text>
              }
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(15, 23, 42, 0.5)",
    justifyContent: "center",
    alignItems: "center",
    padding: spacing["2xl"],
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing["2xl"],
    width: "100%",
    maxWidth: 360,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 16,
    elevation: 8,
  },
  title: {
    fontSize: 17,
    fontWeight: "600",
    color: colors.text,
    marginBottom: spacing.sm,
  },
  message: {
    fontSize: 15,
    color: colors.textMuted,
    lineHeight: 22,
    marginBottom: spacing["2xl"],
  },
  buttons: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  btn: {
    flex: 1,
    paddingVertical: spacing.md,
    borderRadius: radii.md,
    alignItems: "center",
  },
  cancelBtn: {
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cancelBtnHovered: {
    backgroundColor: colors.border,
  },
  cancelText: {
    fontSize: 15,
    fontWeight: "500",
    color: colors.text,
  },
  destructiveBtn: {
    backgroundColor: colors.errorBg,
    borderWidth: 1,
    borderColor: colors.errorBd,
  },
  destructiveBtnHovered: {
    backgroundColor: colors.errorHov,
  },
  destructiveText: {
    fontSize: 15,
    fontWeight: "600",
    color: colors.error,
  },
  confirmBtn: {
    backgroundColor: colors.accentBg,
    borderWidth: 1,
    borderColor: colors.accentBd,
  },
  confirmBtnHovered: {
    backgroundColor: colors.accentBd,
  },
  confirmText: {
    fontSize: 15,
    fontWeight: "600",
    color: colors.accentTxt,
  },
});
