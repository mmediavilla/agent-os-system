import React from "react";
import { fireEvent, render, screen } from "@testing-library/react-native";
import FitnessView, { FitnessTab } from "../FitnessView";

/**
 * The overlay's body: which screens are mounted, and what each is told.
 *
 * The screens are stubs that print their props — their own suites cover what
 * they draw. What matters here is what `App` used to guarantee and this now
 * does: nothing mounts before it is asked for, a visited screen is kept, and
 * only the tab on show, in an open overlay, is `active`.
 */

const mockMounts: string[] = [];

function mockStub(name: string) {
  return (props: Record<string, any>) => {
    const { useEffect } = require("react");
    useEffect(() => {
      mockMounts.push(name);
    }, []);

    const { Pressable, Text } = require("react-native");

    return (
      <>
        <Text testID={`stub-${name}`}>
          {`${name}:${props.active ? "active" : "idle"}:${props.openAllSignal ?? "-"}`}
        </Text>
        {props.onOpenAllWorkouts && (
          <Pressable testID="stub-view-all" onPress={props.onOpenAllWorkouts} />
        )}
      </>
    );
  };
}

jest.mock("../../screens/Fitness", () => ({ __esModule: true, default: mockStub("home") }));
jest.mock("../../screens/Workouts", () => ({ __esModule: true, default: mockStub("workouts") }));
jest.mock("../../screens/Exercises", () => ({ __esModule: true, default: mockStub("exercises") }));
jest.mock("../../screens/Equipment", () => ({ __esModule: true, default: mockStub("equipment") }));
jest.mock("../FitnessSettings", () => ({ __esModule: true, default: mockStub("settings") }));

beforeEach(() => {
  mockMounts.length = 0;
});

function Harness({ active, initial = "home" }: { active: boolean; initial?: FitnessTab }) {
  const [tab, setTab] = React.useState<FitnessTab>(initial);

  return <FitnessView active={active} tab={tab} onTab={setTab} />;
}

it("mounts nothing while the overlay has never been open", () => {
  render(<Harness active={false} />);

  expect(mockMounts).toEqual([]);
  expect(screen.queryByTestId("stub-home", { includeHiddenElements: true })).toBeNull();
});

it("mounts the tab it opens on, and tells it that it is active", () => {
  render(<Harness active initial="exercises" />);

  expect(mockMounts).toEqual(["exercises"]);
  expect(screen.getByTestId("stub-exercises")).toHaveTextContent("exercises:active:-");
});

it("keeps a visited tab mounted and hidden, and inactive", () => {
  // Switching away from a half-filled workout form must not wipe it.
  render(<Harness active initial="workouts" />);
  fireEvent.press(screen.getByRole("tab", { name: "Equipment" }));

  expect(mockMounts).toEqual(["workouts", "equipment"]);
  expect(screen.queryByTestId("stub-workouts")).toBeNull();
  expect(screen.getByTestId("stub-workouts", { includeHiddenElements: true })).toHaveTextContent(
    "workouts:idle:0",
  );
  expect(screen.getByTestId("stub-equipment")).toHaveTextContent("equipment:active:-");
});

it("has a Settings tab, mounted like the others only once it is visited", () => {
  render(<Harness active initial="home" />);
  expect(mockMounts).toEqual(["home"]);

  fireEvent.press(screen.getByRole("tab", { name: "Settings" }));

  expect(mockMounts).toEqual(["home", "settings"]);
  expect(screen.getByTestId("stub-settings")).toHaveTextContent("settings:active:-");
});

it("marks the tab on show as selected", () => {
  render(<Harness active initial="workouts" />);

  expect(screen.getByRole("tab", { name: "Workouts" }).props.accessibilityState?.selected).toBe(
    true,
  );
});

it("tells every screen it is inactive once the overlay shuts, without unmounting it", () => {
  const q = render(<Harness active initial="home" />);
  q.rerender(<Harness active={false} initial="home" />);

  expect(mockMounts).toEqual(["home"]);
  expect(screen.getByTestId("stub-home")).toHaveTextContent("home:idle:-");
});

it("opens Workouts on its full list when Home asks", () => {
  // A counter rather than a flag: Workouts stays mounted, so only a changed
  // value makes it re-select that tab on a second visit.
  render(<Harness active initial="home" />);
  fireEvent.press(screen.getByTestId("stub-view-all"));

  expect(screen.getByTestId("stub-workouts")).toHaveTextContent("workouts:active:1");

  fireEvent.press(screen.getByRole("tab", { name: "Home" }));
  fireEvent.press(screen.getByTestId("stub-view-all"));
  expect(screen.getByTestId("stub-workouts")).toHaveTextContent("workouts:active:2");
});
