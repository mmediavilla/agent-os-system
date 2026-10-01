import React from "react";
import { fireEvent, render, within } from "@testing-library/react-native";
import { Text } from "react-native";
import Dropdown from "../Dropdown";

const OPTIONS = ["Barbell", "Dumbbells", "Treadmill"] as const;

function setup(props: Partial<React.ComponentProps<typeof Dropdown>> = {}) {
  const onChange = jest.fn();
  const q = render(
    <Dropdown
      options={OPTIONS}
      value=""
      onChange={onChange}
      placeholder="Select equipment…"
      testID="dd"
      {...props}
    />,
  );
  return { q, onChange, open: () => fireEvent.press(q.getByTestId("dd")) };
}

it("shows the placeholder until something is selected", () => {
  const { q } = setup();
  expect(within(q.getByTestId("dd")).getByText("Select equipment…")).toBeTruthy();
});

it("shows the selected option's label on the trigger", () => {
  const { q } = setup({ value: "Dumbbells" });
  expect(within(q.getByTestId("dd")).getByText("Dumbbells")).toBeTruthy();
});

it("keeps the options hidden until the trigger is pressed", () => {
  const { q, open } = setup();
  expect(q.queryByText("Treadmill")).toBeNull();

  open();
  expect(q.getByText("Treadmill")).toBeTruthy();
});

it("reports the chosen value and closes", () => {
  const { q, onChange, open } = setup();
  open();
  fireEvent.press(q.getByText("Barbell"));

  expect(onChange).toHaveBeenCalledWith("Barbell");
  expect(q.queryByText("Treadmill")).toBeNull();
});

it("marks the current selection in the sheet", () => {
  const { q, open } = setup({ value: "Dumbbells" });
  open();

  expect(q.getByRole("button", { name: "Dumbbells", selected: true })).toBeTruthy();
  expect(q.getByRole("button", { name: "Barbell", selected: false })).toBeTruthy();
});

it("offers no clear entry unless one is asked for", () => {
  const { q, open } = setup({ value: "Barbell" });
  open();
  expect(q.queryByText("No equipment")).toBeNull();
});

it("reports an empty value when the clear entry is chosen", () => {
  const { q, onChange, open } = setup({ value: "Barbell", clearLabel: "No equipment" });
  open();
  fireEvent.press(q.getByText("No equipment"));

  expect(onChange).toHaveBeenCalledWith("");
});

it("labels the trigger with a value the options no longer carry", () => {
  // The caller is expected to append such a value to `options`, but a stale one
  // must never leave the trigger looking like an empty field.
  const { q } = setup({ value: "Retired Bar" });
  expect(within(q.getByTestId("dd")).getByText("Retired Bar")).toBeTruthy();
});

it("uses the label, not the value, for object options", () => {
  const { q, onChange } = setup({
    options: [{ value: "weight_reps", label: "Weight + Reps" }],
    value: "weight_reps",
  });
  expect(within(q.getByTestId("dd")).getByText("Weight + Reps")).toBeTruthy();

  // By role, because the trigger now carries that label too.
  fireEvent.press(q.getByTestId("dd"));
  fireEvent.press(q.getByRole("button", { name: "Weight + Reps", selected: true }));
  expect(onChange).toHaveBeenCalledWith("weight_reps");
});

// ── Leading icons ─────────────────────────────────────────────────────────────

/** Stands in for the caller's picture, and records what it was asked to draw. */
function iconSetup(props: Partial<React.ComponentProps<typeof Dropdown>> = {}) {
  const renderIcon = jest.fn((value: string, size: number) => (
    <Text testID={`icon-${value}-${size}`}>{`icon:${value}`}</Text>
  ));
  return { ...setup({ renderIcon, ...props }), renderIcon };
}

it("draws an icon beside every option", () => {
  const { q, renderIcon, open } = iconSetup();
  open();

  for (const option of OPTIONS) expect(q.getByTestId(`icon-${option}-32`)).toBeTruthy();
  // The size is the sheet's, not the trigger's — the two differ on purpose.
  expect(renderIcon).toHaveBeenCalledWith("Barbell", 32);
});

it("draws the selection's icon on the trigger, at the trigger's size", () => {
  const { q } = iconSetup({ value: "Dumbbells" });

  expect(within(q.getByTestId("dd")).getByTestId("icon-Dumbbells-24")).toBeTruthy();
});

it("draws no icon on the trigger while nothing is selected", () => {
  // There is no picture of an empty field, and the placeholder says as much.
  const { q } = iconSetup();

  expect(within(q.getByTestId("dd")).queryByText(/^icon:/)).toBeNull();
});

it("never asks the caller to draw the clear entry", () => {
  // It gets an empty slot instead, so the labels below it stay in a column.
  const { renderIcon, open } = iconSetup({ clearLabel: "No equipment" });
  open();

  expect(renderIcon).not.toHaveBeenCalledWith("", expect.anything());
});

it("leaves the rows text-only when no icon renderer is given", () => {
  const { q, open } = setup({ value: "Barbell" });
  open();

  expect(q.queryByText(/^icon:/)).toBeNull();
});
