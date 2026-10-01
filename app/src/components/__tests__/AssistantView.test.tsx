import React from "react";
import { fireEvent, render, screen } from "@testing-library/react-native";
import AssistantView, { AssistantTab } from "../AssistantView";

/**
 * The Assistant overlay's body: which tab is mounted, and what each is handed.
 *
 * The chat and the settings are stubs — their own suites cover what they draw.
 * What matters here is the rule `FitnessView` keeps too: nothing mounts before
 * it is asked for, and a visited tab is kept, so a half-typed message survives a
 * look at Settings.
 */

const mockMounts: string[] = [];

function mockStub(name: string) {
  return (props: Record<string, any>) => {
    const { useEffect } = require("react");
    useEffect(() => {
      mockMounts.push(name);
    }, []);

    const { Text } = require("react-native");

    return (
      <Text testID={`stub-${name}`}>
        {name === "chat"
          ? `chat:${props.chat.id}:${props.assistantOff ? "off" : "on"}`
          : name === "activity" || name === "agents"
            ? `${name}:${props.active ? "on" : "off"}`
            : `settings:${props.health.id}`}
      </Text>
    );
  };
}

jest.mock("../AssistantFull", () => ({ __esModule: true, default: mockStub("chat") }));
jest.mock("../AssistantSettings", () => ({ __esModule: true, default: mockStub("settings") }));
jest.mock("../AssistantActivity", () => ({ __esModule: true, default: mockStub("activity") }));
jest.mock("../AgentsView", () => ({ __esModule: true, default: mockStub("agents") }));
jest.mock("../InstructionsView", () => ({ __esModule: true, default: mockStub("instructions") }));

beforeEach(() => {
  mockMounts.length = 0;
});

function Harness({ active, initial = "chat" }: { active: boolean; initial?: AssistantTab }) {
  const [tab, setTab] = React.useState<AssistantTab>(initial);

  return (
    <AssistantView
      active={active}
      tab={tab}
      onTab={setTab}
      chat={{ id: "the-hud's" } as never}
      assistantOff
      health={{ id: "the-shell's" } as never}
    />
  );
}

it("mounts nothing while the overlay has never been open", () => {
  render(<Harness active={false} />);

  expect(mockMounts).toEqual([]);
  expect(screen.queryByTestId("stub-chat", { includeHiddenElements: true })).toBeNull();
});

it("has Chat, Activity, Agents, Instructions and Settings, in that order, with the one on show selected", () => {
  render(<Harness active />);

  const tabs = screen.getAllByRole("tab");
  expect(tabs).toHaveLength(5);
  expect(tabs[0]).toHaveTextContent("Chat");
  expect(tabs[1]).toHaveTextContent("Activity");
  expect(tabs[2]).toHaveTextContent("Agents");
  expect(tabs[3]).toHaveTextContent("Instructions");
  expect(tabs[4]).toHaveTextContent("Settings");
  expect(screen.getByRole("tab", { name: "Chat" }).props.accessibilityState?.selected).toBe(true);
  expect(screen.getByRole("tab", { name: "Settings" }).props.accessibilityState?.selected).toBe(false);
});

it("hands Chat the HUD's conversation, and Settings the shell's health poll", () => {
  render(<Harness active />);
  expect(screen.getByTestId("stub-chat")).toHaveTextContent("chat:the-hud's:off");

  fireEvent.press(screen.getByRole("tab", { name: "Settings" }));
  expect(screen.getByTestId("stub-settings")).toHaveTextContent("settings:the-shell's");
});

it("keeps Chat mounted and hidden while Settings is showing", () => {
  render(<Harness active />);
  fireEvent.press(screen.getByRole("tab", { name: "Settings" }));

  expect(mockMounts).toEqual(["chat", "settings"]);
  expect(screen.queryByTestId("stub-chat")).toBeNull();
  expect(screen.getByTestId("stub-chat", { includeHiddenElements: true })).toBeTruthy();

  fireEvent.press(screen.getByRole("tab", { name: "Chat" }));
  expect(mockMounts).toEqual(["chat", "settings"]);
});

it("mounts the tab it opens on, and only that one", () => {
  render(<Harness active initial="settings" />);

  expect(mockMounts).toEqual(["settings"]);
});

it("tells Activity it is showing only while it is the tab on show", () => {
  // Its poll keys off 'active'; a hidden tab that kept polling would be
  // reading counts nobody is looking at.
  render(<Harness active />);
  fireEvent.press(screen.getByRole("tab", { name: "Activity" }));
  expect(screen.getByTestId("stub-activity")).toHaveTextContent("activity:on");

  fireEvent.press(screen.getByRole("tab", { name: "Chat" }));
  expect(screen.getByTestId("stub-activity", { includeHiddenElements: true })).toHaveTextContent("activity:off");
});

it("tells Agents it is showing only while it is the tab on show", () => {
  // It reads on arrival, keyed off 'active' — so coming back re-reads what
  // another tab or a typed request may have switched.
  render(<Harness active />);
  fireEvent.press(screen.getByRole("tab", { name: "Agents" }));
  expect(screen.getByTestId("stub-agents")).toHaveTextContent("agents:on");

  fireEvent.press(screen.getByRole("tab", { name: "Settings" }));
  expect(screen.getByTestId("stub-agents", { includeHiddenElements: true })).toHaveTextContent("agents:off");
});
