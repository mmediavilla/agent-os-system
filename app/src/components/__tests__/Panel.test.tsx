import React from "react";
import { render } from "@testing-library/react-native";
import { Text } from "react-native";
import Panel from "../Panel";

/**
 * What is worth asserting about a box is what it does *not* draw.
 *
 * The reason `Panel` exists is that eight of them sit side by side on the HUD,
 * and the thing you see there is not the data but the 2px by which one
 * neighbour's header is taller than the next. So: no header when nothing was
 * given for one, no divider under an absent footer, and the same spacing
 * decision made once.
 */

it("draws no header at all when it was given nothing to put in one", () => {
  const q = render(
    <Panel>
      <Text>body</Text>
    </Panel>,
  );

  expect(q.getByText("body")).toBeTruthy();
  expect(q.queryByRole("header")).toBeNull();
});

it("marks its title as a heading, so eight panels are navigable", () => {
  const q = render(<Panel eyebrow="SYSTEMS" title="This machine" />);

  expect(q.getByRole("header", { name: "This machine" })).toBeTruthy();
  expect(q.getByText("SYSTEMS")).toBeTruthy();
});

it("takes an eyebrow on its own", () => {
  const q = render(<Panel eyebrow="TODAY" />);

  expect(q.getByText("TODAY")).toBeTruthy();
  expect(q.queryByRole("header")).toBeNull();
});

it("puts the right slot beside the title rather than under it", () => {
  const q = render(<Panel title="This week" right={<Text>82%</Text>} />);

  expect(q.getByText("82%")).toBeTruthy();
});

it("renders a footer only when there is one to render", () => {
  expect(render(<Panel title="x" />).queryByText("last: Monday")).toBeNull();
  expect(
    render(<Panel title="x" footer={<Text>last: Monday</Text>} />).getByText("last: Monday"),
  ).toBeTruthy();
});

it("keeps the instrument brackets off by default", () => {
  // `--h-bracket` only has a value inside a `data-hud` subtree; outside one an
  // undefined custom property leaves the border at `currentColor`, which would
  // paint four black ticks on a white card.
  expect(render(<Panel title="x" />).queryByTestId("panel-corners")).toBeNull();
  expect(render(<Panel title="x" corners />).getByTestId("panel-corners")).toBeTruthy();
});
