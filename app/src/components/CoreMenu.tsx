import React, { useState } from "react";
import { Image, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { GLASS_SCOPE, colors, hud, reachable, spacing, transition, type } from "../theme";

/**
 * The core menu: click the holographic core and nine numbered panels slide
 * in, four down the left and five down the right.
 *
 * A port of the owner's `Core HUD.html`, where the core toggles a "system index".
 * Here it replaces the two rails, which were always open and so cost the core
 * its width all day. The panels are there only when asked for.
 *
 * **This file draws; `Hud` decides.** A panel arrives as data (a title, rows,
 * an optional note), so the menu needs no conversation, no poller and no
 * provider. That keeps its own tests to what it looks like and what a press
 * calls, and it keeps the wiring (which row opens what) beside the state it
 * touches, in `Hud`.
 *
 * **A row either acts or reads.** An `action` is a button, and pressing it is
 * `Hud`'s business, usually opening something and putting the menu away. A
 * `readout` and a `gauge` are live numbers that press nothing. The design drew
 * every row as selectable; a row that selects without doing anything is a
 * control that lies, so readouts are drawn without the button's edge.
 *
 * **A title can act too** (`onPress`), for a panel whose whole job is one
 * destination — Fitness, whose tabs are inside the overlay it opens, so rows
 * naming them would be a second copy of its tab bar. It is drawn with the
 * action rows' edge and a chevron, and its rows may then be empty.
 *
 * **Mounted open and shut**, like every layer on the HUD, because the stagger
 * is a CSS transition and needs both ends. Shut, each column is `reachable`
 * false: invisible *and* unhittable, for the disabled-Pressable reason in
 * RN-Web traps.
 *
 * **Wide, the panels keep to the window's edges and spread down them**
 * (`spread`), so nothing of the menu sits on the core: each reaches in with a
 * hairline that runs level, turns, and ends on a diamond just outside the
 * sphere, the way the owner's reference draws it. They hugged the core until the owner saw
 * them cover it.
 *
 * **Wide, the layer is `box-none`** (in `StyleSheet.create`, where RN-Web
 * polyfills it), so the core between the two columns still takes the click
 * that closes the menu. **Narrow** (under 1100px), two columns either side of a
 * sphere do not fit, so the panels become one scrolling column over a glass
 * scrim, and tapping the scrim closes the menu.
 *
 * **Four a side, level with each other** (the owner's call, when Records made eight):
 * each column spreads its panels over the same height, so an even count puts
 * every left panel level with one on the right. **An odd panel goes on the
 * right** — `floor(n/2)` down the left. News (19.3) made the count nine, so
 * the right column is one longer and spread over the same height; a menu
 * without a signed-in owner, and so without Profile, is even again. Profile,
 * when there is one, is always the last panel (the owner's call).
 */

export type Tone = "accent" | "emerald" | "amber" | "error";

export type MenuRow =
  | {
      kind: "action";
      key: string;
      label: string;
      value?: string;
      onPress: () => void;
      disabled?: boolean;
      /** When the visible label is not the whole name, e.g. "Talk" vs "End the call". */
      accessibilityLabel?: string;
    }
  | { kind: "readout"; key: string; label: string; value?: string; tone?: Tone; dim?: boolean }
  | { kind: "gauge"; key: string; label: string; value: string; percent: number; tone?: Tone };

export type MenuPanel = {
  key: string;
  title: string;
  /** Beside the title, e.g. the machine's host name. */
  right?: string;
  /** May be empty, when the title itself is the panel's one action. */
  rows: MenuRow[];
  /** Under the rows: how old a reading is, or why it could not be taken. */
  note?: { text: string; warn?: boolean };
  /** Makes the title a button: pressing it is `Hud`'s business, like an action row. */
  onPress?: () => void;
  /** When the title alone does not say what the press does. */
  accessibilityLabel?: string;
  /** A picture beside the title: the owner's Google photo, else their initials. */
  avatar?: { uri: string | null; initials: string };
};

export default function CoreMenu({
  open,
  narrow,
  panels,
  onClose,
}: {
  open: boolean;
  narrow: boolean;
  panels: MenuPanel[];
  onClose: () => void;
}) {
  const { width, height } = useWindowDimensions();
  // The layer's own size once it has one; before that, the window less the
  // chrome bar. The menu mounts shut, so the first open is already measured.
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const numbered = panels.map((panel, i) => ({ panel, number: String(i + 1).padStart(2, "0") }));

  if (narrow) {
    return (
      <View style={s.layer} testID="core-menu">
        <Pressable
          {...GLASS_SCOPE}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close the core menu"
          accessibilityElementsHidden={!open}
          importantForAccessibility={open ? "auto" : "no-hide-descendants"}
          style={[s.scrim, transition("opacity, visibility"), { opacity: open ? 1 : 0 }, reachable(open)]}
          testID="core-menu-scrim"
        />

        <Column side="single" open={open}>
          {numbered.map(({ panel, number }, i) => (
            <MenuPanelView key={panel.key} panel={panel} number={number} side="single" open={open} index={i} />
          ))}
        </Column>
      </View>
    );
  }

  const half = Math.floor(numbered.length / 2);
  const left = numbered.slice(0, half);
  const right = numbered.slice(half);
  const geo = spread(size?.width ?? width, size?.height ?? Math.max(0, height - CHROME_H), left.length, right.length);

  return (
    <View
      style={s.layer}
      testID="core-menu"
      onLayout={(e) => {
        const { width: w, height: h } = e.nativeEvent.layout;
        if (w !== size?.width || h !== size?.height) setSize({ width: w, height: h });
      }}
    >
      <Links open={open} links={[...geo.left, ...geo.right]} keys={numbered.map(({ panel }) => panel.key)} />

      <View
        style={[s.banner, transition("opacity", 400), { opacity: open ? 1 : 0 }, reachable(open)]}
        accessibilityElementsHidden={!open}
        importantForAccessibility={open ? "auto" : "no-hide-descendants"}
        aria-hidden={!open}
        testID="core-menu-banner"
      >
        <View style={s.bannerRule} />
        <Text style={s.bannerText}>CORE // SYSTEM INDEX</Text>
        <View style={s.bannerRule} />
      </View>

      <Column side="left" open={open}>
        {left.map(({ panel, number }, i) => (
          <MenuPanelView key={panel.key} panel={panel} number={number} side="left" open={open} index={i} top={geo.left[i].top} />
        ))}
      </Column>

      <Column side="right" open={open}>
        {right.map(({ panel, number }, i) => (
          <MenuPanelView key={panel.key} panel={panel} number={number} side="right" open={open} index={i} top={geo.right[i].top} />
        ))}
      </Column>
    </View>
  );
}

type Side = "left" | "right" | "single";

/** How far each column slides in from, as the design has it. */
const SLIDE = 44;
/** The step between one panel's arrival and the next. */
const STAGGER_MS = 70;

function Column({ side, open, children }: { side: Side; open: boolean; children: React.ReactNode }) {
  const a11y = {
    testID: `core-menu-${side}`,
    accessibilityElementsHidden: !open,
    importantForAccessibility: open ? ("auto" as const) : ("no-hide-descendants" as const),
    "aria-hidden": !open,
  };

  if (side === "single") {
    return (
      <View {...a11y} style={[s.single, transition("visibility", 500), reachable(open)]}>
        <ScrollView
          style={[s.scroll, s.scrollNarrow]}
          contentContainerStyle={[s.scrollInner, s.scrollSingle]}
          showsVerticalScrollIndicator={false}
        >
          {children}
        </ScrollView>
      </View>
    );
  }

  // Wide, each panel is placed by `spread`, so the column is only the strip
  // down its edge that holds them. The column goes out of reach at once; the
  // panels inside carry the visible transition, each on its own delay.
  return (
    <View
      {...a11y}
      style={[s.column, side === "left" ? { left: EDGE } : { right: EDGE }, transition("visibility", 500), reachable(open)]}
    >
      {children}
    </View>
  );
}

/**
 * The hairlines from each panel to the core, in one SVG over the whole layer,
 * because a line that bends between two things placed by `spread` is easiest
 * drawn where both are known. Each draws itself in from the panel's end
 * (`pathLength` 1, dash offset 1 → 0) and its diamond lights at the core.
 * Colours are `var()` tokens in presentation attributes, which Chromium takes.
 */
function Links({ open, links, keys }: { open: boolean; links: Link[]; keys: string[] }) {
  return (
    <View style={s.links} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <svg width="100%" height="100%" aria-hidden="true" focusable="false" style={{ overflow: "visible" }}>
        {links.map((link, i) => {
          const [ax, ay] = link.from;
          const [tx, ty] = link.to;

          return (
            <g key={keys[i]} data-testid={`core-menu-link-${keys[i]}`}>
              <polyline
                points={[link.from, link.elbow, link.to].map((p) => p.join(",")).join(" ")}
                fill="none"
                stroke={colors.accentBd}
                strokeWidth={1}
                pathLength={1}
                strokeDasharray="1 1"
                style={{
                  strokeDashoffset: open ? 0 : 1,
                  transition: `stroke-dashoffset 560ms cubic-bezier(.16,.84,.24,1) ${100 + link.index * STAGGER_MS}ms`,
                }}
               
              />
              <circle cx={ax} cy={ay} r={2} fill={colors.accentBd} style={{ opacity: open ? 1 : 0, transition: "opacity 200ms" }} />
              <rect
                x={tx - 3.5}
                y={ty - 3.5}
                width={7}
                height={7}
                fill={colors.bg}
                stroke={colors.accent}
                strokeWidth={1}
                transform={`rotate(45 ${tx} ${ty})`}
                style={{
                  opacity: open ? 1 : 0,
                  transition: `opacity 240ms ease ${open ? 380 + link.index * STAGGER_MS : 0}ms`,
                }}
              />
            </g>
          );
        })}
      </svg>
    </View>
  );
}

function MenuPanelView({
  panel,
  number,
  side,
  open,
  index,
  top,
}: {
  panel: MenuPanel;
  number: string;
  side: Side;
  open: boolean;
  index: number;
  /** Wide only: where `spread` put it, from the top of the layer. */
  top?: number;
}) {
  const mirrored = side === "right";
  const shift = side === "left" ? -SLIDE : side === "right" ? SLIDE : 0;
  const avatar = panel.avatar ? <Avatar {...panel.avatar} /> : null;

  const badge = (
    <View style={s.badge}>
      <Text style={s.badgeText}>{number}</Text>
    </View>
  );
  const blink = (
    <View
      style={[s.blink, { animation: `hud-blink ${2400 + ((index * 3 + (mirrored ? 5 : 0)) % 7) * 170}ms steps(2) infinite` } as never]}
    />
  );
  const chevron = panel.onPress ? <Text style={s.chevron}>{mirrored ? "‹" : "›"}</Text> : null;
  const head = (lit = false) => (
    <>
      {mirrored ? blink : badge}
      {mirrored && chevron}
      {!mirrored && avatar}
      <Text style={[s.title, mirrored && s.titleRight, lit && s.titleLit]} numberOfLines={1}>
        {panel.title.toUpperCase()}
        {panel.right ? <Text style={s.titleNote}>{`  ${panel.right}`}</Text> : null}
      </Text>
      {mirrored && avatar}
      {!mirrored && chevron}
      {mirrored ? badge : blink}
    </>
  );

  return (
    <View
      testID={`core-menu-panel-${panel.key}`}
      style={[
        s.panel,
        side === "left" && s.panelLeft,
        side === "right" && s.panelRight,
        top !== undefined && { position: "absolute", top },
        transition("opacity, transform", 480, "cubic-bezier(.16,.84,.24,1)"),
        {
          transitionDelay: `${40 + index * STAGGER_MS}ms`,
          opacity: open ? 1 : 0,
          transform: [{ translateX: open ? 0 : shift }],
        } as never,
      ]}
    >
      {panel.onPress ? (
        // The title as a button, drawn like an action row: the same edge, the
        // same hover, and a chevron, so it does not read as a heading that
        // happens to be clickable.
        <Pressable
          onPress={panel.onPress}
          accessibilityRole="button"
          accessibilityLabel={panel.accessibilityLabel ?? panel.title}
          style={({ hovered }: any) => [
            s.head,
            s.headAction,
            mirrored ? s.actionRight : s.actionLeft,
            hovered && s.actionHovered,
          ]}
          testID={`core-menu-title-${panel.key}`}
        >
          {({ hovered }: any) => head(hovered)}
        </Pressable>
      ) : (
        <View style={s.head}>{head()}</View>
      )}

      {panel.rows.length > 0 && (
        <View style={s.rows}>
          {panel.rows.map((row) => (
            <Row key={row.key} row={row} mirrored={mirrored} panel={panel.key} />
          ))}
        </View>
      )}

      {panel.note && (
        <Text style={[s.note, mirrored && s.noteRight, panel.note.warn && s.noteWarn]}>{panel.note.text}</Text>
      )}
    </View>
  );
}

const TONES: Record<Tone, string> = {
  accent: colors.accent,
  emerald: colors.emerald,
  amber: colors.amber,
  error: colors.error,
};

/**
 * A small round picture in a panel's head: the owner's Google photo when there
 * is one, their initials otherwise — and after a photo fails to load, rather
 * than an empty circle that reads as something still arriving.
 */
function Avatar({ uri, initials }: { uri: string | null; initials: string }) {
  const [failed, setFailed] = useState(false);

  return (
    <View style={s.avatar} testID="core-menu-avatar">
      {uri && !failed ? (
        <Image source={{ uri }} style={s.avatarImage} onError={() => setFailed(true)} />
      ) : (
        <Text style={s.avatarText}>{initials}</Text>
      )}
    </View>
  );
}

function Row({ row, mirrored, panel }: { row: MenuRow; mirrored: boolean; panel: string }) {
  const testID = `core-menu-row-${panel}-${row.key}`;
  const marker = (
    <View style={[s.marker, row.kind !== "action" && row.tone ? { backgroundColor: TONES[row.tone] } : null]} />
  );
  const value = row.value ? (
    <Text style={[s.value, mirrored && s.valueRight]} numberOfLines={1}>
      {row.value}
    </Text>
  ) : null;
  const label = (lit = false) => (
    <Text
      style={[s.label, mirrored && s.labelRight, lit && s.labelLit, row.kind === "readout" && row.dim && s.labelDim]}
      numberOfLines={1}
    >
      {row.label}
    </Text>
  );
  const line = (lit?: boolean) =>
    mirrored ? (
      <>
        {value}
        {label(lit)}
        {marker}
      </>
    ) : (
      <>
        {marker}
        {label(lit)}
        {value}
      </>
    );

  if (row.kind === "action") {
    return (
      <Pressable
        onPress={row.onPress}
        disabled={row.disabled}
        accessibilityRole="button"
        accessibilityLabel={row.accessibilityLabel ?? row.label}
        accessibilityState={{ disabled: !!row.disabled }}
        style={({ hovered }: any) => [
          s.row,
          s.action,
          mirrored ? s.actionRight : s.actionLeft,
          hovered && !row.disabled && s.actionHovered,
          row.disabled && s.actionDisabled,
        ]}
        testID={testID}
      >
        {({ hovered }: any) => line(hovered && !row.disabled)}
      </Pressable>
    );
  }

  if (row.kind === "gauge") {
    return (
      <View style={[s.row, s.gauge]} testID={testID}>
        <View style={[s.gaugeHead, mirrored && s.gaugeHeadRight]}>{line()}</View>
        <View style={s.track}>
          <View
            style={[
              s.fill,
              mirrored && s.fillRight,
              {
                width: `${Math.max(0, Math.min(100, row.percent))}%`,
                backgroundColor: TONES[row.tone ?? "accent"],
              },
            ]}
          />
        </View>
      </View>
    );
  }

  return (
    <View style={[s.row, mirrored && s.rowRight]} testID={testID}>
      {line()}
    </View>
  );
}

type Point = [number, number];

/** One panel's hairline: level from `from` to `elbow`, then in to `to`. */
export type Link = { top: number; from: Point; elbow: Point; to: Point; index: number };

/**
 * Where each wide panel sits and how its hairline reaches the core, from the
 * layer's size alone.
 *
 * **The panels keep to the window's edges** (`EDGE` in), and each column's
 * panels are spread down the height under the banner, one to an equal slot,
 * so three a side land high, level and low, as in the owner's reference.
 *
 * **The core is not measured.** Its box is square and takes the stage's height
 * less its padding and what sits under it (the buttons, the caption and the
 * hint), capped at 720 and at the width, and the stage centres the lot. The
 * sphere's radius is 285 of that box and the click ring sits at 1.1R, so a
 * hairline ends on its diamond at `REACH` radii, outside both.
 *
 * **Each hairline runs level, then turns for the centre.** The turn is part of
 * the way across the gap, and the last leg points at the centre, so the
 * diamonds sit round the sphere like the ends of spokes. When the gap is too
 * short for a turn, the line goes straight in.
 */
export function spread(width: number, height: number, leftCount: number, rightCount: number) {
  const box = Math.max(0, Math.min(720, height - 2 * STAGE_PAD - UNDER_CORE_H, width - 2 * STAGE_PAD));
  const centre: Point = [width / 2, (height - UNDER_CORE_H) / 2];
  const reach = REACH * 0.285 * box;
  const span = Math.max(0, height - TOP_CLEAR - BOTTOM_CLEAR);

  const column = (count: number, side: "left" | "right"): Link[] =>
    Array.from({ length: count }, (_, index) => {
      const mid = Math.round(TOP_CLEAR + ((index + 0.5) * span) / count);
      const x = side === "left" ? EDGE + PANEL_W : width - EDGE - PANEL_W;
      const from: Point = [x, mid];
      const gap = Math.abs(centre[0] - x) - reach;
      const elbow: Point = gap > 2 * MIN_RUN ? [x + (side === "left" ? 1 : -1) * Math.max(MIN_RUN, gap * TURN), mid] : from;
      const dx = elbow[0] - centre[0];
      const dy = elbow[1] - centre[1];
      const d = Math.hypot(dx, dy) || 1;
      const to: Point = [centre[0] + (dx / d) * reach, centre[1] + (dy / d) * reach];

      return { top: mid - HEAD_MID, from, elbow, to, index };
    });

  return { centre, left: column(leftCount, "left"), right: column(rightCount, "right") };
}

/** The chrome bar over the HUD, roughly: the layer's height before it is measured. */
const CHROME_H = 80;
/** The stage's own padding. */
const STAGE_PAD = spacing.lg;
/** Under the core: the camera and microphone buttons, the caption and the hint. */
const UNDER_CORE_H = 118;
/** Where a hairline ends, in sphere radii: well clear of the click ring at 1.1R, so the diamonds sit apart from the core. */
const REACH = 1.5;
/** How far across the gap a hairline turns, and the least it runs level first. */
const TURN = 0.45;
const MIN_RUN = 24;
/** The banner, and a gutter under it. */
const TOP_CLEAR = 56;
const BOTTOM_CLEAR = 40;
/** From a panel's top to the middle of its badge, where its hairline leaves. */
const HEAD_MID = 15;

const PANEL_W = 260;
/**
 * In from the window edge: clear of the corner buttons (24 + 40) with a gutter,
 * because they sit above this layer and would cover a panel's badge.
 */
const EDGE = spacing["2xl"] + 40 + spacing.lg;

const s = StyleSheet.create({
  // Over the core's column, under the corner buttons (5) and the glass
  // overlays (6). `box-none`, polyfilled here, so the core between the two
  // columns still takes a click.
  layer: { ...StyleSheet.absoluteFillObject, zIndex: 4, pointerEvents: "box-none" },

  banner: {
    position: "absolute",
    top: spacing.lg,
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.md,
  },
  bannerRule: { width: 64, height: 1, backgroundColor: colors.accentBd },
  bannerText: { ...type.label, letterSpacing: 4, color: colors.text },

  column: { position: "absolute", top: 0, bottom: 0, width: PANEL_W },
  links: { ...StyleSheet.absoluteFillObject, pointerEvents: "none" },
  single: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: spacing.lg,
    right: spacing.lg,
    alignItems: "center",
    pointerEvents: "box-none",
  },
  scroll: { flex: 1, alignSelf: "stretch" },
  scrollInner: { flexGrow: 1, justifyContent: "center", gap: spacing.xl, paddingVertical: spacing.xl },
  scrollSingle: { alignItems: "center" },
  // As wide as a panel, so a tap beside the column lands on the scrim.
  scrollNarrow: { width: PANEL_W, maxWidth: "100%", alignSelf: "center" },

  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: hud.veil },

  panel: { width: PANEL_W, maxWidth: "100%", gap: spacing.sm },
  panelLeft: { alignSelf: "flex-start" },
  panelRight: { alignSelf: "flex-end" },

  head: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  badge: {
    borderWidth: 1,
    borderColor: colors.accentBd,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  badgeText: { ...type.readout, fontSize: 20, lineHeight: 24, fontWeight: "700", color: colors.accent },
  title: { ...type.label, letterSpacing: 3, color: colors.accentTxt, flex: 1 },
  titleRight: { textAlign: "right" },
  titleLit: { color: colors.accent },
  // The badge sits on the row's edge, so the button needs a little room inside.
  headAction: { backgroundColor: colors.surface, borderColor: colors.border, paddingRight: spacing.sm },
  chevron: { ...type.readout, fontSize: 14, lineHeight: 18, color: colors.textMuted },
  titleNote: { ...type.micro, letterSpacing: 1, color: colors.textDim },
  blink: { width: 6, height: 6, backgroundColor: colors.accent },
  avatar: {
    width: 22,
    height: 22,
    borderRadius: 11,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: colors.accentBd,
    backgroundColor: colors.accentBg,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarImage: { width: "100%", height: "100%" },
  avatarText: { ...type.micro, fontWeight: "700", color: colors.accentTxt },

  rows: { gap: 3 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: 5,
    paddingHorizontal: spacing.sm,
  },
  rowRight: { justifyContent: "flex-end" },
  action: { backgroundColor: colors.surface, borderColor: colors.border },
  actionLeft: { borderLeftWidth: 2 },
  actionRight: { borderRightWidth: 2 },
  actionHovered: { backgroundColor: colors.accentBg, borderColor: colors.accent },
  actionDisabled: { opacity: 0.45 },

  marker: { width: 5, height: 5, backgroundColor: colors.textDim },
  label: { ...type.caption, letterSpacing: 1, color: colors.text, flex: 1 },
  labelRight: { textAlign: "right" },
  labelLit: { color: colors.accentTxt },
  labelDim: { color: colors.textDim },
  value: { ...type.readout, fontSize: 11, lineHeight: 16, color: colors.textMuted, flexShrink: 1 },
  valueRight: { textAlign: "left" },

  gauge: { flexDirection: "column", alignItems: "stretch", gap: 4 },
  gaugeHead: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  gaugeHeadRight: { justifyContent: "flex-end" },
  track: { height: 3, backgroundColor: colors.border, overflow: "hidden" },
  fill: { height: "100%" },
  fillRight: { alignSelf: "flex-end" },

  note: { ...type.micro, letterSpacing: 1, color: colors.textDim },
  noteRight: { textAlign: "right" },
  noteWarn: { color: colors.amber },
});
