import React from "react";
import { fireEvent, render, screen } from "@testing-library/react-native";
import RecordsView, { RecordsTab } from "../RecordsView";

/**
 * The overlay's body, on `FitnessView`'s rules: the tab bar draws once there
 * are two tabs, nothing mounts before it is asked for, a visited tab is kept,
 * and only the tab on show, in an open overlay, is `active`. The tabs are stubs
 * that print their props — their own suites cover what they draw.
 */

const mockMounts: string[] = [];

function mockStub(name: string) {
  return (props: { active: boolean }) => {
    const { useEffect } = require("react");
    useEffect(() => {
      mockMounts.push(name);
    }, []);
    const { Text } = require("react-native");
    return <Text testID={`stub-${name}`}>{`${name}:${props.active ? "active" : "idle"}`}</Text>;
  };
}

jest.mock("../DocumentsView", () => ({ __esModule: true, default: mockStub("documents") }));
jest.mock("../DeadlinesView", () => ({ __esModule: true, default: mockStub("deadlines") }));

beforeEach(() => {
  mockMounts.length = 0;
});

function Harness({ active, initial = "documents" }: { active: boolean; initial?: RecordsTab }) {
  const [tab, setTab] = React.useState<RecordsTab>(initial);
  return <RecordsView active={active} tab={tab} onTab={setTab} />;
}

const text = (name: string) =>
  screen.getByTestId(`stub-${name}`, { includeHiddenElements: true }).props.children as string;

it("draws a tab bar now that there are two tabs", () => {
  render(<Harness active />);

  expect(screen.getByText("Documents")).toBeTruthy();
  expect(screen.getByText("Deadlines")).toBeTruthy();
});

it("mounts Deadlines on its first visit, and keeps Documents mounted but idle", () => {
  render(<Harness active />);
  expect(mockMounts).toEqual(["documents"]);

  fireEvent.press(screen.getByText("Deadlines"));

  expect(mockMounts).toEqual(["documents", "deadlines"]);
  expect(text("deadlines")).toBe("deadlines:active");
  expect(text("documents")).toBe("documents:idle");

  fireEvent.press(screen.getByText("Documents"));
  expect(mockMounts).toEqual(["documents", "deadlines"]);
  expect(text("documents")).toBe("documents:active");
});

it("opens on the tab it was left on, and nothing is active while shut", () => {
  const view = render(<Harness active={false} initial="deadlines" />);
  expect(mockMounts).toEqual([]);

  view.rerender(<Harness active initial="deadlines" />);
  expect(mockMounts).toEqual(["deadlines"]);
  expect(text("deadlines")).toBe("deadlines:active");
});
