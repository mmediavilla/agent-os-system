import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { GLASS_SCOPE, colors, radii, reachable, spacing, transition, type } from "../theme";

/** Which corner of the HUD a column of popout buttons sits in. */
export type Corner = "top-right" | "bottom-left";

/**
 * A corner of the HUD: a column of buttons, each popping a card out.
 *
 * It began as the weather's alone, bottom left, and the camera joined it on a
 * button of its own. When the core became the menu (Phase 11), the agenda came
 * off the right rail onto a button **top right**, and the camera left the
 * corners for the core's own column (see `OpticsPopout`). So a column is placed
 * by `corner`, and the frame is one thing every card uses, rather than copies
 * that drift.
 *
 * **Only one card is up at a time**, and that is `Hud`'s rule, not this file's:
 * it holds one value for which popout is open, so pressing one button while
 * another's card is out swaps them.
 *
 * **The column sits a fixed `CORNER_INSET` in from its edge.** It rode a rail's
 * edge until the rails went (Phase 11.1); the launchers bottom right use the
 * same inset, so the four corners line up.
 */
export function PopoutTrack({
  corner,
  testID,
  children,
}: {
  corner: Corner;
  testID: string;
  children: React.ReactNode;
}) {
  return (
    <View
      style={[
        s.track,
        corner === "bottom-left" ? s.trackBottom : s.trackTop,
        corner === "top-right" ? s.trackRight : s.trackLeft,
      ]}
      testID={testID}
    >
      {children}
    </View>
  );
}

/**
 * Where a card opens from its button.
 *
 * - `right`: to the button's right, bottom edges level. The weather, bottom
 *   left, out towards the core rather than up into the corner (the owner's call).
 * - `below-end`: under the button, right edges level. The agenda, top right,
 *   so the card stays on screen.
 */
export type Opens = "right" | "below-end";

/**
 * One button and the card it pops out.
 *
 * The card is out of the slot's layout, so a shut card is not an invisible box
 * eating clicks over the core, and the slot is stretched to the column's width
 * so every card starts at the same line whichever button is wider.
 *
 * **An open slot is raised above its siblings.** RN-Web stamps `z-index: 0` on
 * every View, so a card opening downwards would otherwise paint under the next
 * button in its own column. See RN-Web traps: raise the parent.
 *
 * **The card is glass**, the same blur and accent edge as the Assistant and
 * Settings overlays, so everything that floats over the HUD reads as one kind
 * of thing. Mounted open and shut, like every overlay here, so it can slide;
 * shut, it is unreachable rather than merely invisible.
 */
export default function Popout({
  open,
  opens = "right",
  button,
  testID,
  children,
}: {
  open: boolean;
  opens?: Opens;
  button: React.ReactNode;
  /** The card is `${testID}-card`. */
  testID: string;
  children: React.ReactNode;
}) {
  return (
    <View style={[s.slot, { zIndex: open ? 1 : 0 }]}>
      <View
        testID={`${testID}-card`}
        {...GLASS_SCOPE}
        accessibilityElementsHidden={!open}
        importantForAccessibility={open ? "auto" : "no-hide-descendants"}
        aria-hidden={!open}
        style={[
          s.card,
          opens === "right" ? s.cardRight : s.cardBelowEnd,
          transition("opacity, transform, visibility"),
          {
            opacity: open ? 1 : 0,
            // Slides out of the button, the way it opens.
            transform: [opens === "right" ? { translateX: open ? 0 : -8 } : { translateY: open ? 0 : -8 }],
          },
          reachable(open),
        ]}
      >
        {children}
      </View>

      {button}
    </View>
  );
}

/**
 * A button in the column: round, with nothing but an icon in it.
 *
 * `children` is told whether the button is lit (open or hovered), because the
 * icon inside it changes colour with it.
 */
export function PopoutButton({
  open,
  onPress,
  label,
  testID,
  children,
}: {
  open: boolean;
  onPress: () => void;
  label: string;
  testID: string;
  children: (lit: boolean) => React.ReactNode;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ expanded: open }}
      aria-expanded={open}
      style={({ hovered }: any) => [s.button, (open || hovered) && s.buttonActive]}
      testID={testID}
    >
      {({ hovered }: any) => children(open || hovered)}
    </Pressable>
  );
}

/** The ✕ in a card's header. Its button and Escape close it as well. */
export function PopoutClose({
  label,
  onPress,
  testID,
}: {
  label: string;
  onPress: () => void;
  testID: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ hovered }: any) => [s.close, hovered && s.closeHovered]}
      testID={testID}
    >
      <Text style={s.closeIcon}>✕</Text>
    </Pressable>
  );
}

/** How far in from the window's side edge a corner's buttons sit. */
export const CORNER_INSET = 28;

const CARD_W = 320;
const BUTTON_H = 40;

export const popoutStyles = StyleSheet.create({
  // Glass, like the Assistant and Settings overlays, at the owner's call: a clear
  // fill and the blur `GLASS_SCOPE` puts behind it — which is what makes it
  // read as dark, not the fill (see RN-Web traps). The accent edge is theirs
  // too, so the three read as one kind of thing floating over the HUD. Goes on
  // the `Panel` inside the card.
  glass: { backgroundColor: colors.glass, borderColor: colors.accentBd },
});

const s = StyleSheet.create({
  // Anchored to a window corner. Same layer as the launchers: over the core
  // menu, under the full Assistant. Centred like theirs, so the buttons stay in one column
  // whatever their widths.
  track: {
    position: "absolute",
    zIndex: 5,
    alignItems: "center",
    gap: spacing.sm,
  },
  trackTop: { top: spacing.lg },
  trackBottom: { bottom: spacing.lg },
  trackLeft: { left: CORNER_INSET },
  trackRight: { right: CORNER_INSET },

  // As wide as the column, so `left: 100%` on the card is the column's right
  // edge for every button in it.
  slot: { alignSelf: "stretch", alignItems: "center" },

  button: {
    width: BUTTON_H,
    height: BUTTON_H,
    borderRadius: BUTTON_H / 2,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  buttonActive: { borderColor: colors.accent, backgroundColor: colors.accentBg },

  // Out of the slot's layout, so a shut card takes up no space — and no clicks.
  card: {
    position: "absolute",
    width: CARD_W,
    // The radius is the blur's as well as the panel's: `backdrop-filter`
    // follows the element it is on, so without it the glass has square
    // corners behind a round card.
    borderRadius: radii.lg,
  },
  cardRight: { left: "100%", marginLeft: spacing.sm, bottom: 0 },
  cardBelowEnd: { top: "100%", marginTop: spacing.sm, right: 0 },

  close: {
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
  },
  closeHovered: { borderColor: colors.accent },
  closeIcon: { ...type.caption, color: colors.textMuted },
});
