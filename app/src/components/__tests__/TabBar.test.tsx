import React from "react";
import { fireEvent, render } from "@testing-library/react-native";
import TabBar from "../TabBar";

const options = [
  { value: "log",    label: "Log a Workout" },
  { value: "import", label: "Import Hevy CSV" },
  { value: "all",    label: "View all Workouts" },
] as const;

it("renders every option label", () => {
  const { getByText } = render(<TabBar options={options} value="log" onChange={jest.fn()} />);
  options.forEach((o) => expect(getByText(o.label)).toBeTruthy());
});

it("marks only the selected tab as selected", () => {
  const { getAllByRole } = render(<TabBar options={options} value="import" onChange={jest.fn()} />);
  const tabs = getAllByRole("tab");

  expect(tabs).toHaveLength(3);
  expect(tabs.map((t) => t.props.accessibilityState?.selected)).toEqual([false, true, false]);
});

it("marks nothing selected when the value is not one of the options", () => {
  const { getAllByRole } = render(<TabBar options={options} value="" onChange={jest.fn()} />);
  const selected = getAllByRole("tab").filter((t) => t.props.accessibilityState?.selected);
  expect(selected).toHaveLength(0);
});

it("calls onChange with the pressed tab's value", () => {
  const onChange = jest.fn();
  const { getByText } = render(<TabBar options={options} value="log" onChange={onChange} />);

  fireEvent.press(getByText("View all Workouts"));

  expect(onChange).toHaveBeenCalledTimes(1);
  expect(onChange).toHaveBeenCalledWith("all");
});
