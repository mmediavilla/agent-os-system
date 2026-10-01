import React from "react";
import { StyleSheet, Text, View } from "react-native";
import AssistantOrb, { OrbState } from "./AssistantOrb";
import { Health } from "../api";
import { Polled, useNow } from "../polling";
import { colors, radii, spacing, type } from "../theme";

/**
 * The app's only chrome: the orb, the wordmark, the clock and the status words.
 *
 * It used to carry the menu too — HUD, and a Fitness group whose four children
 * opened inline — because a menu that lived only on the HUD would be one you
 * could not use to leave it. Phase 11 made the HUD the only screen: the core is
 * the menu, and Fitness opens over the HUD as an overlay. With nowhere to go
 * there is nothing to navigate, so the row went, and so did the subtitle that
 * said where you were.
 *
 * It stays outside the HUD rather than in it, because the overlays stop at it:
 * the bar is the one thing never covered.
 */
export default function HudChrome({
  orb = "idle",
  narrow,
  health,
}: {
  orb?: OrbState;
  /** Drops the clock, rather than letting the bar overflow. */
  narrow: boolean;
  /**
   * Whether the machine behind the app is well. Polled by `App` and shared with
   * the HUD's System stats panel, so the pill and the menu cannot disagree.
   */
  health: Polled<Health>;
}) {
  const now = useNow();

  const stamp = now.toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <View style={s.bar} testID="hud-chrome">
      <View style={s.brand}>
        {/* Decorative. The core below announces the same run, and naming both
            leaves a screen reader with two identical images. */}
        <AssistantOrb state={orb} size={28} decorative />
        <Text style={s.brandName}>LIFE OS</Text>
      </View>

      <View style={s.spacer} />

      {!narrow && <Text style={s.stamp}>{stamp}</Text>}
      <AssistantOffChip health={health} />
      <NoCreditChip health={health} />
      <StatusPill health={health} />
    </View>
  );
}

/**
 * Whether the machine behind the app is answering, in one word.
 *
 * Global rather than HUD-only, which is what it replaces: the bar used to carry
 * a `SAMPLE` badge on the one screen whose numbers were invented. Every screen
 * in this app fails the same way when the API is unreachable — an error banner
 * where the data should be — and one pill in the chrome says it once instead.
 *
 * Three words for four cases, because `unknown` and `down` are both "look at
 * this": `DEGRADED` covers a queue worker that never ran and one that stopped,
 * and the core menu's System stats panel is where the difference is spelled out.
 */
function StatusPill({ health }: { health: Polled<Health> }) {
  const { data, error, loading } = health;

  const [label, tone] = !data
    ? loading
      ? ["CONNECTING", colors.textDim]
      : ["OFFLINE", colors.error]
    : error
      ? ["STALE", colors.amber]
      : data.ok
        ? ["ONLINE", colors.emerald]
        : ["DEGRADED", colors.amber];

  return (
    <View style={[s.pill, { borderColor: tone }]} testID="status-pill">
      <Text style={[s.pillText, { color: tone }]}>{label}</Text>
    </View>
  );
}

/**
 * Says, on every screen, that the assistant has been switched off.
 *
 * Deliberately *not* folded into the pill beside it. That pill answers "is
 * anything wrong", and an API the user switched off themselves is not wrong —
 * `DEGRADED` there would be the app calling a decision a fault, which is the
 * fastest way to teach someone to stop reading a status light. This is a second
 * word for a second question, and it is only ever present when the answer is
 * yes: there is no `AI ON` chip, because the ordinary state does not need
 * announcing.
 *
 * Amber, the colour the approval cards already use for *something is true and
 * you should know*. Global rather than on the HUD, because the switch is global
 * — the weekly assessment in Fitness stops working too, and finding
 * that out by pressing the button is worse than reading it in the bar.
 */
function AssistantOffChip({ health }: { health: Polled<Health> }) {
  // Only on a reading we actually have. A dropped poll must not draw this: the
  // one thing worse than not knowing the API is off is being told it is off
  // when it is not.
  if (health.data?.assistant.enabled !== false) return null;

  return (
    <View style={[s.pill, { borderColor: colors.amber }]} testID="assistant-off-chip">
      <Text style={[s.pillText, { color: colors.amber }]}>AI OFF</Text>
    </View>
  );
}

/**
 * Says, on every screen, that Anthropic is refusing calls for lack of credit.
 *
 * Beside `AI OFF` rather than folded into the pill, for the same reason: the
 * pill is about this machine, and this is the account. Red, not amber — unlike
 * the switch, nobody chose this, and the core under it is red for the same
 * reason. There is no balance to show (Anthropic has no API for one), so it is
 * a word, and it goes on its own once a call goes through.
 */
function NoCreditChip({ health }: { health: Polled<Health> }) {
  if (health.data?.assistant.credit?.exhausted !== true) return null;

  return (
    <View
      style={[s.pill, { borderColor: colors.error }]}
      testID="no-credit-chip"
      accessibilityLabel="The Anthropic account is out of credit"
    >
      <Text style={[s.pillText, { color: colors.error }]}>NO CREDIT</Text>
    </View>
  );
}

const s = StyleSheet.create({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    // Above the HUD's absolutely positioned layers.
    zIndex: 3,
  },

  brand: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  brandName: { ...type.title, color: colors.text, letterSpacing: 2 },
  spacer: { flex: 1 },
  stamp: { ...type.readout, color: colors.textMuted },

  // The border and the text are coloured from the state, so the tokens here are
  // only the geometry.
  pill: {
    borderWidth: 1,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  pillText: { ...type.micro, letterSpacing: 1.2 },
});
