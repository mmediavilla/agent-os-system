import React from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import CalendarSettings from "./CalendarSettings";
import { RadioGroup, settingsStyles } from "./SettingsParts";
import { useAccent } from "../ThemeProvider";
import { ACCENTS, ACCENT_LABELS, Accent } from "../accent";
import { Palette, accentFamily, hudPalette, radii, spacing } from "../theme";

/** What each theme colour is, in words beside its chip. */
const ACCENT_DESCRIPTIONS: Record<Accent, string> = {
  classic: "Cyan, the instrument's own.",
  mint: "Green, the color the core was drawn in.",
  azure: "Sky blue.",
  violet: "Violet.",
};

/**
 * The app's settings, drawn inside the HUD's Settings overlay. Two things are
 * not here any more: the units moved to Fitness → Settings (`FitnessSettings`)
 * in 12.0, and the Anthropic switch to Assistant → Settings
 * (`AssistantSettings`) in 13.0 — each beside the only thing it changes.
 *
 * This was a screen, reached from a Settings button in the menu, and it moved
 * for the reason the Assistant and the Calendar did: **a screen replaces the
 * HUD**, which is the thing this app is built to leave open. So it opens from
 * the HUD's core menu (the Core panel), and this view is what the glass overlay
 * it opens holds.
 *
 * It draws no header and no ground of its own. The overlay has a spine reading
 * SETTINGS and its own close button, and it is glass over a HUD meant to stay
 * visible through it — a title here would be the same word twice, and a
 * background colour would paint the glass back out. The cards keep their
 * surface, because nothing carrying text is glass.
 */
export default function SettingsView({
  active = true,
  onCalendarsChanged,
}: {
  /** Whether the overlay holding this is open — the calendar list reads on it. */
  active?: boolean;
  onCalendarsChanged?: () => void;
}) {
  const { accent, setAccent } = useAccent();

  return (
    <View style={s.root}>
      <ScrollView contentContainerStyle={s.body}>
        <View style={s.section} testID="settings-calendars">
          <Text style={s.sectionLabel}>Calendars</Text>
          <CalendarSettings active={active} onChanged={onCalendarsChanged} />
        </View>

        <View style={s.section}>
          <Text style={s.sectionLabel}>Appearance</Text>

          <View style={s.group}>
            <Text style={s.groupLabel}>Theme color</Text>
            <RadioGroup
              groupLabel="Theme color"
              options={ACCENTS}
              selected={accent}
              labelFor={(a) => ACCENT_LABELS[a]}
              descriptionFor={(a) => ACCENT_DESCRIPTIONS[a]}
              leadingFor={(a) => <AccentChip accent={a} />}
              onSelect={setAccent}
            />
            <Text style={s.footnote}>
              There's no orange or red on purpose: amber is the assistant waiting for
              you and red is it failing, and an accent in either would hide both.
            </Text>
          </View>

          <Text style={s.footnote}>
            Weight, distance and body measurement units are under Fitness → Settings,
            and the Anthropic API switch is under Assistant → Settings.
          </Text>
        </View>

        <Preview />
      </ScrollView>
    </View>
  );
}

/**
 * What the theme colour looks like: a workout card of the sort the Workouts
 * screen draws.
 *
 * Painted from the hex palette rather than `colors.*`, so a test can read the
 * colours it was given. Its rows carry no units — those are previewed in
 * Fitness → Settings, where they are chosen.
 */
