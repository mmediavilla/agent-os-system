import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import {
  GLASS_SCOPE,
  VERTICAL_SCOPE,
  colors,
  hud,
  radii,
  reachable,
  spacing,
  transition,
  type,
} from "../theme";

/**
 * The console frame every overlay over the HUD is drawn in: glass over a visibly live HUD,
 * an accent border, two corner brackets, a label reading up the left edge, and
 * a close button.
 *
 * It was the Assistant's alone until Settings moved off the menu and asked to
 * open "like the assistant page". One frame rather than a copy, so the two
 * cannot drift into looking like two different kinds of thing. Fitness became
 * the third user in 11.2, which is when it moved out of `Hud.tsx`.
 *
 * The frame has to stay reachable for the transition it carries, so what goes
 * out of reach while it is shut is everything inside it a person could read or
 * press — the spine included, because a shut overlay that still announces
 * SETTINGS is a label with nothing behind it.
 */
export default function GlassOverlay({
  testID,
  spine,
  open,
  onClose,
  closeLabel,
  head,
  children,
}: {
  /** Prefixes the frame's own ids: `-body`, `-spine`, `-close`. */
  testID: string;
  spine: string;
  open: boolean;
  onClose: () => void;
  closeLabel: string;
  /** What sits beside the close button. */
  head: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <View
      testID={testID}
      {...GLASS_SCOPE}
      style={[
        s.full,
        transition("opacity, transform, visibility"),
        { opacity: open ? 1 : 0, transform: [{ translateY: open ? 0 : -10 }] },
        // Not `pointerEvents` alone: a shut Settings left its disabled "Add
        // calendar" clickable over the Optics ✕. See `reachable`.
        reachable(open),
      ]}
    >
      {/* Two of the four, which is what the design draws: a bracket at the
          corner you enter from and one at the corner you leave by. */}
      <View style={[s.fullCorner, s.fullCornerTL]} />
      <View style={[s.fullCorner, s.fullCornerBR]} />

      <View
        testID={`${testID}-body`}
        accessibilityElementsHidden={!open}
        importantForAccessibility={open ? "auto" : "no-hide-descendants"}
        aria-hidden={!open}
        style={s.fullBody}
      >
        <View style={s.spine}>
          <Text {...VERTICAL_SCOPE} style={s.spineText} testID={`${testID}-spine`}>
            {spine}
          </Text>
        </View>

        <View style={s.fullMain}>
          <View style={s.fullHead}>
            {head}

            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel={closeLabel}
              style={({ hovered }: any) => [s.headBtn, hovered && s.headBtnDanger]}
              testID={`${testID}-close`}
            >
              <Text style={s.headBtnIcon}>✕</Text>
            </Pressable>
          </View>

          {children}
        </View>
      </View>
    </View>
  );
}


/** The one-line status beside an overlay's close button. */
export function GlassStatus({ children }: { children: React.ReactNode }) {
  return (
    <Text style={s.status} numberOfLines={1}>
      {children}
    </Text>
  );
}

const s = StyleSheet.create({
  // Above the core menu, the corner buttons and the two launchers — everything on this
  // screen — and still inside it, so the chrome bar stays on top and stays the
  // way out.
  full: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 6,
    borderWidth: 1,
    borderColor: colors.accentBd,
    // Transparent, and deliberately so: what makes this read as a dark panel is
    // the blur `GLASS_SCOPE` puts behind it, not the fill. Same knob the
    // calendar drawer settled on the hard way.
    backgroundColor: colors.glass,
  },

  spine: {
    width: 26,
    alignItems: "center",
    justifyContent: "center",
    borderRightWidth: 1,
    borderRightColor: colors.border,
  },
  // The turn is CSS — see VERTICAL_SCOPE. Under the native test renderer this
  // is an ordinary label, which is the right thing for a test to read.
  spineText: { ...type.label, color: colors.accentTxt, letterSpacing: 2 },

  fullBody: { flex: 1, flexDirection: "row" },
  fullMain: { flex: 1, minWidth: 0, minHeight: 0 },
  fullHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  status: { ...type.caption, color: colors.textMuted, flex: 1 },

  fullCorner: {
    position: "absolute",
    width: 18,
    height: 18,
    borderColor: hud.bracket,
    pointerEvents: "none",
  },
  fullCornerTL: { top: 6, left: 6, borderTopWidth: 1, borderLeftWidth: 1 },
  fullCornerBR: { bottom: 6, right: 6, borderBottomWidth: 1, borderRightWidth: 1 },

  headBtn: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
  },
  headBtnDanger: { borderColor: colors.errorBd, backgroundColor: colors.errorBg },
  headBtnIcon: { ...type.small, color: colors.textMuted },
});
