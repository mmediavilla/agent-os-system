import React from "react";
import { Pressable, Text } from "react-native";
import { fireEvent, render } from "@testing-library/react-native";
import { UnitsProvider, useUnits } from "../UnitsProvider";

function Probe() {
  const { units, setUnit } = useUnits();
  return (
    <>
      <Text>{`${units.weight}/${units.distance}/${units.measurement}`}</Text>
      <Pressable accessibilityRole="button" onPress={() => setUnit("weight", "lb")}>
        <Text>pounds</Text>
      </Pressable>
      <Pressable accessibilityRole="button" onPress={() => setUnit("distance", "mi")}>
        <Text>miles</Text>
      </Pressable>
    </>
  );
}

it("starts on the canonical units", () => {
  const { getByText } = render(
    <UnitsProvider>
      <Probe />
    </UnitsProvider>,
  );
  expect(getByText("kg/km/cm")).toBeTruthy();
});

it("changes one dimension at a time", () => {
  const { getByText } = render(
    <UnitsProvider>
      <Probe />
    </UnitsProvider>,
  );

  fireEvent.press(getByText("pounds"));
  expect(getByText("lb/km/cm")).toBeTruthy();

  fireEvent.press(getByText("miles"));
  expect(getByText("lb/mi/cm")).toBeTruthy();
});

it("falls back to the canonical units outside a provider", () => {
  // Every stored value is already canonical, so a panel rendered on its own
  // shows the raw numbers rather than crashing.
  const { getByText } = render(<Probe />);
  expect(getByText("kg/km/cm")).toBeTruthy();
});

it("makes setting a unit a no-op outside a provider", () => {
  // There is nowhere to keep the choice, so nothing should appear to change.
  const { getByText } = render(<Probe />);

  fireEvent.press(getByText("pounds"));
  expect(getByText("kg/km/cm")).toBeTruthy();
});