function Preview() {
  const { accent } = useAccent();
  // The theme colour rides on top, from the same hex tables the stylesheet is
  // built from.
  const p: Palette = { ...hudPalette, ...accentFamily(accent) };

  const rows = [
    { label: "Bench press", value: "3 × 8" },
    { label: "Treadmill", value: "30 min" },
    { label: "Plank", value: "3 × 60 s" },
  ];

  return (
    <View style={s.section}>
      <Text style={s.sectionLabel}>Preview</Text>

      <View
        style={[s.sample, { backgroundColor: p.bg, borderColor: p.border }]}
        testID="settings-preview"
      >
        <View style={[s.sampleBar, { backgroundColor: p.surface, borderBottomColor: p.border }]}>
          <Text style={[s.sampleScreen, { color: p.text }]}>Workouts</Text>
          <View style={[s.sampleBtn, { backgroundColor: p.accent }]} testID="settings-preview-button">
            <Text style={[s.sampleBtnText, { color: p.bg }]}>Log workout</Text>
          </View>
        </View>

        <View style={s.sampleBody}>
          <View style={[s.sampleCard, { backgroundColor: p.surface, borderColor: p.border }]}>
            <View style={s.sampleHead}>
              <Text style={[s.sampleTitle, { color: p.text }]}>Push A</Text>
              <View style={[s.sampleChip, { backgroundColor: p.emeraldBg }]}>
                <Text style={[s.sampleChipText, { color: p.emeraldTxt }]}>PR</Text>
              </View>
            </View>
            <Text style={[s.sampleMeta, { color: p.textMuted }]}>Today · 61 min</Text>

            {rows.map((row) => (
              <View key={row.label} style={[s.sampleRow, { borderTopColor: p.border }]}>
                <Text style={[s.sampleLabel, { color: p.textMuted }]}>{row.label}</Text>
                <Text style={[s.sampleValue, { color: p.text }]}>{row.value}</Text>
              </View>
            ))}
          </View>

          <View style={s.swatches}>
            <Swatch label="Background" color={p.bg} border={p.border} ink={p.textMuted} />
            <Swatch label="Surface" color={p.surface} border={p.border} ink={p.textMuted} />
            <Swatch label="Accent" color={p.accent} border={p.border} ink={p.textMuted} />
            <Swatch label="Emerald" color={p.emerald} border={p.border} ink={p.textMuted} />
            <Swatch label="Amber" color={p.amber} border={p.border} ink={p.textMuted} />
            <Swatch label="Sky" color={p.sky} border={p.border} ink={p.textMuted} />
          </View>
        </View>
      </View>

      <Text style={s.footnote}>How Workouts, Exercises and the rest will look.</Text>
    </View>
  );
}

/**
 * A theme colour, as a chip in its own colour — not `colors.accent`, which is
 * the colour already chosen and would paint every row the same. Decorative.
 */
function AccentChip({ accent }: { accent: Accent }) {
  return (
    <View
      style={[s.chip, { backgroundColor: accentFamily(accent).accent }]}
      testID={`accent-chip-${accent}`}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    />
  );
}

/** One colour of the previewed palette. Every colour is passed in — see `Preview`. */
function Swatch({
  label,
  color,
  border,
  ink,
}: {
  label: string;
  color: string;
  border: string;
  ink: string;
}) {
  return (
    <View style={s.swatch}>
      <View style={[s.swatchChip, { backgroundColor: color, borderColor: border }]} />
      <Text style={[s.swatchLabel, { color: ink }]}>{label}</Text>
    </View>
  );
}

const s = {
  ...settingsStyles,
  // What only this view draws; sections and radios are shared.
  ...StyleSheet.create({
  chip: { width: 22, height: 22, borderRadius: 11 },

  // ── the preview ────────────────────────────────────────────────────────────
  // Geometry only. Every colour in it comes from the palette being previewed,
  // passed inline, because a `colors.*` here would resolve to the HUD's.

  sample: { borderWidth: 1, borderRadius: radii.lg, overflow: "hidden" },
  sampleBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
  },
  sampleScreen: { fontSize: 15, fontWeight: "600" },
  sampleBtn: { paddingHorizontal: spacing.md, paddingVertical: 6, borderRadius: radii.sm },
  // The ground on the accent, as the app's own filled buttons are.
  sampleBtnText: { fontSize: 12, fontWeight: "600" },

  sampleBody: { padding: spacing.lg, gap: spacing.lg },
  sampleCard: { borderWidth: 1, borderRadius: radii.md, padding: spacing.md, gap: 2 },
  sampleHead: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  sampleTitle: { fontSize: 15, fontWeight: "600" },
  sampleChip: { paddingHorizontal: 6, paddingVertical: 1, borderRadius: radii.sm },
  sampleChipText: { fontSize: 10, fontWeight: "700", letterSpacing: 0.6 },
  sampleMeta: { fontSize: 12, marginBottom: spacing.xs },
  sampleRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingTop: spacing.xs,
    marginTop: spacing.xs,
    borderTopWidth: 1,
  },
  sampleLabel: { fontSize: 13 },
  sampleValue: { fontSize: 13, fontWeight: "500", fontVariant: ["tabular-nums"] },

  swatches: { flexDirection: "row", flexWrap: "wrap", gap: spacing.md },
  swatch: { alignItems: "center", gap: spacing.xs, width: 64 },
  swatchChip: { width: 36, height: 36, borderRadius: radii.md, borderWidth: 1 },
  swatchLabel: { fontSize: 11 },
  }),
};
