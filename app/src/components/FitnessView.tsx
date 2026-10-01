import React, { useState } from "react";
import { StyleSheet, View } from "react-native";
import FitnessSettings from "./FitnessSettings";
import TabBar from "./TabBar";
import Equipment from "../screens/Equipment";
import Exercises from "../screens/Exercises";
import Fitness from "../screens/Fitness";
import Workouts from "../screens/Workouts";
import { spacing } from "../theme";

export type FitnessTab = "home" | "workouts" | "exercises" | "equipment" | "settings";

export const FITNESS_TABS: readonly { value: FitnessTab; label: string }[] = [
  { value: "home", label: "Home" },
  { value: "workouts", label: "Workouts" },
  { value: "exercises", label: "Exercises" },
  { value: "equipment", label: "Equipment" },
  { value: "settings", label: "Settings" },
];

/**
 * The four Fitness screens and their settings, inside the HUD's Fitness overlay.
 *
 * They were destinations in the menu bar until 11.2, when the bar went and the
 * HUD became the only screen: a screen replaces the HUD, and an overlay over it
 * does not. So what `App` used to do for them is done here, unchanged:
 *
 * - **A tab is mounted on first visit and then kept**, hidden rather than
 *   unmounted, so switching away from a half-filled workout form does not wipe
 *   it. Nothing mounts until the overlay first opens, so the HUD's startup is
 *   not four screens' worth of requests.
 * - **Each screen's `active` is "the overlay is open and this is its tab"**,
 *   which is what `useRefreshOnActivate` keys off. Any screen added here must
 *   take that prop, or it will show stale data forever.
 * - **`openAllSignal` is a counter, not a flag**: Home asks Workouts to open its
 *   full list, and Workouts stays mounted, so only a changed value makes it
 *   re-select that tab on a second visit.
 */
export default function FitnessView({
  active,
  tab,
  onTab,
}: {
  /** Whether the overlay is open. */
  active: boolean;
  tab: FitnessTab;
  onTab: (tab: FitnessTab) => void;
}) {
  const [visited, setVisited] = useState<FitnessTab[]>([]);
  const [openAllSignal, setOpenAllSignal] = useState(0);

  // During render rather than in an effect, so the tab being opened mounts in
  // the same commit instead of one frame of an empty body.
  if (active && !visited.includes(tab)) setVisited([...visited, tab]);

  const pane = (it: FitnessTab, screen: React.ReactNode) =>
    visited.includes(it) && (
      <View key={it} style={[s.pane, tab !== it && s.hidden]} testID={`fitness-pane-${it}`}>
        {screen}
      </View>
    );

  const on = (it: FitnessTab) => active && tab === it;

  return (
    <View style={s.root} testID="fitness-view">
      <View style={s.tabs}>
        <TabBar options={FITNESS_TABS} value={tab} onChange={onTab} />
      </View>

      <View style={s.body}>
        {pane(
          "home",
          <Fitness
            active={on("home")}
            onOpenAllWorkouts={() => {
              setOpenAllSignal((n) => n + 1);
              onTab("workouts");
            }}
          />,
        )}
        {pane("workouts", <Workouts active={on("workouts")} openAllSignal={openAllSignal} />)}
        {pane("exercises", <Exercises active={on("exercises")} />)}
        {pane("equipment", <Equipment active={on("equipment")} />)}
        {pane("settings", <FitnessSettings active={on("settings")} />)}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  // `minHeight: 0` all the way down, or a flex child grows to its content and
  // the screens' own ScrollViews never get a height to scroll inside.
  root: { flex: 1, minHeight: 0 },
  tabs: { paddingHorizontal: spacing.lg, paddingBottom: spacing.sm, maxWidth: 640 },
  body: { flex: 1, minHeight: 0 },
  pane: { flex: 1, minHeight: 0 },
  hidden: { display: "none" },
});
