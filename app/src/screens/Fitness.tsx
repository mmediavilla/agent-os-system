import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import {
  api,
  errorMessage,
  FitnessStats,
  Insight,
  RangeKey,
  Workout,
  WorkoutsResponse,
} from "../api";
import ErrorBanner from "../components/ErrorBanner";
import ConsistencyHeatmap from "../components/fitness/ConsistencyHeatmap";
import KpiRow from "../components/fitness/KpiRow";
import MuscleSplit from "../components/fitness/MuscleSplit";
import StrengthProgression from "../components/fitness/StrengthProgression";
import VolumeTrend from "../components/fitness/VolumeTrend";
import PillSelector from "../components/PillSelector";
import { colors, radii, spacing } from "../theme";
import { useRefreshOnActivate } from "../useRefreshOnActivate";
import { useFitnessPrefs } from "../FitnessPrefsProvider";
import { StatsRange } from "../fitnessPrefs";

type Props = {
  active: boolean;
  /** Opens Fitness → Workouts on the "View all Workouts" tab. */
  onOpenAllWorkouts: () => void;
};

/** Sessions shown in the recent card. Everything older is on the Workouts screen. */
const RECENT_LIMIT = 5;

const RANGE_OPTIONS: { value: RangeKey; label: string }[] = [
  { value: "4w", label: "4w" },
  { value: "12w", label: "12w" },
  { value: "1y", label: "1y" },
  { value: "all", label: "All" },
];

/** Range wording for empty-state copy, so "nothing here" says what "here" is. */
const RANGE_PHRASE: Record<RangeKey, string> = {
  "4w": "the last 4 weeks",
  "12w": "the last 12 weeks",
  "1y": "the last year",
  all: "your history",
};

