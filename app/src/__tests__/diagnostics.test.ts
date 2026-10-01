import { DiagnosticReport, Finding, Severity } from "../api";
import {
  attention,
  evidence,
  fixCountsWord,
  reportTiles,
  rollup,
  rollupWord,
  troubleshootMessage,
} from "../diagnostics";

/**
 * Reading a diagnosis for Stats: the order findings are listed in, what a group
 * rolls up to, and what each report tile says — including what it says when
 * there is nothing to say.
 */

function finding(key: string, severity: Severity = "ok", ev: string[] = ["x: 1"]): Finding {
  return {
    key,
    group: key.split(".")[0],
    title: key,
    severity,
    detail: "",
    evidence: ev,
    fix: null,
    manual: severity === "ok" ? null : "do it",
  };
}

function report(findings: Finding[]): DiagnosticReport {
  return {
    id: 1,
    kind: "diagnose",
    source: "ui",
    ran_at: "2026-09-28T01:00:00+00:00",
    verdict: "",
    counts: { problems: 0, warnings: 0, passed: 0, total: findings.length },
    fix_counts: null,
    file_url: null,
    bytes: null,
    findings,
    outcomes: [],
    fixes: [],
  };
}

it("lists every fix for the confirm dialog and promises nothing else", () => {
  expect(troubleshootMessage([{ label: "Retry every failed job." }, { label: "Restart the queue worker task." }])).toBe(
    "• Retry every failed job.\n• Restart the queue worker task.\n\nNothing else will be touched.",
  );
});

it("counts what a troubleshoot's fixes did, naming only what happened", () => {
  expect(fixCountsWord({ done: 2, failed: 0, skipped: 0 })).toBe("2 fixes done");
  expect(fixCountsWord({ done: 1, failed: 1, skipped: 1 })).toBe("1 fix done, 1 failed, 1 skipped");
  expect(fixCountsWord({ done: 0, failed: 0, skipped: 2 })).toBe("2 skipped");
  expect(fixCountsWord({ done: 0, failed: 0, skipped: 0 })).toBe("no fixes run");
});

it("reads one evidence line by its label, and nothing by a label it lacks", () => {
  const f = finding("database.files", "ok", ["size: 2.0 MB", "wal: 1.4 MB"]);

  expect(evidence(f, "size")).toBe("2.0 MB");
  expect(evidence(f, "wal")).toBe("1.4 MB");
  expect(evidence(f, "siz")).toBeNull();
  expect(evidence(undefined, "size")).toBeNull();
  // Only the first ": " splits — an error message may hold another.
  expect(evidence(finding("c.f", "warn", ["last error: HTTP 404: gone"]), "last error")).toBe("HTTP 404: gone");
});

it("lists problems before warnings, in check order within each, and leaves out what passed", () => {
  const listed = attention([
    finding("a.one", "warn"),
    finding("a.two", "ok"),
    finding("b.one", "problem"),
    finding("b.two", "warn"),
    finding("c.one", "problem"),
  ]).map((f) => f.key);

  // `Report::attention()`'s order, so the page and the .md agree.
  expect(listed).toEqual(["b.one", "c.one", "a.one", "b.two"]);
});

it("rolls a group up to its worst, and says so in words", () => {
  const findings = [finding("queue.a"), finding("queue.b", "warn"), finding("db.a", "problem"), finding("db.b", "problem")];

  expect(rollup(findings, "queue")).toEqual({ severity: "warn", problems: 0, warnings: 1 });
  expect(rollupWord(rollup(findings, "queue")!)).toBe("1 warning");
  expect(rollupWord(rollup(findings, "db")!)).toBe("2 problems");
  expect(rollupWord(rollup([finding("x.a")], "x")!)).toBe("ok");
  // Nothing for the group is unknown, never fine.
  expect(rollup(findings, "calendar")).toBeNull();
});

it("draws every report tile as a dash with no state before the first diagnosis", () => {
  const tiles = reportTiles(null);

  expect(tiles.map((t) => t.key)).toEqual(["database", "worker", "scheduler", "assistant", "calendars"]);
  expect(tiles.every((t) => t.value === "—" && t.rollup === null)).toBe(true);
});

it("takes each tile's value from its finding's evidence, and its state from the whole group", () => {
  const tiles = reportTiles(
    report([
      finding("database.reachable"),
      finding("database.journal_mode", "problem"),
      finding("database.files", "ok", ["size: 2.0 MB", "wal: 1.4 MB"]),
      finding("queue.heartbeat", "problem", ["last beat: never"]),
      finding("scheduler.heartbeat", "ok", ["last tick: 1m ago"]),
      finding("assistant.switch", "ok", ["switch: off"]),
      finding("calendar.feed_1"),
      finding("calendar.feed_2", "warn"),
    ]),
  );
  const by = Object.fromEntries(tiles.map((t) => [t.key, t]));

  // Reachable and sized, but not in WAL: the size is still the number, and the
  // tile is red for the group.
  expect(by.database.value).toBe("2.0 MB");
  expect(by.database.rollup?.severity).toBe("problem");
  expect(by.worker.value).toBe("never");
  expect(by.scheduler.value).toBe("1m ago");
  expect(by.assistant.value).toBe("off");
  expect(by.calendars.value).toBe("1 of 2 ok");
  expect(by.calendars.rollup?.severity).toBe("warn");
});

it("says none are connected rather than 0 of 0, and draws a dash for a label that went missing", () => {
  const tiles = reportTiles(
    report([finding("calendar.feeds", "ok", ["connected: 0"]), finding("database.files", "ok", ["database: :memory:"])]),
  );
  const by = Object.fromEntries(tiles.map((t) => [t.key, t]));

  expect(by.calendars.value).toBe("none");
  // A database that is not a file has no size; a dash, never a wrong number.
  expect(by.database.value).toBe("—");
  expect(by.database.rollup?.severity).toBe("ok");
  // A group the report holds nothing for is unknown, not fine.
  expect(by.worker.rollup).toBeNull();
});
