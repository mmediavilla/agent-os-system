import React, { useState } from "react";
import { StyleSheet, View } from "react-native";
import AgentsView from "./AgentsView";
import AssistantActivity from "./AssistantActivity";
import AssistantFull from "./AssistantFull";
import AssistantSettings from "./AssistantSettings";
import InstructionsView from "./InstructionsView";
import TabBar from "./TabBar";
import { Health } from "../api";
import { Polled } from "../polling";
import { spacing } from "../theme";
import { ConversationController } from "../useConversation";

export type AssistantTab = "chat" | "activity" | "agents" | "instructions" | "settings";

export const ASSISTANT_TABS: readonly { value: AssistantTab; label: string }[] = [
  { value: "chat", label: "Chat" },
  { value: "activity", label: "Activity" },
  { value: "agents", label: "Agents" },
  { value: "instructions", label: "Instructions" },
  { value: "settings", label: "Settings" },
];

/**
 * The Assistant overlay's five tabs: the conversation, what it has kept and
 * done this week, the agents that decide what it may do (17.2), the
 * instructions it is given in the owner's words, and its settings — last, as
 * on Fitness.
 *
 * Built the way `FitnessView` is, for the same reasons: **a tab is mounted on
 * first visit and then kept**, hidden rather than unmounted, so a half-typed
 * message survives a look at Settings; and nothing mounts until the overlay
 * first opens.
 *
 * `active` is "the overlay is open"; which tab shows is `Hud`'s, so it survives
 * a close — ⌘K and a camera capture choose Chat, the core menu reopens on the
 * tab last shown.
 */
export default function AssistantView({
  active,
  tab,
  onTab,
  chat,
  assistantOff,
  health,
}: {
  active: boolean;
  tab: AssistantTab;
  onTab: (tab: AssistantTab) => void;
  chat: ConversationController;
  assistantOff: boolean;
  health: Polled<Health>;
}) {
  const [visited, setVisited] = useState<AssistantTab[]>([]);

  // During render rather than in an effect, so the tab being opened mounts in
  // the same commit instead of one frame of an empty body.
  if (active && !visited.includes(tab)) setVisited([...visited, tab]);

  const pane = (it: AssistantTab, screen: React.ReactNode) =>
    visited.includes(it) && (
      <View key={it} style={[s.pane, tab !== it && s.hidden]} testID={`assistant-pane-${it}`}>
        {screen}
      </View>
    );

  return (
    <View style={s.root} testID="assistant-view">
      <View style={s.tabs}>
        <TabBar options={ASSISTANT_TABS} value={tab} onChange={onTab} />
      </View>

      <View style={s.body}>
        {pane("chat", <AssistantFull chat={chat} assistantOff={assistantOff} />)}
        {pane("activity", <AssistantActivity active={active && tab === "activity"} />)}
        {pane("agents", <AgentsView active={active && tab === "agents"} />)}
        {pane("instructions", <InstructionsView active={active && tab === "instructions"} />)}
        {pane("settings", <AssistantSettings active={active && tab === "settings"} health={health} />)}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  // `minHeight: 0` all the way down, or a flex child grows to its content and
  // the transcript's ScrollView never gets a height to scroll inside.
  root: { flex: 1, minHeight: 0 },
  tabs: { paddingHorizontal: spacing.lg, paddingBottom: spacing.sm, maxWidth: 440 },
  body: { flex: 1, minHeight: 0 },
  pane: { flex: 1, minHeight: 0 },
  hidden: { display: "none" },
});
