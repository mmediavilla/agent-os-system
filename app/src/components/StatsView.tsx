import React, { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { DiagnosticReport, Diagnostics, Finding, FixOutcome, SystemStats, api, errorMessage } from "../api";
import {
  KIND_LABEL,
  OUTCOME_WORD,
  SOURCE_LABEL,
  attention,
  fixCountsWord,
  reportTiles,
  rollupWord,
  troubleshootMessage,
} from "../diagnostics";
import ConfirmDialog from "./ConfirmDialog";
import TabBar from "./TabBar";
import * as fmt from "../hudFormat";
import { Polled } from "../polling";
import { colors, radii, spacing, type } from "../theme";
import { SmallButton, openFile } from "./RecordsParts";
import {
  Card,
  FindingRow,
  Line,
  SEVERITY_TONE,
  StatPage,
  VitalTile,
  VitalTiles,
  since,
  statStyles,
  when,
} from "./StatParts";

/**
 * A live reading at or past this is drawn amber. The same line
 * `config/diagnostics.php` draws for CPU, memory and disk; the report is what
 * judges, and this only keeps a live tile from looking calm about a full disk
 * between runs.
 */
export const LIVE_WARN_PERCENT = 90;

/**
 * Stats: the machine's vitals, and a diagnosis of everything that runs on it.
 *
 * The core menu's **System stats** title opens it. Since 18.1 it is draft C of
 * the diagnostics epic (the owner's call): the four readout cards it used to be are
 * compressed into a strip of eight tiles, and the rest of the page is the
 * latest report — the verdict, **Diagnose** and **Troubleshoot**, and what needs
 * attention — then one card with two tabs: every check with its evidence, and
 * the reports kept.
 *
 * **Every number the old cards held is still here**, as a check's evidence
 * under *All checks* — journal mode, latency, sizes, each heartbeat's age,
 * each calendar — because an `ok` finding carries its evidence too.
 *
 * **Three tiles are live and five are as of the report**, and the strip's
 * footnote says which. CPU, memory and disk read `system`, the HUD's poll
 * handed down (the menu's stale note reads it too, and two polls of one
 * endpoint are two answers that disagree). Everything else is the report's.
 *
 * **The report is read on open and after a run, never polled** — Facts' and
 * Profile's rule. A run is a press: it starts a PowerShell and resolves every
 * calendar's host. **Nothing is optimistic**: both buttons are disabled while
 * either request is out, and the page redraws from the answer.
 *
 * **Troubleshoot (18.2) applies the soft fixes the report offers**, after one
 * confirm naming each, and answers with a report of the state after them — the
 * newest report, so it is the one drawn, with what each fix did above its
 * findings.
 *
 * **Always mounted, gated by `active`** — `SettingsView`'s pattern: there is
 * no form state to keep.
 */
export default function StatsView({ active, system }: { active: boolean; system: Polled<SystemStats> }) {
  const diagnostics = useDiagnostics(active);
  const latest = diagnostics.data?.latest ?? null;

  return (
    <StatPage testID="stats-view">
      <VitalsCard system={system} latest={latest} loaded={diagnostics.data !== null} />
      <DiagnosisCard diagnostics={diagnostics} />
      <DetailCard data={diagnostics.data} />
    </StatPage>
  );
}

type Busy = "diagnose" | "troubleshoot" | null;

type DiagnosticsState = {
  data: Diagnostics | null;
  error: string | null;
  /** Which press is out. One at a time: both buttons are disabled while either is. */
  busy: Busy;
  run: () => Promise<void>;
  troubleshoot: (report: number) => Promise<void>;
};

/**
 * The report, read each time the overlay opens, and replaced by a press's
 * answer — Diagnose's or Troubleshoot's, which both answer with the whole page.
 *
 * **A press's answer always lands**; a read's lands only if nothing was asked
 * after it. So a slow read on open cannot put back the state a press has just
 * replaced, and a read is not started while a press is out.
 */
function useDiagnostics(active: boolean): DiagnosticsState {
  const [data, setData] = useState<Diagnostics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const asked = useRef(0);
  const busyRef = useRef(false);

  useEffect(() => {
    if (!active || busyRef.current) return;
    const mine = ++asked.current;
    api.getDiagnostics().then(
      (next) => {
        if (mine !== asked.current) return;
        setData(next);
        setError(null);
      },
      (e) => {
        if (mine === asked.current) setError(errorMessage(e));
      },
    );
  }, [active]);

  const press = useCallback(async (kind: NonNullable<Busy>, request: () => Promise<Diagnostics>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    asked.current++;
    setBusy(kind);
    setError(null);
    try {
      setData(await request());
    } catch (e) {
      // A 409 (another tab's press), a 422 and a 429 are sentences; the last report stays.
      setError(errorMessage(e));
    }
    busyRef.current = false;
    setBusy(null);
  }, []);

  const run = useCallback(() => press("diagnose", api.runDiagnostics), [press]);
  const troubleshoot = useCallback(
    (report: number) => press("troubleshoot", () => api.troubleshoot(report)),
    [press],
  );

  return { data, error, busy, run, troubleshoot };
}

function VitalsCard({
  system,
  latest,
  loaded,
}: {
  system: Polled<SystemStats>;
  latest: DiagnosticReport | null;
  loaded: boolean;
}) {
  const stats = system.data;
  // `isStale(null)` is true, and the age is null before the first sample: that
  // is "waiting", not stale.
  const stale = stats?.age_seconds != null && fmt.isStale(stats.age_seconds);
  const liveState = (reading: unknown) => (reading ? (stale ? "stale" : "live") : "waiting");
  const liveTone = (percent: number | undefined) =>
    percent === undefined ? colors.textDim : stale || percent >= LIVE_WARN_PERCENT ? colors.amber : colors.accent;

  return (
    <Card testID="stats-vitals" title="Vitals" right={stats?.host ?? undefined} footnote={vitalsNote(system, latest, loaded, stale)} wide>
      <VitalTiles>
        <VitalTile
          testID="stats-cpu"
          label="CPU"
          value={fmt.percent(stats?.cpu?.percent)}
          state={liveState(stats?.cpu)}
          tone={liveTone(stats?.cpu?.percent)}
          percent={stats?.cpu?.percent}
        />
        <VitalTile
          testID="stats-memory"
          label="Memory"
          value={fmt.percent(stats?.memory?.percent)}
          state={liveState(stats?.memory)}
          tone={liveTone(stats?.memory?.percent)}
          percent={stats?.memory?.percent}
          detail={stats?.memory ? fmt.gauge(stats.memory) : undefined}
        />
        {/* Never stale: `disk_free_space()` is a stat() call in the request. */}
        <VitalTile
          testID="stats-disk"
          label="Disk"
          value={fmt.percent(stats?.disk?.percent)}
          state={stats?.disk ? "live" : "waiting"}
          tone={stats?.disk ? (stats.disk.percent >= LIVE_WARN_PERCENT ? colors.amber : colors.accent) : colors.textDim}
          percent={stats?.disk?.percent}
          detail={stats?.disk ? fmt.gauge(stats.disk) : undefined}
        />
        {reportTiles(latest).map((tile) => (
          <VitalTile
            key={tile.key}
            testID={`stats-${tile.key}`}
            label={tile.label}
            value={tile.value}
            // Before the first diagnosis these are "not yet run", never "ok":
            // null is not a clean bill of health.
            state={!loaded ? "reading…" : latest === null ? "not yet run" : tile.rollup ? rollupWord(tile.rollup) : "not checked"}
            tone={tile.rollup ? SEVERITY_TONE[tile.rollup.severity] : colors.textDim}
          />
        ))}
      </VitalTiles>
    </Card>
  );
}

/**
 * Which tiles are live and which are as old as the report — a live number and
 * a half-hour-old one side by side, indistinguishable, is the failure to avoid.
 */
function vitalsNote(
  system: Polled<SystemStats>,
  latest: DiagnosticReport | null,
  loaded: boolean,
  stale: boolean,
): { text: string; warn: boolean } {
  const stats = system.data;

  const sample =
    stats && system.error
      ? "Couldn't refresh the machine — showing the last reading."
      : stats?.age_seconds == null
        ? "CPU and memory wait for a first sample."
        : `${stale ? "Sample stale — " : "Sampled "}${fmt.age(stats.age_seconds)}.`;

  const report = !loaded
    ? ""
    : latest
      ? ` The other five are as of the diagnosis ${since(latest.ran_at)}.`
      : " The other five wait for a first diagnosis.";

  return { text: sample + report, warn: stale || (stats !== null && system.error !== null) };
}

/**
 * The verdict, the two buttons, what Troubleshoot last did, and what needs
 * attention now.
 *
 * **Troubleshoot is there only when the report offers a soft fix** — a button
 * with nothing it could do is not a control. Pressing it opens one confirm
 * dialog listing every fix by name, in the order they run, and ending "Nothing
 * else will be touched." (the owner's one press, one confirm). The dialog is drawn
 * from `latest.fixes` and the request names `latest.id`, so what runs is what
 * was listed — the server re-reads the list off that report.
 */
function DiagnosisCard({ diagnostics }: { diagnostics: DiagnosticsState }) {
  const { data, error, busy, run, troubleshoot } = diagnostics;
  const latest = data?.latest ?? null;
  const flagged = latest ? attention(latest.findings) : [];
  const fixes = latest?.fixes ?? [];
  const [confirming, setConfirming] = useState(false);

  const apply = () => {
    setConfirming(false);
    if (latest) void troubleshoot(latest.id);
  };

  return (
    <Card testID="stats-diagnosis" title="Diagnosis" footnote={error ? { text: error, warn: true } : undefined} wide>
      <View style={s.verdictRow}>
        <View style={s.verdictText}>
          <Text style={s.verdict} testID="stats-verdict">
            {data === null ? (error ? "Couldn't read the last report" : "reading…") : latest ? latest.verdict : "Not yet run"}
          </Text>
          <Text style={s.verdictSub} testID="stats-verdict-sub">
            {latest
              ? `${KIND_LABEL[latest.kind]} ${since(latest.ran_at)} · ${SOURCE_LABEL[latest.source]}`
              : "Diagnose runs every check this app can run — free, no model call — and keeps a report."}
          </Text>
        </View>
        <View style={s.buttons}>
          {(fixes.length > 0 || busy === "troubleshoot") && (
            <PrimaryButton
              label={busy === "troubleshoot" ? "Troubleshooting…" : "Troubleshoot"}
              onPress={() => setConfirming(true)}
              disabled={busy !== null}
              testID="stats-troubleshoot"
            />
          )}
          <PrimaryButton
            label={busy === "diagnose" ? "Diagnosing…" : "Diagnose"}
            onPress={run}
            disabled={busy !== null}
            testID="stats-diagnose"
          />
        </View>
      </View>

      {latest && latest.kind === "troubleshoot" && (
        <View style={s.outcomes} testID="stats-outcomes">
          <Text style={statStyles.groupLabel}>What Troubleshoot did</Text>
          {latest.outcomes.length === 0 && <Line label="No fix was confirmed" value="—" dim />}
          {latest.outcomes.map((outcome) => (
            <OutcomeRow key={outcome.key} outcome={outcome} />
          ))}
          <Text style={s.verdictSub}>Everything below is the state after these ran.</Text>
        </View>
      )}

      {latest && flagged.length === 0 && (
        <Text style={s.clear} testID="stats-all-clear">
          Nothing needs you.
        </Text>
      )}
      {flagged.map((finding) => (
        <FindingRow key={finding.key} finding={finding} />
      ))}

      <ConfirmDialog
        visible={confirming}
        title="Troubleshoot"
        message={troubleshootMessage(fixes)}
        confirmLabel={fixes.length === 1 ? "Apply the fix" : `Apply ${fixes.length} fixes`}
        destructive={false}
        onConfirm={apply}
        onCancel={() => setConfirming(false)}
      />
    </Card>
  );
}

const OUTCOME_TONE = {
  done: colors.emerald,
  failed: colors.error,
  skipped: colors.textDim,
} satisfies Record<FixOutcome["status"], string>;

/** One fix Troubleshoot ran: ruled like a finding, in its outcome's colour, with its word as well. */
function OutcomeRow({ outcome }: { outcome: FixOutcome }) {
  return (
    <View style={[statStyles.finding, { borderLeftColor: OUTCOME_TONE[outcome.status] }]} testID={`outcome-${outcome.key}`}>
      <Text style={statStyles.findingTitle}>
        {OUTCOME_WORD[outcome.status]} · {outcome.label}
      </Text>
      <Text style={statStyles.findingDetail}>{outcome.detail}</Text>
    </View>
  );
}

export type DetailTab = "checks" | "reports";

export const DETAIL_TABS: readonly { value: DetailTab; label: string }[] = [
  { value: "checks", label: "All checks" },
  { value: "reports", label: "Reports" },
];

/**
 * Below the diagnosis, one card with two tabs (the owner's call): every check, and the
 * reports kept. The tab bar is the card's head, and the count on the right is
 * the showing tab's.
 *
 * **Only the showing tab is mounted.** Both are readouts of `data`, with no
 * draft to lose, and an unmounted tab cannot leave a hidden button reachable —
 * the disabled-`Pressable` trap. The choice is this component's state, and
 * Stats is always mounted, so it survives the overlay closing.
 */
function DetailCard({ data }: { data: Diagnostics | null }) {
  const [tab, setTab] = useState<DetailTab>("checks");
  const latest = data?.latest ?? null;
  const right =
    tab === "checks"
      ? latest
        ? `${latest.counts.passed} of ${latest.counts.total} passed`
        : undefined
      : data
        ? `${data.reports.length} kept`
        : undefined;

  return (
    <View style={[statStyles.card, statStyles.cardBox, statStyles.cardWide]} testID="stats-detail">
      <View style={s.detailHead}>
        <View style={s.detailTabs}>
          <TabBar options={DETAIL_TABS} value={tab} onChange={setTab} />
        </View>
        {right && (
          <Text style={[statStyles.cardRight, s.detailRight]} testID="stats-detail-right">
            {right}
          </Text>
        )}
      </View>
      {tab === "checks" ? <ChecksPanel data={data} /> : <ReportsPanel data={data} />}
    </View>
  );
}

/**
 * Every check by group, the passing ones included, each with its evidence.
 * This is where the numbers the old cards carried live now.
 */
function ChecksPanel({ data }: { data: Diagnostics | null }) {
  const latest = data?.latest ?? null;

  return (
    <View testID="stats-checks">
      {latest === null ? (
        <Line label="Checks" value={data === null ? "reading…" : "not yet run"} dim />
      ) : (
        <View style={s.groups}>
          {(data?.groups ?? []).map((group) => {
            const own = latest.findings.filter((f) => f.group === group.key);
            if (own.length === 0) return null;
            return (
              <View key={group.key} style={s.group} testID={`stats-group-${group.key}`}>
                <Text style={statStyles.groupLabel}>{group.title}</Text>
                {own.map((finding) => (
                  <CheckRow key={finding.key} finding={finding} />
                ))}
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}

function CheckRow({ finding }: { finding: Finding }) {
  return (
    <View style={s.check} testID={`check-${finding.key}`}>
      <View style={statStyles.lineRow}>
        <View style={[statStyles.marker, { backgroundColor: SEVERITY_TONE[finding.severity] }]} />
        <Text style={statStyles.lineLabel} numberOfLines={1}>
          {finding.title}
        </Text>
      </View>
      {finding.evidence.length > 0 && <Text style={s.evidence}>{finding.evidence.join(" · ")}</Text>}
    </View>
  );
}

function ReportsPanel({ data }: { data: Diagnostics | null }) {
  const reports = data?.reports ?? [];
  const onScreen = data?.latest?.id;

  return (
    <View style={s.reports} testID="stats-reports">
      {data === null && <Line label="Reports" value="reading…" dim />}
      {data !== null && reports.length === 0 && <Line label="No reports yet" value="—" dim />}
      {reports.map((report) => (
        <View key={report.id} style={s.report} testID={`stats-report-${report.id}`}>
          <View style={s.reportText}>
            <Text style={statStyles.lineLabel} numberOfLines={1}>
              {KIND_LABEL[report.kind]} · {when(report.ran_at)}
              {report.id === onScreen ? "  (on screen)" : ""}
            </Text>
            <Text style={s.evidence} numberOfLines={1}>
              {report.fix_counts ? `${fixCountsWord(report.fix_counts)} · ` : ""}
              {report.verdict} · {SOURCE_LABEL[report.source]}
            </Text>
          </View>
          {report.file_url && (
            <SmallButton
              label="Open .md"
              onPress={() => openFile(report.file_url!)}
              disabled={false}
              testID={`stats-report-${report.id}-open`}
              accessibilityLabel={`Open the ${KIND_LABEL[report.kind].toLowerCase()} report from ${when(report.ran_at)} as markdown`}
            />
          )}
        </View>
      ))}
    </View>
  );
}

function PrimaryButton({
  label,
  onPress,
  disabled,
  testID,
}: {
  label: string;
  onPress: () => void;
  disabled: boolean;
  testID: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled, busy: disabled }}
      style={({ hovered }: any) => [s.button, hovered && !disabled && s.buttonHovered, disabled && s.disabled]}
      testID={testID}
    >
      <Text style={s.buttonText}>{label}</Text>
    </Pressable>
  );
}

const s = {
  ...statStyles,
  ...StyleSheet.create({
    verdictRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: spacing.md },
    verdictText: { flex: 1, minWidth: 220, gap: 2 },
    verdict: { ...type.title, color: colors.text },
    verdictSub: { ...type.caption, color: colors.textDim },
    clear: { ...type.small, color: colors.emerald },
    buttons: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
    outcomes: { gap: spacing.sm },

    groups: { flexDirection: "row", flexWrap: "wrap", columnGap: spacing.xl, rowGap: spacing.lg },
    group: { flexBasis: 280, flexGrow: 1, minWidth: 0, gap: spacing.sm },
    check: { gap: 1 },
    evidence: { ...type.caption, color: colors.textDim, paddingLeft: 14 },

    detailHead: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: spacing.md },
    detailTabs: { flexGrow: 1, flexShrink: 1, maxWidth: 360, minWidth: 220 },
    // At the card's right edge, where every other card's count sits.
    detailRight: { marginLeft: "auto" },
    reports: { gap: spacing.sm },
    report: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
    reportText: { flex: 1, minWidth: 0, gap: 1 },

    button: {
      borderWidth: 1,
      borderColor: colors.accentBd,
      backgroundColor: colors.accentBg,
      borderRadius: radii.md,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
    },
    buttonHovered: { borderColor: colors.accent },
    buttonText: { fontSize: 13, fontWeight: "600", color: colors.accentTxt },
    disabled: { opacity: 0.45 },
  }),
};
