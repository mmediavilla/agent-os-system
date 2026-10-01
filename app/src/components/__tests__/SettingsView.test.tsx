import React from "react";
import { StyleSheet } from "react-native";
import { fireEvent, render, within } from "@testing-library/react-native";
import Settings from "../SettingsView";
import { ThemeProvider } from "../../ThemeProvider";
import { UnitsProvider } from "../../UnitsProvider";
import { api } from "../../api";
import { ACCENTS, ACCENT_LABELS, Accent } from "../../accent";
import { accentFamily, hudPalette } from "../../theme";
import { DIMENSION_LABELS } from "../../units";

// The Calendars section reads its list on mount. Its behaviour is
// `CalendarSettings.test`'s; here it only has to not reach for the network.
beforeEach(() => {
  jest.spyOn(api, "listCalendarFeeds").mockResolvedValue({ data: [] });
});

afterEach(() => {
  jest.restoreAllMocks();
});

const renderSettings = () =>
  render(
    <ThemeProvider>
      <UnitsProvider>
        <Settings />
      </UnitsProvider>
    </ThemeProvider>,
  );

/**
 * The radios of one group.
 *
 * Every group on the screen uses the same role, so a bare `getAllByRole` would
 * pick up the unit options as well as the theme colours — and each group has
 * a selection, so "exactly one is selected" is only true within a group.
 */
const groupRadios = (screen: ReturnType<typeof renderSettings>, label: string) =>
  within(screen.getByLabelText(label)).getAllByRole("radio");

const selectedIn = (screen: ReturnType<typeof renderSettings>, label: string) =>
  groupRadios(screen, label).filter((r) => r.props.accessibilityState?.selected);

it("offers no light or dark theme", () => {
  // One palette since 11.2; the theme colour is the only look left to choose.
  const screen = renderSettings();

  expect(screen.queryByLabelText("Appearance")).toBeNull();
  expect(screen.queryByText("System")).toBeNull();
  expect(screen.getByText("Appearance")).toBeTruthy();
});

// ── Theme colour ──────────────────────────────────────────────────────────────

describe("the theme colour", () => {
  afterEach(() => document.documentElement.removeAttribute("data-accent"));

  it("offers every colour, starting on classic", () => {
    const screen = renderSettings();

    expect(groupRadios(screen, "Theme color")).toHaveLength(ACCENTS.length);
    expect(selectedIn(screen, "Theme color")[0]).toHaveTextContent(
      new RegExp(`^${ACCENT_LABELS.classic}`),
    );
  });

  it("stamps the choice on the document, where the stylesheet reads it", () => {
    const screen = renderSettings();
    expect(document.documentElement.getAttribute("data-accent")).toBe("classic");

    fireEvent.press(screen.getByText(ACCENT_LABELS.violet));

    expect(document.documentElement.getAttribute("data-accent")).toBe("violet");
    expect(selectedIn(screen, "Theme color")[0]).toHaveTextContent(
      new RegExp(`^${ACCENT_LABELS.violet}`),
    );
  });

  it("remembers the choice across a reload", () => {
    const first = renderSettings();
    fireEvent.press(first.getByText(ACCENT_LABELS.mint));
    first.unmount();

    const second = renderSettings();
    expect(selectedIn(second, "Theme color")[0]).toHaveTextContent(
      new RegExp(`^${ACCENT_LABELS.mint}`),
    );
  });

  it("draws each option in its own colour, not in the one already chosen", () => {
    // Inside the app `colors.accent` is the current choice, so a chip painted
    // from it would show the same colour on every row.
    const screen = renderSettings();

    const chip = (accent: Accent) =>
      StyleSheet.flatten(
        screen.getByTestId(`accent-chip-${accent}`, { includeHiddenElements: true }).props.style,
      ).backgroundColor;

    expect(chip("violet")).toBe(accentFamily("violet").accent);
    expect(chip("classic")).toBe(hudPalette.accent);
  });

  it("paints the preview in the chosen colour", () => {
    const screen = renderSettings();
    fireEvent.press(screen.getByText(ACCENT_LABELS.mint));

    const fill = StyleSheet.flatten(screen.getByTestId("settings-preview-button").props.style)
      .backgroundColor;

    expect(fill).toBe(accentFamily("mint").accent);
  });
});

// ── Units ─────────────────────────────────────────────────────────────────────

it("leaves the units to Fitness → Settings, and says where they went", () => {
  const screen = renderSettings();

  Object.values(DIMENSION_LABELS).forEach((label) => {
    expect(screen.queryByLabelText(label)).toBeNull();
  });
  expect(screen.getByText(/units are under Fitness → Settings/)).toBeTruthy();
});

it("leaves the Anthropic switch to Assistant → Settings, and says where it went", () => {
  const screen = renderSettings();

  expect(screen.queryByTestId("anthropic-toggle")).toBeNull();
  expect(screen.getByText(/Anthropic API switch is under Assistant → Settings/)).toBeTruthy();
});

// ── The preview ───────────────────────────────────────────────────────────────

describe("the preview", () => {
  const ground = (screen: ReturnType<typeof renderSettings>) =>
    StyleSheet.flatten(screen.getByTestId("settings-preview").props.style).backgroundColor;

  it("is painted from the palette", () => {
    expect(ground(renderSettings())).toBe(hudPalette.bg);
  });

  it("carries no units, since they are chosen elsewhere", () => {
    const screen = renderSettings();

    expect(screen.getByText("3 × 8")).toBeTruthy();
    expect(screen.queryByText(/kg/)).toBeNull();
  });
});
