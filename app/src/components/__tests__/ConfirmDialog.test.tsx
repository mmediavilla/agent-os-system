import React from "react";
import { ActivityIndicator } from "react-native";
import { fireEvent, render } from "@testing-library/react-native";
import ConfirmDialog from "../ConfirmDialog";

const base = {
  visible: true,
  title: "Delete workout",
  message: "This cannot be undone.",
  onConfirm: jest.fn(),
  onCancel: jest.fn(),
};

beforeEach(() => jest.clearAllMocks());

it("renders title and message", () => {
  const { getByText } = render(<ConfirmDialog {...base} />);
  expect(getByText("Delete workout")).toBeTruthy();
  expect(getByText("This cannot be undone.")).toBeTruthy();
});

it("renders custom confirmLabel", () => {
  const { getByText } = render(<ConfirmDialog {...base} confirmLabel="Remove" />);
  expect(getByText("Remove")).toBeTruthy();
});

it("calls onConfirm when confirm button is pressed", () => {
  const onConfirm = jest.fn();
  const { getByText } = render(
    <ConfirmDialog {...base} confirmLabel="Delete" onConfirm={onConfirm} />
  );
  fireEvent.press(getByText("Delete"));
  expect(onConfirm).toHaveBeenCalledTimes(1);
});

it("calls onCancel when cancel button is pressed", () => {
  const onCancel = jest.fn();
  const { getByText } = render(<ConfirmDialog {...base} onCancel={onCancel} />);
  fireEvent.press(getByText("Cancel"));
  expect(onCancel).toHaveBeenCalledTimes(1);
});

it("shows ActivityIndicator and hides label when loading", () => {
  const { queryByText, UNSAFE_getByType } = render(
    <ConfirmDialog {...base} confirmLabel="Delete" loading />
  );
  expect(queryByText("Delete")).toBeNull();
  expect(UNSAFE_getByType(ActivityIndicator)).toBeTruthy();
});

// Smoke checks: both style branches render without crashing.
// Use toMatchSnapshot() here if style regression detection becomes a priority.
it("renders in destructive mode by default", () => {
  const { toJSON } = render(<ConfirmDialog {...base} confirmLabel="Delete" />);
  expect(toJSON()).toBeTruthy();
});

it("applies non-destructive styling when destructive=false", () => {
  const { toJSON } = render(
    <ConfirmDialog {...base} destructive={false} confirmLabel="Confirm" />
  );
  expect(toJSON()).toBeTruthy();
});
