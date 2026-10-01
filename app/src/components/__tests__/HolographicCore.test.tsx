import React from "react";
import { render } from "@testing-library/react-native";
import HolographicCore from "../HolographicCore";
import { OrbState } from "../AssistantOrb";
import { colors } from "../../theme";

/**
 * The holographic core, ported from the owner's design canvas.
 *
 * The design is a demo reel on an authored timeline; this is four states with
 * no timeline. So what is worth asserting is not that it looks like the
 * original — a picture cannot be read out of a tree — but the three things the
 * port had to get right and could silently lose:
 *
 * - the state still has a name, and the two that must not move still do not;
 * - the rotation survived being re-expressed as CSS, in the one place it is
 *   easy to break: eight meridians that are supposed to be spread around the
 *   turn and would stack into a single line if the stagger went missing;
 * - the states are told apart by more than a tint.
 */

type Node = { type: string; props: Record<string, any>; children?: (Node | string)[] };

function nodes(state?: OrbState): Node[] {
  const tree = render(<HolographicCore state={state} />).toJSON() as unknown as Node;
  const found: Node[] = [];

  (function walk(node: Node | string | null) {
    if (!node || typeof node === "string") return;
    found.push(node);
    (node.children ?? []).forEach(walk);
  })(tree);

  return found;
}

const of = (state: OrbState | undefined, type: string) =>
  nodes(state).filter((n) => n.type === type);

it("names its state, because that is all a screen reader gets", () => {
  expect(render(<HolographicCore state="idle" />).getByLabelText("Assistant idle")).toBeTruthy();
  expect(
    render(<HolographicCore state="working" />).getByLabelText("Assistant working"),
  ).toBeTruthy();
  expect(
    render(<HolographicCore state="awaiting" />).getByLabelText("Assistant waiting for you"),
  ).toBeTruthy();
  expect(render(<HolographicCore state="failed" />).getByLabelText("Assistant failed")).toBeTruthy();
});

it("can be drawn without being announced", () => {
  // Drawn, and hidden from assistive technology — so it takes
  // `includeHiddenElements` to find, which is the assertion.
  const q = render(<HolographicCore state="idle" decorative />);

  expect(q.queryByLabelText("Assistant idle")).toBeNull();
  expect(q.queryByTestId("holographic-core")).toBeNull();
  expect(q.getByTestId("holographic-core", { includeHiddenElements: true })).toBeTruthy();
});

it("holds completely still in the states that must not suggest activity", () => {
  // Same rule the small orb follows: an approval card below a turning sphere
  // says the work is still going on.
  for (const state of ["awaiting", "failed"] as OrbState[]) {
    const moving = nodes(state).filter((n) => n.props.style?.animation);

    expect([state, moving.length]).toEqual([state, 0]);
  }
});

it("keeps turning, in amber, while it is switched off", () => {
  // Awaiting's colour without awaiting's stillness: a decision, not a fault,
  // and no approval card beside it for motion to contradict.
  const q = render(<HolographicCore state="off" />);
  const tint = of("off", "circle").find((c) => c.props.strokeWidth === "2")!.props.stroke;

  expect(q.getByLabelText("Assistant switched off")).toBeTruthy();
  expect(tint).toBe(colors.amber);
  expect(nodes("off").some((n) => String(n.props.style?.animation).includes("hud-spin"))).toBe(true);
  expect(nodes("off").some((n) => String(n.props.style?.animation).includes("hud-core-scan"))).toBe(
    false,
  );
});

it("turns while it is idle, and faster while it is working", () => {
  const period = (state: OrbState) => {
    const spun = nodes(state).find((n) => String(n.props.style?.animation).includes("hud-spin"));

    return Number(String(spun!.props.style.animation).match(/([\d.]+)s/)![1]);
  };

  expect(period("working")).toBeLessThan(period("idle"));
});

it("spreads the meridians around the turn rather than stacking them", () => {
  // The rotation is eight ellipses squeezed on a stagger. Lose the stagger and
  // they collapse onto one line, which still renders and still animates — so
  // nothing else in this file would notice.
  const delays = nodes("idle")
    .map((n) => n.props.style?.animationDelay)
    .filter(Boolean);

  expect(delays).toHaveLength(8);
  expect(new Set(delays).size).toBe(8);
});

it("keeps a still sphere looking like a sphere", () => {
  // Frozen, the meridians get a hand-placed scale instead of an animation.
  // All of them at the same scale is eight lines on top of each other.
  const scales = nodes("awaiting")
    .map((n) => String(n.props.style?.transform ?? ""))
    .filter((t) => t.startsWith("scaleX"));

  expect(scales).toHaveLength(8);
  expect(new Set(scales).size).toBeGreaterThan(4);
});

