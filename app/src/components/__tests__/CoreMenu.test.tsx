import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react-native";
import CoreMenu, { MenuPanel, spread } from "../CoreMenu";

/**
 * The core menu, drawn from data.
 *
 * `Hud` decides what the panels hold and what a row does; its suite covers
 * that wiring. What is asserted here is the drawing: how six panels split
 * across two columns, that a shut menu is out of reach and not only invisible,
 * that the panels stagger in, and that a readout is not a button.
 */

function panels(onPress = jest.fn()): MenuPanel[] {
  return ["one", "two", "three", "four", "five", "six"].map((key, i) => ({
    key,
    title: `Panel ${key}`,
    rows:
      i === 0
        ? [
            { kind: "action", key: "go", label: "Go", value: "›", onPress },
            { kind: "action", key: "no", label: "Nope", onPress, disabled: true },
            { kind: "readout", key: "state", label: "State", value: "fine", tone: "emerald" },
            { kind: "gauge", key: "cpu", label: "CPU", value: "34%", percent: 34 },
          ]
        : [{ kind: "readout", key: "soon", label: "Not built yet", dim: true }],
  }));
}

function flat(id: string, includeHiddenElements = false) {
  return Object.assign(
    {},
    ...[screen.getByTestId(id, { includeHiddenElements }).props.style].flat(5).filter(Boolean),
  );
}

