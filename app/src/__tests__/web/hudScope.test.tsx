import React from "react";
import { render } from "@testing-library/react";
import { Text, View } from "react-native";
import { GLASS_SCOPE, HUD_SCOPE, VERTICAL_SCOPE, themeStylesheet } from "../../theme";
import DateTimeInput from "../../components/DateTimeInput";

/**
 * The `web` Jest project, and the only thing in it.
 *
 * Phase 7.0 measured `jest-expo/web` as a rewrite rather than a switch: under
 * it `react-native` resolves to `react-native-web`, which renders DOM
 * primitives, and RNTL — which matches React Native host components — loses
 * 180 of 405 tests to the query layer alone. Migrating 16 suites and ~700 query
 * calls onto `@testing-library/react` was not worth it, so the suite stayed on
 * the native preset in a jsdom environment.
 *
 * The bill came due here. The HUD's scope, the glass and the vertical spine
 * are all RN-Web's own translation — `dataSet` becoming a `data-*` attribute —
 * and the native preset cannot see it happen. So a second project runs the web
 * preset over this directory alone, and carries the assertions that need a DOM
 * renderer and nothing else.
 *
 * ── What this deliberately does not assert ──────────────────────────────────
 *
 * That `var(--c-bg)` resolves to the navy. It cannot, anywhere in Node:
 * jsdom's CSS object model has no `var()` support, so RN-Web's inline
 * `background-color: var(--c-bg)` is rejected on assignment and the style
 * attribute comes back empty.
 *
 * What is left is the join: the attribute really is written, and the stylesheet
 * really does have a rule that matches an element carrying it, with different
 * values behind it. The last step — a real cascade — is a browser's job and is
 * checked in one.
 */

function stylesheet(): CSSStyleSheet {
  const el = document.createElement("style");
  el.textContent = themeStylesheet();
  document.head.appendChild(el);

  return el.sheet!;
}

it("writes the scope out as a data attribute RN-Web understands", () => {
  const { container } = render(<View {...HUD_SCOPE} />);

  expect(container.querySelector("[data-hud]")).not.toBeNull();
});

it("publishes the palette on the document root", () => {
  // One palette since 11.2, so it is the root's: a modal that portals outside
  // the HUD's container draws in the same colours as everything else.
  const sheet = stylesheet();
  const rule = Array.from(sheet.cssRules).find(
    (r): r is CSSStyleRule => r instanceof CSSStyleRule && r.selectorText === ":root",
  );

  expect(rule).toBeDefined();
  expect(document.documentElement.matches(rule!.selectorText)).toBe(true);
  expect(rule!.style.getPropertyValue("--c-bg")).toBe("#040d18");
});

/**
 * The theme colour rides the same join: `data-accent` is stamped on <html> by
 * ThemeProvider, and the override selects on it. A renamed attribute or a
 * stale selector is an app that silently keeps its classic cyan.
 */
it("recolours the app through the accent stamped on the document", () => {
  const sheet = stylesheet();
  document.documentElement.setAttribute("data-accent", "violet");

  try {
    const rule = Array.from(sheet.cssRules).find(
      (r): r is CSSStyleRule =>
        r instanceof CSSStyleRule && r.selectorText === ':root[data-accent="violet"]',
    );

    expect(rule).toBeDefined();
    expect(document.documentElement.matches(rule!.selectorText)).toBe(true);
    expect(rule!.style.getPropertyValue("--c-accent")).toBe("#c08bff");
  } finally {
    document.documentElement.removeAttribute("data-accent");
  }
});

/**
 * Everything the HUD moves is decorative motion around a state that is also
 * written out in words, so `prefers-reduced-motion` turns all of it off in one
 * rule — and that rule is `[data-hud] *`, which is a join of exactly the same
 * kind: it only reaches the launcher's pill, the breathing state dot beside
 * ASSISTANT and the popover's own transition because those are *inside* the
 * scoped subtree. Anything drawn outside it would keep animating with nothing
 * anywhere reporting it.
 */
it("stops the HUD's motion for anyone who asked, down to the last descendant", () => {
  const sheet = stylesheet();
  const { container } = render(
    <View {...HUD_SCOPE}>
      <View>
        <View testID="dot" />
      </View>
    </View>,
  );

  const media = Array.from(sheet.cssRules).filter(
    (r): r is CSSMediaRule =>
      r instanceof CSSMediaRule && r.conditionText.includes("prefers-reduced-motion"),
  );
  const rule = media
    .flatMap((m) => Array.from(m.cssRules))
    .find((r): r is CSSStyleRule => r instanceof CSSStyleRule && r.selectorText === "[data-hud] *");

  expect(rule).toBeDefined();
  // The state dot's breathe is an inline `animation`, and an inline declaration
  // is only beaten by `!important` — so the rule has to carry one.
  expect(themeStylesheet()).toContain("animation:none!important");

  // Nested two deep, because `*` is a descendant selector and the launcher's
  // dot is further down than its pill.
  const dot = container.querySelector('[data-testid="dot"]') as HTMLElement;
  expect(dot.matches(rule!.selectorText)).toBe(true);
});

/**
 * The overlays' frosted surface rides the same mechanism for a narrower
 * reason: the translucency is a colour and reaches CSS on its own, but the blur
 * behind it is `backdrop-filter`, which React Native has never heard of — so
 * there is no style prop to be confident RN-Web forwards. An attribute and a
 * rule is the reliable way to say it, and this is the join that can rot.
 */