it("sweeps the sphere only while it is thinking", () => {
  const scanning = (state: OrbState) =>
    nodes(state).some((n) => String(n.props.style?.animation).includes("hud-core-scan"));

  expect(scanning("working")).toBe(true);
  expect(scanning("idle")).toBe(false);
  expect(scanning("awaiting")).toBe(false);
});

it("tells the states apart by brightness as well as by colour", () => {
  // Everything in the drawing is scaled by one energy figure. If two states
  // shared it, the difference between them would be a hue nobody reads at a
  // glance.
  const outline = (state: OrbState) =>
    of(state, "circle").find((c) => c.props.strokeWidth === "2")!.props.opacity;

  expect(outline("working")).toBeGreaterThan(outline("idle"));
  expect(outline("idle")).toBeGreaterThan(outline("failed"));
});

it("takes its tints from the theme, so it re-themes inside the HUD", () => {
  const tint = (state: OrbState) =>
    of(state, "circle").find((c) => c.props.strokeWidth === "2")!.props.stroke;

  expect(tint("idle")).toBe(colors.accent);
  expect(tint("awaiting")).toBe(colors.amber);
  expect(tint("failed")).toBe(colors.error);
});

it("gives each instance its own gradients and filters", () => {
  // Two cores in one document would otherwise share the first one's nucleus
  // and bloom — the same trap the two orbs have.
  const idsOf = (tree: Node[]) =>
    tree.map((n) => n.props.id).filter((id): id is string => typeof id === "string");

  const a = idsOf(nodes("idle"));
  const b = idsOf(nodes("failed"));

  expect(a.length).toBeGreaterThan(0);
  expect(a.some((id) => b.includes(id))).toBe(false);
});

describe("the two states added for later", () => {
  it("names them, so the preview row is not the only way to tell", () => {
    expect(
      render(<HolographicCore state="listening" />).getByLabelText("Assistant listening"),
    ).toBeTruthy();
    expect(
      render(<HolographicCore state="responding" />).getByLabelText("Assistant answering"),
    ).toBeTruthy();
  });

  it("gives each busy state one layer of its own", () => {
    // Three states share a tint, so the layer is the only thing telling them
    // apart. Turning on the wrong one — or two at once — is the failure.
    const layers = (state: OrbState) => {
      const names = nodes(state)
        .map((n) => String(n.props.style?.animation ?? ""))
        .filter((a) => a.includes("hud-core-"));

      return new Set(
        names.map((a) => a.split(" ")[0]).filter((n) => n !== "hud-core-meridian"),
      );
    };

    expect(layers("listening")).toEqual(new Set(["hud-core-voice", "hud-core-pulse"]));
    expect(layers("working")).toEqual(new Set(["hud-core-scan", "hud-core-pulse"]));
    expect(layers("responding")).toEqual(new Set(["hud-core-shock", "hud-core-pulse"]));
    expect(layers("idle")).toEqual(new Set(["hud-core-pulse"]));
  });

  it("varies the voice bars' periods, not just their delays", () => {
    // A shared duration on a stagger is a wave travelling round the ring. A
    // voice is bars moving at their own rates.
    const bars = nodes("listening")
      .map((n) => String(n.props.style?.animation ?? ""))
      .filter((a) => a.includes("hud-core-voice"));

    expect(bars.length).toBeGreaterThan(40);
    expect(new Set(bars).size).toBeGreaterThan(20);
  });

  it("scales each voice bar from the sphere's edge, not its middle", () => {
    // About the middle, the ring detaches from the sphere and grows inwards
    // through it as well as out.
    const origins = nodes("listening")
      .map((n) => n.props.style?.transformOrigin)
      .filter((o): o is string => typeof o === "string" && o !== "50% 50%");

    expect(new Set(origins).size).toBe(1);
    expect([...new Set(origins)][0]).toMatch(/^500px \d/);
  });

  it("staggers the shockwaves so they read as three, not one thick ring", () => {
    const delays = nodes("responding")
      .filter((n) => String(n.props.style?.animation ?? "").includes("hud-core-shock"))
      .map((n) => n.props.style.animationDelay);

    expect(delays).toEqual(["0s", "0.45s", "0.9s"]);
  });
});

