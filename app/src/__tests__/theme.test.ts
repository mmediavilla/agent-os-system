import {
  ACCENT_SPECS,
  ACCENT_TOKENS,
  ColorToken,
  accentFamily,
  hudAccent,
  hudExtras,
  hudPalette,
  injectStylesheet,
  themeStylesheet,
  type,
} from "../theme";
import { ACCENTS } from "../accent";
import { contrast } from "../calendarColors";

const css = themeStylesheet();

describe("themeStylesheet", () => {
  const [rootBlock] = css.match(/^:root\{[^}]*\}/m) ?? [];

  it("declares every color token once, on the root", () => {
    expect(rootBlock).toBeDefined();

    for (const token of Object.keys(hudPalette)) {
      expect(rootBlock).toContain(`--c-${token}:${hudPalette[token as ColorToken]}`);
    }
  });

  it("carries the instrument-only tokens too", () => {
    for (const [token, value] of Object.entries(hudExtras)) {
      expect(rootBlock).toContain(`--h-${token}:${value}`);
    }
  });

  it("has no light or dark theme left to pick", () => {
    // One palette since 11.2: nothing selects on data-theme or the OS setting.
    expect(css).not.toContain("data-theme");
    expect(css).not.toContain("prefers-color-scheme");
    expect(css.match(/--c-bg:/g)).toHaveLength(1);
  });

  it("paints the page behind the app so overscroll isn't white", () => {
    expect(css).toContain("html,body{background-color:var(--c-bg)}");
  });

  it("stops the voice ring for anyone who asked for less motion", () => {
    // The ring is the one moving thing not on a clock — a transform driven by
    // a custom property, which `animation:none` and `transition:none` do not
    // reach. Pinning the property is what stops it.
    expect(css).toMatch(/@media \(prefers-reduced-motion:reduce\)\{\[data-hud\]\{--h-voice:0\}\}/);
  });

  it("declares the keyframes the orb names, and lets them be turned off", () => {
    // The orb asks for these by name; a renamed keyframe is a silently still
    // orb rather than an error.
    for (const name of ["hud-spin", "hud-spin-reverse", "hud-breathe"]) {
      expect(css).toContain(`@keyframes ${name}{`);
    }

    expect(css).toContain(
      "@media (prefers-reduced-motion:reduce){[data-hud] *{animation:none!important;transition:none!important}}",
    );
  });
});

describe("the palette", () => {
  it("keeps surface above bg, so panels still read as raised", () => {
    const luminance = (hex: string) =>
      parseInt(hex.slice(1, 3), 16) + parseInt(hex.slice(3, 5), 16) + parseInt(hex.slice(5, 7), 16);

    expect(luminance(hudPalette.surface)).toBeGreaterThan(luminance(hudPalette.bg));
  });
});

describe("the theme colour", () => {
  const rule = (selector: string) => {
    const at = css.indexOf(`${selector}{`);

    return at < 0 ? undefined : css.slice(at, css.indexOf("}", at) + 1);
  };

  it("publishes nothing for classic, so the default is the palette as it is", () => {
    expect(css).not.toContain('data-accent="classic"');
  });

  it("overrides every accent token, and the accent-coloured extras, on the root", () => {
    for (const [name, hex] of Object.entries(ACCENT_SPECS)) {
      const derived = hudAccent(hex);
      const block = rule(`:root[data-accent="${name}"]`);

      for (const token of ACCENT_TOKENS) {
        expect(block).toContain(`--c-${token}:${derived.family[token]}`);
      }

      // Or a violet app keeps a cyan graticule and cyan panel corners.
      expect(block).toContain(`--h-grid:${derived.grid}`);
      expect(block).toContain(`--h-bracket:${derived.bracket}`);
      expect(block).toContain(`--ch-heat-3:${hex}`);
    }
  });

  it("touches nothing but the accent", () => {
    for (const name of Object.keys(ACCENT_SPECS)) {
      const block = rule(`:root[data-accent="${name}"]`)!;

      expect(block).not.toContain("--c-bg");
      expect(block).not.toContain("--c-amber");
      expect(block).not.toContain("--c-error");
    }
  });

  it("comes after the palette it overrides", () => {
    for (const name of Object.keys(ACCENT_SPECS)) {
      expect(css.indexOf(`:root[data-accent="${name}"]{`)).toBeGreaterThan(css.indexOf(":root{"));
    }
  });

  it("derives the HUD's shades by the formula the classic cyan was tuned to", () => {
    // Run over the classic cyan, the derivation lands within a few units of
    // every hand-tuned value — which is what licenses deriving the others.
    const derived = hudAccent(hudPalette.accent);
    const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const near = (a: string, b: string) =>
      channels(a).every((c, i) => Math.abs(c - channels(b)[i]) <= 8);

    for (const token of ACCENT_TOKENS) {
      expect([token, near(derived.family[token], hudPalette[token])]).toEqual([token, true]);
    }
    expect(near(derived.bracket, hudExtras.bracket)).toBe(true);
  });

  it("keeps a filled button's label legible in every colour", () => {
    // Filled buttons write the ground colour on the accent. White was the ink
    // while indigo was the light theme's accent; on cyan it is under 2:1.
    for (const accent of ACCENTS) {
      expect([accent, contrast(hudPalette.bg, accentFamily(accent).accent) >= 4.5]).toEqual([
        accent,
        true,
      ]);
    }
  });

  it("keeps every accent visible on the panels", () => {
    for (const accent of ACCENTS) {
      expect(contrast(accentFamily(accent).accent, hudPalette.surface)).toBeGreaterThan(3);
    }
  });

  it("reads classic straight off the palette", () => {
    expect(accentFamily("classic").accent).toBe(hudPalette.accent);
    expect(accentFamily("violet").accent).toBe(ACCENT_SPECS.violet);
  });
});

describe("the typography scale", () => {
  it("gives every step a line height, because RN derives none", () => {
    for (const [name, step] of Object.entries(type)) {
      expect([name, "lineHeight" in step]).toEqual([name, true]);
    }
  });

  it("descends without a tie, so two steps are never interchangeable", () => {
    // `label`, `micro` and `readout` are jobs rather than sizes and sit
    // deliberately outside the ramp.
    const ramp = ["display", "title", "heading", "body", "small", "caption"] as const;
    const sizes = ramp.map((step) => type[step].fontSize);

    expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
    expect(new Set(sizes).size).toBe(sizes.length);
  });

  it("gives the telemetry step a monospace family", () => {
    // Digits that change in place jump sideways in a proportional font every
    // time a 1 becomes an 8.
    expect(type.readout.fontFamily).toContain("monospace");
  });
});

describe("injectStylesheet", () => {
  const ID = "test-sheet";

  afterEach(() => document.getElementById(ID)?.remove());

  it("publishes a block once", () => {
    injectStylesheet(ID, "a{color:red}");
    injectStylesheet(ID, "a{color:red}");

    expect(document.querySelectorAll(`#${ID}`)).toHaveLength(1);
  });

  it("rewrites the block when the CSS changes", () => {
    // The bug: it used to return the moment the element existed, which is right
    // in production and quietly wrong under a hot reload — the module re-runs
    // against a document still holding the previous stylesheet, so every
    // palette edit looked like it had done nothing until a hard refresh.
    injectStylesheet(ID, "a{color:red}");
    injectStylesheet(ID, "a{color:blue}");

    expect(document.getElementById(ID)?.textContent).toBe("a{color:blue}");
    expect(document.querySelectorAll(`#${ID}`)).toHaveLength(1);
  });
});