it("writes the glass scope out as a data attribute too", () => {
  const { container } = render(<View {...GLASS_SCOPE} />);

  expect(container.querySelector("[data-glass]")).not.toBeNull();
});

it("has a rule that matches the element the glass scope lands on", () => {
  const sheet = stylesheet();
  const { container } = render(<View {...GLASS_SCOPE} />);
  const el = container.firstElementChild as HTMLElement;

  const rule = Array.from(sheet.cssRules).find(
    (r): r is CSSStyleRule => r instanceof CSSStyleRule && r.selectorText === "[data-glass]",
  );

  expect(rule).toBeDefined();
  expect(el.matches(rule!.selectorText)).toBe(true);
  // Read off the source rather than the CSSOM: jsdom's `cssstyle` drops
  // declarations it does not implement, and `backdrop-filter` is one of them —
  // so asking the parsed rule for it would fail against a stylesheet that is
  // perfectly correct. What is asserted is that the declaration is published.
  expect(themeStylesheet()).toContain("backdrop-filter:blur(");
});

/**
 * The third rider on the mechanism, and the narrowest.
 *
 * The full Assistant's console has ASSISTANT reading up its left edge, which is
 * `writing-mode` — not a React Native style property, exactly as
 * `backdrop-filter` is not, so there is nothing to be confident the style
 * compiler forwards. Same attribute-and-rule answer, same join that can rot.
 */
it("writes the vertical scope out as a data attribute too", () => {
  const { container } = render(<Text {...VERTICAL_SCOPE}>ASSISTANT</Text>);

  expect(container.querySelector("[data-vertical]")).not.toBeNull();
});

it("has a rule that matches the element the vertical scope lands on", () => {
  const sheet = stylesheet();
  const { container } = render(<Text {...VERTICAL_SCOPE}>ASSISTANT</Text>);
  const el = container.firstElementChild as HTMLElement;

  const rule = Array.from(sheet.cssRules).find(
    (r): r is CSSStyleRule => r instanceof CSSStyleRule && r.selectorText === "[data-vertical]",
  );

  expect(rule).toBeDefined();
  expect(el.matches(rule!.selectorText)).toBe(true);
  // Read off the source for the same reason the glass rule is: jsdom's
  // `cssstyle` drops declarations it does not implement, and `writing-mode` is
  // one of them — so the parsed rule would come back empty against a stylesheet
  // that is perfectly correct.
  expect(themeStylesheet()).toContain("writing-mode:vertical-rl");
});
/**
 * The fourth rider, and the one that is not about a style property at all.
 *
 * A date or a time field is the browser's own control, and RN-Web will not be
 * told so: `TextInput` derives the DOM `type` from `inputMode` and friends and
 * then assigns it over whatever was passed, so `DateTimeInput` writes it on the
 * host node instead. Under the native preset there is no host node to write on,
 * which makes this the only place the mechanism can be seen working — and a
 * silent regression here is a field that looks like a text box and quietly
 * accepts anything.
 */
it("hands a date and a time field the browser's own picker", () => {
  const { container } = render(
    <>
      <DateTimeInput kind="date" value="2026-09-25" onChangeText={() => {}} />
      <DateTimeInput kind="time" value="06:30" onChangeText={() => {}} />
    </>,
  );

  const date = container.querySelector('[data-picker="date"]') as HTMLInputElement;
  const time = container.querySelector('[data-picker="time"]') as HTMLInputElement;

  expect(date?.type).toBe("date");
  expect(time?.type).toBe("time");
  // The wire format is what the control holds, so switching the type keeps the
  // value the caller gave it rather than clearing the field.
  expect(date.value).toBe("2026-09-25");
  expect(time.value).toBe("06:30");
});

/**
 * The regression a mount-only assignment shipped, and Chrome found: React's
 * `updateInput` runs on every commit to an input and removes a null `type`, so
 * a picker set once turns back into a text box the first time anything above it
 * re-renders — which, on the Automations card, is a timer.
 */
it("keeps the picker through a re-render", () => {
  const { container, rerender } = render(
    <DateTimeInput kind="time" value="06:30" onChangeText={() => {}} />,
  );

  rerender(<DateTimeInput kind="time" value="07:15" onChangeText={() => {}} />);

  const time = container.querySelector('[data-picker="time"]') as HTMLInputElement;

  expect(time.type).toBe("time");
  expect(time.value).toBe("07:15");
});

it("has a rule that matches the element a picker lands on", () => {
  const sheet = stylesheet();
  const { container } = render(<DateTimeInput kind="time" value="06:30" onChangeText={() => {}} />);
  const el = container.firstElementChild as HTMLElement;

  const rule = Array.from(sheet.cssRules).find(
    (r): r is CSSStyleRule => r instanceof CSSStyleRule && r.selectorText === "[data-picker]",
  );

  expect(rule).toBeDefined();
  expect(el.matches(rule!.selectorText)).toBe(true);
  // Read off the source, as the glass and vertical rules are: `accent-color` is
  // another declaration `cssstyle` drops, and the indicator is a pseudo-element
  // jsdom has no notion of.
  expect(themeStylesheet()).toContain("[data-picker]{accent-color:var(--c-accent)}");
  expect(themeStylesheet()).toContain("::-webkit-calendar-picker-indicator");
});