describe("the scan plane's geometry", () => {
  /** The keyframes as the browser receives them, from the injected stylesheet. */
  const scanBlock = () => {
    const css = document.getElementById("projectmc-hud-core")?.textContent ?? "";

    return css.match(/@keyframes hud-core-scan \{([\s\S]*?)\n\}/)![1];
  };

  it("follows the sphere's silhouette rather than a straight line", () => {
    // The bug this replaces: three stops written by hand, with CSS interpolating
    // `scaleX` linearly against `translateY`. A circle is not linear — a quarter
    // of the way down the true half-width is 0.866R and linear gives 0.52R — so
    // the plane pinched shut long before it reached the pole.
    const stops = [...scanBlock().matchAll(/translateY\((-?[\d.]+)px\) scale\(([\d.]+)\)/g)].map(
      (m) => ({ dy: Number(m[1]), scale: Number(m[2]) }),
    );

    expect(stops.length).toBeGreaterThanOrEqual(9);

    const R = Math.max(...stops.map((s) => Math.abs(s.dy)));

    for (const { dy, scale } of stops) {
      const truth = Math.sqrt(Math.max(0, 1 - (dy / R) ** 2));

      // Every stop sits on the circle, not on the chord between the ends.
      expect([dy, Number(scale.toFixed(2))]).toEqual([dy, Number(Math.max(0.02, truth).toFixed(2))]);
    }
  });

  it("is widest at the equator and shut at both poles", () => {
    const scales = [...scanBlock().matchAll(/scale\(([\d.]+)\)/g)].map((m) => Number(m[1]));

    expect(scales[0]).toBeLessThan(0.05);
    expect(scales[scales.length - 1]).toBeLessThan(0.05);
    expect(Math.max(...scales)).toBe(1);
    expect(scales[Math.floor(scales.length / 2)]).toBe(1);
  });

  it("sweeps at a constant rate", () => {
    // Eased, it would loiter as a dot at each pole — which is where it is
    // smallest — and hurry through the middle, where there is something to see.
    const css = document.getElementById("projectmc-hud-core")?.textContent ?? "";

    expect(css).toContain("hud-core-scan");
    expect(nodes("working").some((n) => /hud-core-scan[^"]*linear/.test(String(n.props.style?.animation)))).toBe(
      true,
    );
  });

  it("shrinks in both directions, so it never hangs off the pole", () => {
    // Scaling only X left the plane 0.3R tall at the north pole — a lens
    // sticking out of the top of the sphere by exactly the half-height it
    // should no longer have had. A cross-section is a circle: both axes go
    // together, which is one uniform `scale()` rather than a `scaleX()`.
    const block = scanBlock();

    expect(block).not.toMatch(/scaleX\(/);
    expect(block).toMatch(/scale\(/);
  });
});

// ── the voice ring ───────────────────────────────────────────────────────────

/** Every node in a core rendered with a real microphone behind it, or without. */
function ringNodes(driven: boolean): Node[] {
  const tree = render(
    <HolographicCore state="listening" voiceDriven={driven} />,
  ).toJSON() as unknown as Node;
  const found: Node[] = [];

  (function walk(node: Node | string | null) {
    if (!node || typeof node === "string") return;
    found.push(node);
    (node.children ?? []).forEach(walk);
  })(tree);

  return found;
}

const bars = (driven: boolean) =>
  ringNodes(driven)
    .map((n) => String(n.props.style?.transform ?? ""))
    .filter((t) => t.startsWith("scaleY"));

it("shows a ring of bars only while it is listening", () => {
  const lines = (state: OrbState) => of(state, "line").length;

  expect(lines("listening")).toBeGreaterThan(50);
  expect(lines("idle")).toBe(0);
});

it("moves the bars with the microphone rather than with a clock", () => {
  // The debt 7.1 wrote down: a ring rippling on its own timer looks alive and
  // looks exactly as alive in silence, which tells the user they are being
  // heard when they are not.
  const driven = bars(true);

  expect(driven).toHaveLength(56);
  driven.forEach((t) => expect(t).toContain("var(--h-voice, 0)"));
  expect(
    ringNodes(true).some((n) => String(n.props.style?.animation).includes("hud-core-voice")),
  ).toBe(false);
});

it("answers one amplitude by different amounts, so 56 bars are not one bar", () => {
  // Real audio is a single number. Without a per-bar gain it would move every
  // bar in lockstep — a clean pulsing ring, which is not what a voice is.
  expect(new Set(bars(true)).size).toBeGreaterThan(20);
});

it("leaves a still stub in the silence rather than nothing at all", () => {
  // A ring that vanishes completely is indistinguishable from one that is not
  // there, and "listening, hearing nothing" is a different thing to say.
  bars(true).forEach((t) => expect(t).toContain("scaleY(calc(0.06 +"));
});

it("keeps the old clock for a state with no microphone behind it", () => {
  // The HUD's preview row can select `listening` with nothing plugged in.
  // There the ripple is the right picture, because nothing is claiming to hear.
  expect(bars(false)).toHaveLength(0);
  expect(
    ringNodes(false).filter((n) => String(n.props.style?.animation).includes("hud-core-voice")),
  ).toHaveLength(56);
});
