import React, { useState } from "react";
import { StyleSheet, View } from "react-native";
import DeadlinesView from "./DeadlinesView";
import DocumentsView from "./DocumentsView";
import TabBar from "./TabBar";
import { spacing } from "../theme";

export type RecordsTab = "documents" | "deadlines";

/**
 * The overlay's tabs. A tab bar with one tab is a control that selects
 * nothing, so none is drawn below two — which is how Documents stood alone
 * until Deadlines joined it.
 */
export const RECORDS_TABS: readonly { value: RecordsTab; label: string }[] = [
  { value: "documents", label: "Documents" },
  { value: "deadlines", label: "Deadlines" },
];

/**
 * Records: what the secretary keeps — the documents on file, and the dates
 * somebody must act on.
 *
 * Built the way `FitnessView` and `AssistantView` are, for their reasons: **a
 * tab is mounted on first visit and then kept**, hidden rather than unmounted,
 * so a half-typed title survives a look at the other tab; and nothing mounts
 * until the overlay first opens. `active` is "the overlay is open"; which tab
 * shows is `Hud`'s, so it survives a close.
 *
 * Not *Secretary*: the whole assistant is the secretary, and a panel claiming
 * the name would suggest the rest of it lives elsewhere.
 */
export default function RecordsView({
  active,
  tab,
  onTab,
}: {
  active: boolean;
  tab: RecordsTab;
  onTab: (tab: RecordsTab) => void;
}) {
  const [visited, setVisited] = useState<RecordsTab[]>([]);

  // During render rather than in an effect, so the tab being opened mounts in
  // the same commit instead of one frame of an empty body.
  if (active && !visited.includes(tab)) setVisited([...visited, tab]);

  const pane = (it: RecordsTab, screen: React.ReactNode) =>
    visited.includes(it) && (
      <View key={it} style={[s.pane, tab !== it && s.hidden]} testID={`records-pane-${it}`}>
        {screen}
      </View>
    );

  return (
    <View style={s.root} testID="records-view">
      {RECORDS_TABS.length > 1 && (
        <View style={s.tabs}>
          <TabBar options={RECORDS_TABS} value={tab} onChange={onTab} />
        </View>
      )}

      <View style={s.body}>
        {pane("documents", <DocumentsView active={active && tab === "documents"} />)}
        {pane("deadlines", <DeadlinesView active={active && tab === "deadlines"} />)}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  // `minHeight: 0` all the way down, or the page never gets a height to scroll inside.
  root: { flex: 1, minHeight: 0 },
  tabs: { paddingHorizontal: spacing.lg, paddingBottom: spacing.sm, maxWidth: 440 },
  body: { flex: 1, minHeight: 0 },
  pane: { flex: 1, minHeight: 0 },
  hidden: { display: "none" },
});