export default function Fitness({ active, onOpenAllWorkouts }: Props) {
  // Feeds the recent card, and disables the generate button when there's
  // nothing to assess. Logging and editing still live on the Workouts screen.
  const [workouts, setWorkouts] = useState<WorkoutsResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Analytics range, opening on Fitness → Settings' default. `auto` lets the
  // server pick the narrowest window that holds data, so a stale database still
  // opens on a full dashboard.
  const { defaultRange } = useFitnessPrefs().prefs;
  const [range, setRange] = useState<StatsRange>(defaultRange);

  // This screen stays mounted, so a default changed in Settings would otherwise
  // only show after a reload. Picking a new default is asking to see it.
  const shownDefault = useRef(defaultRange);
  useEffect(() => {
    if (shownDefault.current === defaultRange) return;
    shownDefault.current = defaultRange;
    setRange(defaultRange);
  }, [defaultRange]);
  const [stats, setStats] = useState<FitnessStats | null>(null);
  const [statsErr, setStatsErr] = useState<string | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const statsCache = useRef<Partial<Record<string, FitnessStats>>>({});

  // AI insight state
  const [insight, setInsight] = useState<Insight | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiErr, setAiErr] = useState<string | null>(null);
  const [history, setHistory] = useState<Insight[]>([]);

  const reload = useCallback(async () => {
    try {
      const [w, h] = await Promise.all([api.listWorkouts(), api.listInsights({ domain: "fitness" })]);
      setWorkouts(w);
      setHistory(h.data);
      setErr(null);
    } catch (e) {
      setErr(errorMessage(e));
    }
  }, []);

  /**
   * Kept out of `reload`'s Promise.all on purpose: a stats failure must not be
   * able to blank the recent-workouts card, and changing range must not make the
   * AI panel flicker through a reload it does not need.
   */
  const reloadStats = useCallback(async () => {
    const cached = statsCache.current[range];
    if (cached) {
      setStats(cached);
      setStatsErr(null);
      setStatsLoading(false);
      return;
    }
    setStatsLoading(true);
    try {
      const s = await api.getFitnessStats({ range });
      statsCache.current[range] = s;
      setStats(s);
      setStatsErr(null);
    } catch (e) {
      setStatsErr(errorMessage(e));
    } finally {
      setStatsLoading(false);
    }
  }, [range]);

  useEffect(() => {
    reload();
  }, [reload]);

  // `range` is in reloadStats' dependency list, so picking a pill is itself the
  // refetch trigger — no separate effect needed.
  useEffect(() => {
    reloadStats();
  }, [reloadStats]);

  const reloadAll = useCallback(() => {
    // This screen stays mounted, so without dropping the cache a session logged
    // over on the Workouts screen would never reach the charts.
    statsCache.current = {};
    reload();
    reloadStats();
  }, [reload, reloadStats]);

  useRefreshOnActivate(active, reloadAll);

  // ── AI insight ────────────────────────────────────────────────────────────────

  const generateInsight = async () => {
    setAiLoading(true);
    setAiErr(null);
    setInsight(null);
    try {
      const i = await api.generateFitnessInsight();
      setInsight(i);
      await reload();
    } catch (e) {
      setAiErr(errorMessage(e));
    } finally {
      setAiLoading(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────────

  const resolved = stats?.range.resolved;

  return (
    <ScrollView contentContainerStyle={styles.scroll}>
      <Text style={styles.h1}>Fitness</Text>
      <Text style={styles.muted}>Your latest sessions and a weekly assessment from Claude. Log sessions under Fitness → Workouts.</Text>

      {err && <ErrorBanner text={err} />}

      {/* Training analytics ──────────────────────────────────────────────────── */}
      <View style={styles.analyticsHeader}>
        <View style={styles.analyticsHeading}>
          <Text style={styles.sectionTitle}>Training analytics</Text>
          {stats && (
            <Text style={styles.muted}>
              {stats.range.from} → {stats.range.to}
            </Text>
          )}
        </View>
        <PillSelector
          tone="emerald"
          options={RANGE_OPTIONS}
          // Nothing is lit while the first request is in flight; once it lands,
          // the window the server actually chose lights up.
          value={range === "auto" ? (resolved ?? "") : range}
          onChange={setRange}
        />
      </View>

      {statsErr ? (
        <View style={styles.statsError}>
          <ErrorBanner text={statsErr} />
          <Pressable
            onPress={reloadStats}
            accessibilityRole="button"
            style={({ hovered }: any) => [styles.retry, hovered && { opacity: 0.7 }]}
          >
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : (
        <>
          <KpiRow
            kpis={stats?.kpis ?? null}
            loading={statsLoading}
            weekCount={workouts?.summary.week_count}
            weekGoal={workouts?.summary.week_goal}
            streakDays={workouts?.summary.streak_days}
          />

          <ConsistencyHeatmap
            data={stats?.heatmap ?? null}
            loading={statsLoading}
            rangeLabel={RANGE_PHRASE[resolved ?? "4w"]}
          />

          <View style={styles.grid}>
            <VolumeTrend data={stats?.volume ?? null} loading={statsLoading} />
            <MuscleSplit data={stats?.muscles ?? null} loading={statsLoading} />
          </View>

          <StrengthProgression
            data={stats?.strength ?? null}
            loading={statsLoading}
            formula={stats?.settings?.e1rm_formula}
          />
        </>
      )}

      {/* Recent workouts — read-only. Viewing, editing and deleting a session
          all live on the Workouts screen, which owns the detail modal. */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Recent workouts</Text>
        {!workouts && !err && <ActivityIndicator color={colors.accent} />}
        {workouts && workouts.data.length === 0 && (
          <Text style={styles.muted}>No workouts yet. Log one under Fitness → Workouts.</Text>
        )}
        {workouts?.data.slice(0, RECENT_LIMIT).map((w) => (
          <RecentRow key={w.id} w={w} />
        ))}
        {workouts && workouts.data.length > 0 && (
          <Pressable
            onPress={onOpenAllWorkouts}
            accessibilityRole="link"
            style={({ hovered }: any) => [styles.viewAllLink, hovered && { opacity: 0.7 }]}
          >
            {/* meta.total, not data.length — this fetch is capped at the
                backend default of 50, so the page size is not the count. */}
            <Text style={styles.viewAllText}>
              View all Workouts ({workouts.meta?.total ?? workouts.data.length}) →
            </Text>
          </Pressable>
        )}
      </View>

      {/* AI panel */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Weekly assessment</Text>
        <Text style={styles.muted}>Sends your last 21 days of workouts to Claude and stores the response.</Text>

        <Pressable
          onPress={generateInsight}
          disabled={aiLoading || !workouts || workouts.data.length === 0}
          style={({ hovered }: any) => [
            styles.primary,
            (aiLoading || !workouts || workouts.data.length === 0) && { opacity: 0.6 },
            hovered && !aiLoading && { backgroundColor: colors.accentHov },
          ]}
        >
          {aiLoading
            ? <ActivityIndicator color={colors.bg} />
            : <Text style={styles.primaryText}>Generate weekly assessment</Text>}
        </Pressable>

        {aiErr && <ErrorBanner text={aiErr} />}

        {insight && (
          <View style={styles.insightBox}>
            <Text style={styles.insightTitle}>{insight.title}</Text>
            <Text style={styles.insightMeta}>
              {new Date(insight.created_at).toLocaleString()}
              {insight.model && ` · ${insight.model}`}
            </Text>
            <Text style={styles.insightText}>{insight.response}</Text>
          </View>
        )}
      </View>

      {/* Past insights.
          Not only assessments any more: the proactive layer writes into the same
          table (kind "proactive_nudge") so it needs no screen of its own, which
          is exactly why the heading cannot keep saying "assessments" and the row
          has to carry its own title — a nudge and a weekly review are two
          different things behind the same date. */}
      {history.length > 0 && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Past insights</Text>
          {history.map((i) => (
            <View key={i.id} style={styles.histRow}>
              <Text style={styles.histDate}>
                {new Date(i.created_at).toLocaleDateString()}
                {i.kind === "proactive_nudge" && " · UNPROMPTED"}
              </Text>
              <Text style={styles.histTitle}>{i.title}</Text>
              <Text style={styles.histText} numberOfLines={3}>{i.response}</Text>
            </View>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

/** One line of the recent card. Mirrors the row on the Workouts screen, minus
 *  the View/Delete actions — those need the detail modal, which lives there. */
function RecentRow({ w }: { w: Workout }) {
  const date     = new Date(w.started_at).toLocaleDateString();
  const duration = w.duration_minutes != null ? `${w.duration_minutes} min` : null;
  const exCount  = w.exercise_count ?? 0;
  const setCount = w.set_count ?? 0;

  return (
    <View style={styles.recentRow}>
      <Text style={styles.recentTitle}>{w.title}</Text>
      <Text style={styles.muted}>
        {date}{duration ? ` · ${duration}` : ""}
      </Text>
      <Text style={styles.muted}>
        {exCount} exercise{exCount !== 1 ? "s" : ""} · {setCount} set{setCount !== 1 ? "s" : ""}
      </Text>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  // Wide enough to give the two-up analytics grid real columns rather than
  // cramped ones.
  scroll: { padding: spacing.lg, gap: spacing.lg, maxWidth: 1100, alignSelf: "center", width: "100%" },
  h1:     { fontSize: 24, fontWeight: "700", color: colors.text },
  muted:  { color: colors.textMuted, fontSize: 13, lineHeight: 19 },

  analyticsHeader: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    alignItems: "center",
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  analyticsHeading: { gap: 2 },
  sectionTitle: { fontSize: 18, fontWeight: "700", color: colors.text },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: spacing.md },
  statsError: { gap: spacing.sm, alignItems: "flex-start" },
  retry: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  retryText: { color: colors.text, fontWeight: "600", fontSize: 13 },

  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.lg,
    padding: spacing.lg,
    gap: spacing.md,
  },
  cardTitle: { fontSize: 16, fontWeight: "700", color: colors.text },

  recentRow:   { paddingVertical: spacing.sm, borderBottomColor: colors.border, borderBottomWidth: 1, gap: 2 },
  recentTitle: { fontWeight: "600", color: colors.text, fontSize: 14 },
  viewAllLink: { paddingTop: spacing.sm, alignSelf: "flex-end" },
  viewAllText: { color: colors.accent, fontSize: 13, fontWeight: "600" },

  primary:     { backgroundColor: colors.accent, paddingVertical: 12, borderRadius: radii.md, alignItems: "center", justifyContent: "center", minHeight: 44 },
  primaryText: { color: colors.bg, fontWeight: "700", fontSize: 14 },

  // Capped independently of the card: at 1100px wide, prose set to the full
  // width runs to an unreadable ~140 characters a line.
  insightBox:   { backgroundColor: colors.bg, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border, padding: spacing.md, gap: 6, maxWidth: 760 },
  insightTitle: { fontWeight: "700", color: colors.text, fontSize: 14 },
  insightMeta:  { color: colors.textDim, fontSize: 11 },
  insightText:  { color: colors.text, fontSize: 14, lineHeight: 21 },

  histRow:  { paddingVertical: spacing.sm, borderBottomColor: colors.border, borderBottomWidth: 1, gap: 4, maxWidth: 760 },
  histDate: { color: colors.textDim, fontSize: 11, fontWeight: "600", letterSpacing: 0.6 },
  histTitle:{ color: colors.text, fontSize: 13, fontWeight: "700" },
  histText: { color: colors.text, fontSize: 13, lineHeight: 19 },
});