describe("wide", () => {
  it("puts the first half down the left and the second down the right, numbered in order", () => {
    render(<CoreMenu open narrow={false} panels={panels()} onClose={jest.fn()} />);

    const left = within(screen.getByTestId("core-menu-left"));
    const right = within(screen.getByTestId("core-menu-right"));

    expect(left.getByText("01")).toBeTruthy();
    expect(left.getByText("03")).toBeTruthy();
    expect(left.queryByText("04")).toBeNull();
    expect(right.getByText("04")).toBeTruthy();
    expect(right.getByText("06")).toBeTruthy();
    expect(left.getByText("PANEL ONE")).toBeTruthy();
  });

  it("is out of reach while shut, not only invisible", () => {
    render(<CoreMenu open={false} narrow={false} panels={panels()} onClose={jest.fn()} />);

    expect(screen.queryByText("PANEL ONE")).toBeNull();
    for (const side of ["left", "right"]) {
      expect(flat(`core-menu-${side}`, true).visibility).toBe("hidden");
      expect(flat(`core-menu-${side}`, true).pointerEvents).toBe("none");
    }
  });

  it("slides each column in from its own side, one panel after another", () => {
    const { rerender } = render(
      <CoreMenu open={false} narrow={false} panels={panels()} onClose={jest.fn()} />,
    );

    expect(flat("core-menu-panel-one", true).transform[0].translateX).toBeLessThan(0);
    expect(flat("core-menu-panel-four", true).transform[0].translateX).toBeGreaterThan(0);
    expect(flat("core-menu-panel-one", true).opacity).toBe(0);

    rerender(<CoreMenu open narrow={false} panels={panels()} onClose={jest.fn()} />);

    expect(flat("core-menu-panel-one").transform[0].translateX).toBe(0);
    expect(flat("core-menu-panel-one").opacity).toBe(1);
    expect(flat("core-menu-panel-one").transitionProperty).toBe("opacity, transform");
    const delay = (id: string) => parseInt(flat(id).transitionDelay, 10);
    expect(delay("core-menu-panel-two")).toBeGreaterThan(delay("core-menu-panel-one"));
    expect(delay("core-menu-panel-four")).toBe(delay("core-menu-panel-one"));
  });

  it("reaches a hairline towards the core from every panel, drawn in only while open", () => {
    // Raw SVG, so found by element type: RNTL's testID queries read `testID`.
    const offsets = () => screen.UNSAFE_getAllByType("polyline" as never).map((l) => l.props.style.strokeDashoffset);
    const { rerender } = render(<CoreMenu open={false} narrow={false} panels={panels()} onClose={jest.fn()} />);

    expect(offsets()).toEqual([1, 1, 1, 1, 1, 1]);

    rerender(<CoreMenu open narrow={false} panels={panels()} onClose={jest.fn()} />);
    expect(offsets()).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("places each panel where `spread` puts it", () => {
    render(<CoreMenu open narrow={false} panels={panels()} onClose={jest.fn()} />);

    expect(flat("core-menu-panel-one").position).toBe("absolute");
    expect(flat("core-menu-panel-two").top).toBeGreaterThan(flat("core-menu-panel-one").top);
    expect(flat("core-menu-panel-four").top).toBe(flat("core-menu-panel-one").top);
  });

  it("presses an action row, and not a disabled one", () => {
    const onPress = jest.fn();
    render(<CoreMenu open narrow={false} panels={panels(onPress)} onClose={jest.fn()} />);

    fireEvent.press(screen.getByLabelText("Go"));
    fireEvent.press(screen.getByLabelText("Nope"));

    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("draws readouts and gauges as text, not as buttons", () => {
    render(<CoreMenu open narrow={false} panels={panels()} onClose={jest.fn()} />);

    const one = within(screen.getByTestId("core-menu-panel-one"));
    expect(one.getAllByRole("button")).toHaveLength(2);
    expect(one.getByText("fine")).toBeTruthy();
    expect(one.getByText("34%")).toBeTruthy();
    expect(flat("core-menu-row-one-cpu").flexDirection).toBe("column");
  });

  it("makes a title a button when its panel says so, and draws no rows it does not have", () => {
    const onPress = jest.fn();
    const titled = panels();
    titled[3] = { key: "four", title: "Fitness", rows: [], onPress, accessibilityLabel: "Open Fitness" };
    titled[0] = { ...titled[0], onPress };
    render(<CoreMenu open narrow={false} panels={titled} onClose={jest.fn()} />);

    fireEvent.press(screen.getByLabelText("Open Fitness"));
    // Without a label of its own the title names the button.
    fireEvent.press(screen.getByLabelText("Panel one"));
    expect(onPress).toHaveBeenCalledTimes(2);

    const four = within(screen.getByTestId("core-menu-panel-four"));
    expect(four.getAllByRole("button")).toHaveLength(1);
    expect(four.getByText("FITNESS")).toBeTruthy();
    // A mirrored panel's chevron points back towards the core.
    expect(four.getByText("‹")).toBeTruthy();
  });

  it("leaves a title that does not act as plain text", () => {
    render(<CoreMenu open narrow={false} panels={panels()} onClose={jest.fn()} />);

    expect(screen.queryByTestId("core-menu-title-one")).toBeNull();
    expect(within(screen.getByTestId("core-menu-panel-two")).queryAllByRole("button")).toHaveLength(0);
  });

  it("carries a note under a panel, amber when it is a warning", () => {
    const withNote = panels();
    withNote[2] = { ...withNote[2], note: { text: "Sample stale — 4m ago", warn: true } };
    render(<CoreMenu open narrow={false} panels={withNote} onClose={jest.fn()} />);

    const note = screen.getByText("Sample stale — 4m ago");
    expect(Object.assign({}, ...[note.props.style].flat(3).filter(Boolean)).color).toBe(
      "var(--c-amber)",
    );
  });

  it("carries a note under a title-only panel too", () => {
    // System stats since the Stats overlay: a destination with no rows, whose
    // note still warns when the machine sample has gone stale.
    render(
      <CoreMenu
        open
        narrow={false}
        panels={[
          {
            key: "system",
            title: "System stats",
            right: "DESKTOP-TEST",
            rows: [],
            onPress: jest.fn(),
            accessibilityLabel: "Open Stats",
            note: { text: "Sample stale — 5m ago", warn: true },
          },
        ]}
        onClose={jest.fn()}
      />,
    );

    const panel = within(screen.getByTestId("core-menu-panel-system"));
    expect(panel.getByLabelText("Open Stats")).toBeTruthy();
    expect(panel.getByText("Sample stale — 5m ago")).toBeTruthy();
  });
});

describe("a seventh panel", () => {
  const profile = (onPress = jest.fn()): MenuPanel => ({
    key: "profile",
    title: "Alex Rivera",
    avatar: { uri: null, initials: "AR" },
    rows: [
      { kind: "readout", key: "email", label: "owner@example.com" },
      { kind: "action", key: "sign-out", label: "Sign out", onPress },
    ],
    onPress: jest.fn(),
    accessibilityLabel: "Open Profile",
  });

  it("goes on the right, under the sixth, leaving three on the left", () => {
    render(<CoreMenu open narrow={false} panels={[...panels(), profile()]} onClose={jest.fn()} />);

    const left = within(screen.getByTestId("core-menu-left"));
    const right = within(screen.getByTestId("core-menu-right"));
    expect(left.getByText("03")).toBeTruthy();
    expect(left.queryByText("04")).toBeNull();
    expect(right.getByText("07")).toBeTruthy();
    expect(right.getByText("ALEX RIVERA")).toBeTruthy();

    const top = (key: string) => Object.assign({}, ...[screen.getByTestId(`core-menu-panel-${key}`).props.style].flat(5).filter(Boolean)).top;
    expect(top("profile")).toBeGreaterThan(top("six"));
  });

  it("draws the avatar's initials when there is no photo, and presses its rows", () => {
    const onSignOut = jest.fn();
    render(<CoreMenu open narrow={false} panels={[...panels(), profile(onSignOut)]} onClose={jest.fn()} />);

    expect(within(screen.getByTestId("core-menu-avatar")).getByText("AR")).toBeTruthy();
    fireEvent.press(screen.getByTestId("core-menu-row-profile-sign-out"));
    expect(onSignOut).toHaveBeenCalled();
  });

  it("reaches the core with a hairline of its own", () => {
    render(<CoreMenu open narrow={false} panels={[...panels(), profile()]} onClose={jest.fn()} />);

    // Raw SVG, found by type.
    const groups = screen.UNSAFE_getAllByType("g" as never).map((g) => g.props["data-testid"]);
    expect(groups).toHaveLength(7);
    expect(groups).toContain("core-menu-link-profile");
  });

  it("is last in the column when narrow", () => {
    render(<CoreMenu open narrow panels={[...panels(), profile()]} onClose={jest.fn()} />);

    expect(within(screen.getByTestId("core-menu-single")).getByText("07")).toBeTruthy();
  });
});

describe("an eighth panel", () => {
  const records: MenuPanel = { key: "records", title: "Records", rows: [], onPress: jest.fn() };
  const profile: MenuPanel = { key: "profile", title: "Profile", rows: [], onPress: jest.fn() };

  it("evens the menu: four a side, each left panel level with one on the right", () => {
    render(<CoreMenu open narrow={false} panels={[...panels(), records, profile]} onClose={jest.fn()} />);

    const left = within(screen.getByTestId("core-menu-left"));
    const right = within(screen.getByTestId("core-menu-right"));
    for (const n of ["01", "02", "03", "04"]) expect(left.getByText(n)).toBeTruthy();
    for (const n of ["05", "06", "07", "08"]) expect(right.getByText(n)).toBeTruthy();

    const top = (key: string) =>
      Object.assign({}, ...[screen.getByTestId(`core-menu-panel-${key}`).props.style].flat(5).filter(Boolean)).top;
    // The fourth down the left is level with the last down the right.
    expect(top("four")).toBe(top("profile"));
    expect(top("one")).toBe(top("five"));
  });
});

describe("a ninth panel", () => {
  const records: MenuPanel = { key: "records", title: "Records", rows: [], onPress: jest.fn() };
  const news: MenuPanel = { key: "news", title: "News", rows: [], onPress: jest.fn() };
  const profile: MenuPanel = { key: "profile", title: "Profile", rows: [], onPress: jest.fn() };

  it("goes right: four down the left, five down the right, spread over the same height", () => {
    render(<CoreMenu open narrow={false} panels={[...panels(), records, news, profile]} onClose={jest.fn()} />);

    const left = within(screen.getByTestId("core-menu-left"));
    const right = within(screen.getByTestId("core-menu-right"));
    for (const n of ["01", "02", "03", "04"]) expect(left.getByText(n)).toBeTruthy();
    for (const n of ["05", "06", "07", "08", "09"]) expect(right.getByText(n)).toBeTruthy();

    const top = (key: string) =>
      Object.assign({}, ...[screen.getByTestId(`core-menu-panel-${key}`).props.style].flat(5).filter(Boolean)).top;
    // Five over the height four take: the right column starts higher and ends lower.
    expect(top("five")).toBeLessThan(top("one"));
    expect(top("profile")).toBeGreaterThan(top("four"));
    expect(top("news")).toBeLessThan(top("profile"));
  });
});

describe("narrow", () => {
  it("is one column with no hairlines, over a scrim that closes it", () => {
    const onClose = jest.fn();
    render(<CoreMenu open narrow panels={panels()} onClose={onClose} />);

    expect(screen.queryByTestId("core-menu-left")).toBeNull();
    expect(within(screen.getByTestId("core-menu-single")).getByText("06")).toBeTruthy();
    expect(screen.queryByTestId("core-menu-link-one")).toBeNull();
    expect(screen.getByTestId("core-menu-scrim").props.dataSet).toEqual({ glass: "true" });

    fireEvent.press(screen.getByLabelText("Close the core menu"));
    expect(onClose).toHaveBeenCalled();
  });

  it("has no scrim to press while shut", () => {
    render(<CoreMenu open={false} narrow panels={panels()} onClose={jest.fn()} />);

    expect(screen.queryByLabelText("Close the core menu")).toBeNull();
  });
});

describe("where the panels sit", () => {
  // 1920 x 1000 below the bar: a 720 box, so a sphere of radius 205.
  const geo = spread(1920, 1000, 3, 3);
  const R = 0.285 * 720;
  const dist = ([x, y]: [number, number]) => Math.hypot(x - geo.centre[0], y - geo.centre[1]);

  it("keeps to the window's edges, clear of the corner buttons and off the core", () => {
    for (const link of geo.left) expect(link.from[0]).toBe(80 + 260);
    for (const link of geo.right) expect(link.from[0]).toBe(1920 - 80 - 260);
    for (const link of [...geo.left, ...geo.right]) expect(dist(link.from)).toBeGreaterThan(1.45 * R);
  });

  it("spreads each side high, level and low", () => {
    const [a, b, c] = geo.left.map((l) => l.from[1]);

    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
    expect(b - a).toBe(c - b);
    expect(geo.right.map((l) => l.from[1])).toEqual([a, b, c]);
  });

  it("ends every hairline just outside the sphere and its ring, after running level", () => {
    for (const link of [...geo.left, ...geo.right]) {
      expect(dist(link.to)).toBeCloseTo(1.5 * R, 5);
      expect(link.elbow[1]).toBe(link.from[1]);
      expect(link.elbow[0]).not.toBe(link.from[0]);
    }
  });

  it("goes straight in when there is no room to turn", () => {
    const tight = spread(1100, 1000, 3, 3);
    expect(tight.left[1].elbow).toEqual(tight.left[1].from);
  });
});
