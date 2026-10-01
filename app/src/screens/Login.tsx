import React, { useState } from "react";
import { ActivityIndicator, Pressable, SafeAreaView, StyleSheet, Text, View } from "react-native";
import HolographicCore from "../components/HolographicCore";
import { useAuth } from "../AuthProvider";
import { GLASS_SCOPE, HUD_SCOPE, colors, hud, radii, spacing, type } from "../theme";

/**
 * The only thing drawn while nobody is signed in.
 *
 * `App` renders this *instead of* the shell, not over it, so nothing under the
 * HUD mounts until the owner is in — no health poll, no calendar, no voice
 * token asked for and refused. Everything on it is the HUD's palette and the
 * HUD's glass, so signing in reads as the same instrument waking up.
 *
 * A refusal is a sentence from the server (another Google account, an expired
 * state) and is shown as it came.
 */
export default function Login() {
  const { state, signIn, retry } = useAuth();
  const [leaving, setLeaving] = useState(false);

  const checking = state.status === "checking";
  const offline = state.status === "offline";
  const message = state.status === "signedOut" || state.status === "offline" ? state.message : undefined;

  const go = async () => {
    setLeaving(true);
    // Resolves only when the browser could not be sent to Google; the message
    // then arrives through the state.
    await signIn();
    setLeaving(false);
  };

  return (
    <SafeAreaView style={s.root}>
      <View {...HUD_SCOPE} style={s.stage}>
        <View style={s.core}>
          <HolographicCore state={checking || leaving ? "working" : offline ? "failed" : "idle"} decorative />
        </View>

        <View {...GLASS_SCOPE} style={s.card} testID="login-card">
          <View style={[s.corner, s.cornerTL]} />
          <View style={[s.corner, s.cornerBR]} />

          <Text style={s.eyebrow}>LIFE OS</Text>
          <Text style={s.title}>{checking ? "Checking your sign-in…" : "Sign in"}</Text>

          {!checking && (
            <Text style={s.body}>
              {offline ? "Your sign-in is kept; try again once the server answers." : "This Life OS opens for its owner's Google account and no other."}
            </Text>
          )}

          {message ? (
            <Text style={offline ? s.warn : s.error} accessibilityRole="alert" testID="login-message">
              {message}
            </Text>
          ) : null}

          {checking ? (
            <ActivityIndicator color={colors.accent} style={s.spinner} />
          ) : offline ? (
            <Pressable
              onPress={retry}
              accessibilityRole="button"
              accessibilityLabel="Try again"
              style={({ hovered }: any) => [s.button, hovered && s.buttonHover]}
            >
              <Text style={s.buttonText}>Try again</Text>
            </Pressable>
          ) : (
            <Pressable
              onPress={go}
              disabled={leaving}
              accessibilityRole="button"
              accessibilityLabel="Sign in with Google"
              accessibilityState={{ disabled: leaving, busy: leaving }}
              style={({ hovered }: any) => [s.button, hovered && !leaving && s.buttonHover, leaving && s.buttonBusy]}
            >
              <Text style={s.g} aria-hidden>
                G
              </Text>
              <Text style={s.buttonText}>{leaving ? "Opening Google…" : "Sign in with Google"}</Text>
            </Pressable>
          )}
        </View>
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, minHeight: "100vh" as any },

  stage: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.lg,
    gap: spacing.xl,
  },

  core: { width: 200, height: 200, maxWidth: "60%" as any },

  card: {
    width: "100%",
    maxWidth: 380,
    padding: spacing["2xl"],
    gap: spacing.md,
    borderWidth: 1,
    borderColor: colors.accentBd,
    backgroundColor: colors.glass,
  },

  corner: { position: "absolute", width: 18, height: 18, borderColor: hud.bracket, pointerEvents: "none" },
  cornerTL: { top: 6, left: 6, borderTopWidth: 1, borderLeftWidth: 1 },
  cornerBR: { bottom: 6, right: 6, borderBottomWidth: 1, borderRightWidth: 1 },

  eyebrow: { ...type.label, color: colors.accentTxt, letterSpacing: 2 },
  title: { ...type.title, color: colors.text },
  body: { ...type.small, color: colors.textMuted },
  error: { ...type.small, color: colors.errorTxt },
  warn: { ...type.small, color: colors.amber },
  spinner: { alignSelf: "flex-start", marginTop: spacing.sm },

  button: {
    marginTop: spacing.sm,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    paddingVertical: spacing.md,
    borderRadius: radii.sm,
    backgroundColor: colors.accent,
  },
  buttonHover: { backgroundColor: colors.accentHov },
  buttonBusy: { opacity: 0.6 },
  // A filled accent button writes `colors.bg`, never white — see theme.test.
  buttonText: { ...type.heading, color: colors.bg },
  g: { ...type.heading, fontWeight: "800", color: colors.bg },
});
