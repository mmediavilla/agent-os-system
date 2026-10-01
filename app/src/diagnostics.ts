import { DiagnosticReport, Finding, FixOutcome, ReportSummary, Severity } from "./api";

/**
 * Reading a diagnosis for the Stats page: which findings need attention, what a
 * group rolls up to, and what each vitals tile says.
 *
 * Pure, so the rules are tested off literals rather than through a render. The
 * page draws the report's JSON natively rather than parsing its markdown back
 * — one structure, two renderings — so everything here reads `Finding`s.
 */

const RANK = { ok: 0, warn: 1, problem: 2 } satisfies Record<Severity, number>;

/**
 * The value of one `label: value` evidence line, or null if the finding has no
 * such line.
 *
 * The tiles read four labels this way (`size`, `last beat`, `last tick`,
 * `switch`), and the backend's `DiagnosticsTileEvidenceTest` pins that each
 * still exists on every branch of its check. A label that went missing anyway
 * draws a dash, never a wrong number.
 */
export function evidence(finding: Finding | undefined, label: string): string | null {
  const prefix = `${label}: `;
  const line = finding?.evidence.find((e) => e.startsWith(prefix));
  return line === undefined ? null : line.slice(prefix.length);
}

/**
 * What needs attention, worst first and in check order within a severity —
 * `Report::attention()`'s order, so the page and the `.md` list them alike.
 */
export function attention(findings: Finding[]): Finding[] {
  return findings
    .map((finding, index) => ({ finding, index }))
    .filter(({ finding }) => finding.severity !== "ok")
    .sort((a, b) => RANK[b.finding.severity] - RANK[a.finding.severity] || a.index - b.index)
    .map(({ finding }) => finding);
}

export type Rollup = { severity: Severity; problems: number; warnings: number };

/**
 * A group's worst severity and its counts. Null when the report holds nothing
 * for the group — a report older than the group, or a hand-edited row — which
 * the tile draws as unknown rather than as fine.
 */
export function rollup(findings: Finding[], group: string): Rollup | null {
  const own = findings.filter((f) => f.group === group);
  if (own.length === 0) return null;

  const problems = own.filter((f) => f.severity === "problem").length;
  const warnings = own.filter((f) => f.severity === "warn").length;

  return { severity: problems > 0 ? "problem" : warnings > 0 ? "warn" : "ok", problems, warnings };
}

/** "ok", "1 warning", "2 problems" — the worst of it, in words, so state is never colour alone. */
export function rollupWord(r: Rollup): string {
  if (r.problems > 0) return `${r.problems} ${r.problems === 1 ? "problem" : "problems"}`;
  if (r.warnings > 0) return `${r.warnings} ${r.warnings === 1 ? "warning" : "warnings"}`;
  return "ok";
}

export type ReportTile = {
  key: string;
  label: string;
  value: string;
  /** Null before the first diagnosis, or when the report has nothing for the group. */
  rollup: Rollup | null;
};

/**
 * The five tiles that are as of the last report. (CPU, memory and disk are the
 * other three, and read the live machine poll.)
 *
 * **A tile names no number the checks did not produce**: each value is lifted
 * from one finding's evidence, and the tile's colour is its whole group rolled
 * up — so a database that is reachable but not in WAL is an amber tile whose
 * number is still its size.
 */
export function reportTiles(report: DiagnosticReport | null): ReportTile[] {
  const findings = report?.findings ?? [];
  const find = (key: string) => findings.find((f) => f.key === key);
  const tile = (key: string, label: string, group: string, value: string | null): ReportTile => ({
    key,
    label,
    value: report === null ? "—" : (value ?? "—"),
    rollup: report === null ? null : rollup(findings, group),
  });

  return [
    tile("database", "Database", "database", evidence(find("database.files"), "size")),
    // "1m ago" is the age as the check wrote it, so it is as old as the report;
    // the strip's footnote says so.
    tile("worker", "Worker", "queue", evidence(find("queue.heartbeat"), "last beat")),
    tile("scheduler", "Scheduler", "scheduler", evidence(find("scheduler.heartbeat"), "last tick")),
    tile("assistant", "Assistant", "assistant", evidence(find("assistant.switch"), "switch")),
    tile("calendars", "Calendars", "calendar", calendars(findings)),
  ];
}

/**
 * "4 of 5 ok", or "none" when nothing is connected. A switched-off calendar
 * passes its check (it is not read, which is not a fault), so it counts as ok.
 */
function calendars(findings: Finding[]): string | null {
  const feeds = findings.filter((f) => f.group === "calendar");
  if (feeds.length === 0) return null;
  if (feeds.some((f) => f.key === "calendar.feeds")) return "none";

  const ok = feeds.filter((f) => f.severity === "ok").length;
  return `${ok} of ${feeds.length} ok`;
}

/**
 * The Troubleshoot confirm dialog's words: every fix by its label, in the order
 * it runs, and then the promise that nothing else is — the owner's requirement that
 * nothing is implicit.
 */
export function troubleshootMessage(fixes: { label: string }[]): string {
  return `${fixes.map((f) => `• ${f.label}`).join("\n")}\n\nNothing else will be touched.`;
}

export const OUTCOME_WORD = {
  done: "Done",
  failed: "Failed",
  skipped: "Skipped",
} satisfies Record<FixOutcome["status"], string>;

/** "2 fixes done, 1 failed" — a troubleshoot's line in the list of reports. */
export function fixCountsWord(c: NonNullable<ReportSummary["fix_counts"]>): string {
  const parts: string[] = [];
  if (c.done > 0) parts.push(`${c.done} ${c.done === 1 ? "fix" : "fixes"} done`);
  if (c.failed > 0) parts.push(`${c.failed} failed`);
  if (c.skipped > 0) parts.push(`${c.skipped} skipped`);
  return parts.length === 0 ? "no fixes run" : parts.join(", ");
}

export const SOURCE_LABEL = {
  ui: "from this page",
  cli: "from the command line",
} satisfies Record<ReportSummary["source"], string>;

export const KIND_LABEL = {
  diagnose: "Diagnosis",
  troubleshoot: "Troubleshoot",
} satisfies Record<ReportSummary["kind"], string>;
