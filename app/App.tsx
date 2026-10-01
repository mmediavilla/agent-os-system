import { StatusBar } from "expo-status-bar";
import React, { useState } from "react";
import { SafeAreaView, StyleSheet, useWindowDimensions, View } from "react-native";
import Hud from "./src/screens/Hud";
import HudChrome from "./src/components/HudChrome";
import { OrbState } from "./src/components/AssistantOrb";
import { api } from "./src/api";
import { usePolled } from "./src/polling";
import { ThemeProvider } from "./src/ThemeProvider";
import { UnitsProvider } from "./src/UnitsProvider";
import { FitnessPrefsProvider } from "./src/FitnessPrefsProvider";
import { AssistantPrefsProvider } from "./src/AssistantPrefsProvider";
import { HUD_SCOPE, colors } from "./src/theme";
import { AuthProvider, useAuth } from "./src/AuthProvider";
import { AuthUser, bounceIfNeeded } from "./src/auth";
import Login from "./src/screens/Login";

/**
 * Decided once, before anything renders: a sign-in callback that landed on the
 * localhost name Google allows is forwarded to the app’s own origin, and this
 * page draws nothing on its way out.
 */
const bouncing = bounceIfNeeded();

/**
 * Wraps the shell so everything renders under the owner's sign-in, the chosen
 * appearance, units, and Fitness and Assistant preferences.
 */
export default function App() {
  if (bouncing) return null;

  return (
    <ThemeProvider>
      <AuthProvider>
        <Gate />
      </AuthProvider>
    </ThemeProvider>
  );
}

/**
 * Login, or the app — never both.
 *
 * Signed out, the shell is not mounted at all rather than hidden, so nothing in
 * it polls, streams or asks for a voice token before there is a token to ask
 * with. Signing out unmounts it the same way, which is what stops every poll.
 */
function Gate() {
  const { state, signOut } = useAuth();

  if (state.status !== "signedIn") return <Login />;

  return (
    <UnitsProvider>
      <FitnessPrefsProvider>
        <AssistantPrefsProvider>
          <AppShell account={{ user: state.user, signOut }} />
        </AssistantPrefsProvider>
      </FitnessPrefsProvider>
    </UnitsProvider>
  );
}

/** Below this the bar drops its clock rather than overflowing. */
const NARROW = 768;

/**
 * The shell: the chrome bar, and the HUD under it.
 *
 * The HUD is the only screen. There used to be five, switched from a menu row
 * in the bar and kept mounted once visited; since 11.2 the Fitness screens open
 * over the HUD in a glass overlay (`FitnessView`, which took over the
 * mount-once rule), so there is nothing here left to switch.
 */
function AppShell({ account }: { account: { user: AuthUser; signOut: () => void } }) {
  /**
   * How the machine behind the app is doing, read once for the whole shell.
   *
   * It lives here rather than in either consumer because there are two — the
   * pill in the chrome bar and the core menu's System stats panel — and two
   * pollers against one endpoint would be two readings of the same truth
   * disagreeing for fifteen seconds at a time.
   */
  const health = usePolled(api.getHealth, { intervalMs: 15_000 });

  /**
   * What the assistant is doing, reported up by the HUD, for the bar's small
   * orb. A callback rather than lifting the conversation into the shell, which
   * would put a run watcher and a voice session here to serve one indicator.
   */
  const [orb, setOrb] = useState<OrbState>("idle");

  const narrow = useWindowDimensions().width < NARROW;

  return (
    <SafeAreaView style={styles.root}>
      {/* Always the HUD's palette now: there is no other screen for the bar to
          sit over. */}
      <View {...HUD_SCOPE} style={styles.chrome} testID="chrome-scope">
        <HudChrome narrow={narrow} orb={orb} health={health} />
      </View>

      <View style={styles.content}>
        <Hud health={health} onOrbState={setOrb} account={account} />
      </View>

      <StatusBar style="auto" />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, minHeight: "100vh" as any },

  // Above the HUD, whose core menu and overlays are absolutely positioned
  // layers under the bar.
  chrome: { zIndex: 3 },

  content: { flex: 1 },
});
