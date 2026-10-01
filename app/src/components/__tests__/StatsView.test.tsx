import React from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react-native";
import { DiagnosticReport, Diagnostics, Finding, SystemStats, api } from "../../api";
import { Polled } from "../../polling";
import StatsView from "../StatsView";

/**
 * Stats since 18.1: the vitals strip, then the latest diagnosis — verdict,
 * what needs attention, every check, and the reports kept.
 *
 * The rules that matter most: three tiles are live and five are as of the
 * report, and the page says which; the report is read on open and after a
 * run, never polled; nothing is optimistic; "not yet run" is never drawn as
 * fine; and Troubleshoot runs only what its one confirm named (18.2).
 */

jest.mock("../../api", () => ({
  ...jest.requireActual("../../api"),
  api: {
    getSystemStats: jest.fn(),
    getHealth: jest.fn(),
    getDiagnostics: jest.fn(),
    runDiagnostics: jest.fn(),
    troubleshoot: jest.fn(),
  },
}));

const mockApi = api as jest.Mocked<typeof api>;

const SYSTEM: SystemStats = {
  host: "DESKTOP-TEST",
  platform: "Windows",
  sampled_at: "2026-09-06T09:00:00+00:00",
  age_seconds: 4,
  cpu: { percent: 34 },
  memory: { used_bytes: 21_260_000_000, total_bytes: 34_000_000_000, percent: 62.5 },
  disk: { used_bytes: 1_562_000_000_000, total_bytes: 2_199_000_000_000, percent: 71, path: "C:\\" },
};

function f(key: string, patch: Partial<Finding> = {}): Finding {
  return {
    key,
    group: key.split(".")[0],
    title: key,
    severity: "ok",
    detail: `${key} detail`,
    evidence: [`${key}: 1`],
    fix: null,
    manual: null,
    ...patch,
  };
}

const FINDINGS: Finding[] = [
  f("database.reachable", { title: "Database reachable", evidence: ["driver: sqlite", "latency: 0.4 ms"] }),
  f("database.journal_mode", { title: "Write-ahead log", evidence: ["journal_mode: wal"] }),
  f("database.files", { title: "Database files", evidence: ["size: 18 MB", "wal: 1.4 MB"] }),
  f("queue.heartbeat", {
    title: "Queue worker heartbeat",
    severity: "problem",
    detail: "The worker has not run its heartbeat for 12 minutes.",
    evidence: ["last beat: 12m ago", "grace: 150s"],
    fix: { key: "restart_queue_worker", label: "Restart the queue worker" },
  }),
  f("queue.failed_jobs", {
    title: "Failed jobs",
    severity: "warn",
    detail: "Two jobs failed.",
    evidence: ["failed: 2"],
    fix: { key: "retry_failed_jobs", label: "Retry the failed jobs" },
  }),
  f("scheduler.heartbeat", { title: "Scheduler heartbeat", evidence: ["last tick: 1m ago"] }),
  f("scheduler.task_1", {
    title: "ProjectMC scheduler",
    severity: "problem",
    detail: "The task is disabled.",
    evidence: ["state: Disabled"],
    manual: "Run Enable-ScheduledTask -TaskName \"ProjectMC scheduler\" from an elevated PowerShell.",
  }),
  f("assistant.switch", { title: "Anthropic switch", evidence: ["switch: on"] }),
  f("calendar.feed_1", { title: "Calendar: Work", evidence: ["status: ok", "events read: 1m ago"] }),
  f("storage.documents", { title: "Filed documents", evidence: ["with a file: 4", "on disk: 2.4 MB"] }),
];

// What the server says Troubleshoot would run, in its order.
const FIXES = [
  { key: "retry_failed_jobs", label: "Retry every failed job." },
  { key: "restart_queue_worker", label: "Restart the queue worker task." },
];

function latest(findings: Finding[] = FINDINGS, patch: Partial<DiagnosticReport> = {}): DiagnosticReport {
  return {
    id: 7,
    kind: "diagnose",
    source: "ui",
    ran_at: new Date(Date.now() - 180_000).toISOString(),
    verdict: "2 problems, 1 warning · 10 checks",
    counts: { problems: 2, warnings: 1, passed: 7, total: 10 },
    fix_counts: null,
    file_url: "https://projectmc.test/api/diagnostics/7/file?signature=x",
    bytes: 2048,
    findings,
    outcomes: [],
    fixes: FIXES,
    ...patch,
  };
}

const GROUPS = [
  { key: "database", title: "Database" },
  { key: "queue", title: "Queue worker" },
  { key: "scheduler", title: "Scheduler" },
  { key: "assistant", title: "Assistant" },
  { key: "calendar", title: "Calendars" },
  { key: "storage", title: "Storage" },
];

function state(report: DiagnosticReport | null = latest()): Diagnostics {
  const { findings: _findings, ...summary } = report ?? ({} as DiagnosticReport);
  return {
    latest: report,
    reports: report
      ? [
          summary,
          {
            ...summary,
            id: 6,
            source: "cli",
            file_url: null,
            verdict: "Nothing wrong · 10 checks",
            ran_at: "2026-09-27T01:00:00+00:00",
          },
        ]
      : [],
    groups: GROUPS,
  };
}

function polled<T>(data: T | null, extra: Partial<Polled<T>> = {}): Polled<T> {
  return { data, error: null, loading: false, latencyMs: 42, refresh: jest.fn(), ...extra };
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function draw(active = true, system: Polled<SystemStats> = polled(SYSTEM)) {
  return render(<StatsView active={active} system={system} />);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockApi.getDiagnostics.mockResolvedValue(state());
});

const within_ = (id: string) => within(screen.getByTestId(id));

describe("the vitals strip", () => {
  it("draws eight tiles: the machine live, the rest from the report", async () => {
    draw();
    await settle();

    expect(within_("stats-cpu").getByText("34%")).toBeTruthy();
    expect(within_("stats-cpu").getByText("live")).toBeTruthy();
    expect(within_("stats-memory").getByText("19.8 / 31.7 GB")).toBeTruthy();
    expect(within_("stats-disk").getByText("1.4 / 2 TB")).toBeTruthy();

    expect(within_("stats-database").getByText("18 MB")).toBeTruthy();
    expect(within_("stats-database").getByText("ok")).toBeTruthy();
    // The group's worst, in words as well as colour.
    expect(within_("stats-worker").getByText("12m ago")).toBeTruthy();
    expect(within_("stats-worker").getByText("1 problem")).toBeTruthy();
    expect(within_("stats-scheduler").getByText("1 problem")).toBeTruthy();
    expect(within_("stats-assistant").getByText("on")).toBeTruthy();
    expect(within_("stats-calendars").getByText("1 of 1 ok")).toBeTruthy();
    expect(within_("stats-vitals").getByText("DESKTOP-TEST")).toBeTruthy();
  });

  it("says which tiles are live and how old the others are", async () => {
    draw();
    await settle();

    // A live number and a three-minute-old one side by side, indistinguishable,
    // is the failure this line exists for.
    expect(
      within_("stats-vitals").getByText("Sampled 4s ago. The other five are as of the diagnosis 3m ago."),
    ).toBeTruthy();
  });

  it("reads 'not yet run' before the first diagnosis — never ok, never zero", async () => {
    mockApi.getDiagnostics.mockResolvedValue(state(null));
    draw();
    await settle();

    for (const id of ["database", "worker", "scheduler", "assistant", "calendars"]) {
      expect(within_(`stats-${id}`).getByText("not yet run")).toBeTruthy();
      expect(within_(`stats-${id}`).getByText("—")).toBeTruthy();
    }
    // The live three still read the machine.
    expect(within_("stats-cpu").getByText("34%")).toBeTruthy();
    expect(screen.getByText(/The other five wait for a first diagnosis/)).toBeTruthy();
    expect(within_("stats-verdict").getByText("Not yet run")).toBeTruthy();
  });

  it("says the sample is stale rather than calling it live", async () => {
    draw(true, polled<SystemStats>({ ...SYSTEM, age_seconds: 300 }));
    await settle();

    expect(within_("stats-cpu").getByText("stale")).toBeTruthy();
    expect(within_("stats-cpu").getByText("34%")).toBeTruthy();
    expect(screen.getByText(/^Sample stale — 5m ago\./)).toBeTruthy();
    // Disk is a stat() call in the request, never stale.
    expect(within_("stats-disk").getByText("live")).toBeTruthy();
  });

  it("waits for a first sample rather than drawing zeroed bars", async () => {
    draw(true, polled<SystemStats>({ ...SYSTEM, sampled_at: null, age_seconds: null, cpu: null, memory: null }));
    await settle();

    expect(within_("stats-cpu").getByText("waiting")).toBeTruthy();
    expect(within_("stats-cpu").getByText("—")).toBeTruthy();
    expect(within_("stats-memory").getByText("waiting")).toBeTruthy();
    expect(within_("stats-disk").getByText("1.4 / 2 TB")).toBeTruthy();
    expect(screen.getByText(/^CPU and memory wait for a first sample\./)).toBeTruthy();
  });
});

describe("reading the report", () => {
  it("reads it on open and polls nothing — the machine is handed in", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "queueMicrotask"] });
    try {
      const view = draw(false);
      await settle();
      expect(mockApi.getDiagnostics).not.toHaveBeenCalled();

      view.rerender(<StatsView active system={polled(SYSTEM)} />);
      await settle();
      expect(mockApi.getDiagnostics).toHaveBeenCalledTimes(1);

      await act(async () => {
        jest.advanceTimersByTime(10 * 60_000);
        await Promise.resolve();
      });
      expect(mockApi.getDiagnostics).toHaveBeenCalledTimes(1);
      expect(mockApi.runDiagnostics).not.toHaveBeenCalled();
      expect(mockApi.getSystemStats).not.toHaveBeenCalled();
      expect(mockApi.getHealth).not.toHaveBeenCalled();

      // Each opening reads it again.
      view.rerender(<StatsView active={false} system={polled(SYSTEM)} />);
      view.rerender(<StatsView active system={polled(SYSTEM)} />);
      await settle();
      expect(mockApi.getDiagnostics).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it("says when the report could not be read", async () => {
    mockApi.getDiagnostics.mockRejectedValue(new Error("network"));
    draw();
    await settle();

    expect(within_("stats-verdict").getByText("Couldn't read the last report")).toBeTruthy();
    expect(within_("stats-diagnosis").getByText("network")).toBeTruthy();
  });
});

describe("the diagnosis", () => {
  it("leads with the verdict, when it ran and who ran it", async () => {
    draw();
    await settle();

    expect(within_("stats-verdict").getByText("2 problems, 1 warning · 10 checks")).toBeTruthy();
    expect(within_("stats-verdict-sub").getByText("Diagnosis 3m ago · from this page")).toBeTruthy();
  });

  it("lists what needs attention, problems first, each with its fix or its manual step", async () => {
    draw();
    await settle();

    const rows = within_("stats-diagnosis")
      .getAllByTestId(/^finding-[a-z_]+\.[a-z_0-9]+$/)
      .map((row) => row.props.testID);
    expect(rows).toEqual(["finding-queue.heartbeat", "finding-scheduler.task_1", "finding-queue.failed_jobs"]);

    expect(within_("finding-queue.heartbeat-fix").getByText("Soft fix · Restart the queue worker")).toBeTruthy();
    expect(screen.getByTestId("finding-scheduler.task_1-manual").props.children).toEqual([
      "Needs you · ",
      'Run Enable-ScheduledTask -TaskName "ProjectMC scheduler" from an elevated PowerShell.',
    ]);
    // Passing checks are not findings.
    expect(screen.queryByTestId("finding-database.files")).toBeNull();
  });

  it("says nothing needs you when everything passed", async () => {
    mockApi.getDiagnostics.mockResolvedValue(state(latest([f("database.files", { evidence: ["size: 1 MB"] })])));
    draw();
    await settle();

    expect(screen.getByTestId("stats-all-clear")).toBeTruthy();
  });

  it("runs, disabled while out, and redraws from the answer", async () => {
    let answer!: (d: Diagnostics) => void;
    mockApi.runDiagnostics.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    draw();
    await settle();

    fireEvent.press(screen.getByTestId("stats-diagnose"));
    await settle();
    expect(within_("stats-diagnose").getByText("Diagnosing…")).toBeTruthy();
    expect(screen.getByTestId("stats-diagnose").props.accessibilityState.disabled).toBe(true);
    // Not optimistic: the old verdict stands until the answer.
    expect(within_("stats-verdict").getByText("2 problems, 1 warning · 10 checks")).toBeTruthy();

    await act(async () => {
      answer(state(latest([f("database.files", { evidence: ["size: 18 MB"] })], { id: 8, verdict: "Nothing wrong · 1 checks" })));
    });

    expect(within_("stats-verdict").getByText("Nothing wrong · 1 checks")).toBeTruthy();
    expect(within_("stats-diagnose").getByText("Diagnose")).toBeTruthy();
    expect(mockApi.runDiagnostics).toHaveBeenCalledTimes(1);
  });

  it("keeps the last report and shows the sentence when a run is refused", async () => {
    mockApi.runDiagnostics.mockRejectedValue(
      new Error("A diagnosis is already running. Its report will be on the page when it finishes."),
    );
    draw();
    await settle();

    fireEvent.press(screen.getByTestId("stats-diagnose"));
    await settle();

    expect(screen.getByText(/A diagnosis is already running/)).toBeTruthy();
    expect(within_("stats-verdict").getByText("2 problems, 1 warning · 10 checks")).toBeTruthy();
  });

  it("never lets a slow read on open put back what a run replaced", async () => {
    let read!: (d: Diagnostics) => void;
    mockApi.getDiagnostics.mockReturnValue(new Promise((resolve) => (read = resolve)));
    mockApi.runDiagnostics.mockResolvedValue(state(latest(FINDINGS, { verdict: "the run's answer" })));
    draw();
    await settle();

    fireEvent.press(screen.getByTestId("stats-diagnose"));
    await settle();
    expect(within_("stats-verdict").getByText("the run's answer")).toBeTruthy();

    await act(async () => {
      read(state(latest(FINDINGS, { verdict: "the stale read" })));
    });
    expect(within_("stats-verdict").getByText("the run's answer")).toBeTruthy();
  });
});

describe("troubleshoot", () => {
  const AFTER = latest([f("queue.heartbeat", { title: "Queue worker heartbeat", evidence: ["last beat: 2s ago"] })], {
    id: 9,
    kind: "troubleshoot",
    verdict: "Nothing wrong · 1 checks",
    counts: { problems: 0, warnings: 0, passed: 1, total: 1 },
    fix_counts: { done: 1, failed: 1, skipped: 0 },
    fixes: [],
    outcomes: [
      { key: "retry_failed_jobs", label: "Retry every failed job.", status: "failed", detail: "the queue is on fire" },
      {
        key: "restart_queue_worker",
        label: "Restart the queue worker task.",
        status: "done",
        detail: "Restarted the task; the worker ran its first job within 2s.",
      },
    ],
  });

  it("is there only when the report offers a soft fix", async () => {
    mockApi.getDiagnostics.mockResolvedValue(state(latest(FINDINGS, { fixes: [] })));
    draw();
    await settle();

    // A button with nothing it could do is not a control.
    expect(screen.getByTestId("stats-diagnose")).toBeTruthy();
    expect(screen.queryByTestId("stats-troubleshoot")).toBeNull();
  });

  it("names every fix, in the order they run, before anything runs", async () => {
    draw();
    await settle();

    fireEvent.press(screen.getByTestId("stats-troubleshoot"));
    await settle();

    expect(screen.getByText("• Retry every failed job.\n• Restart the queue worker task.\n\nNothing else will be touched.")).toBeTruthy();
    expect(mockApi.troubleshoot).not.toHaveBeenCalled();

    fireEvent.press(screen.getByText("Cancel"));
    await settle();
    expect(screen.queryByText(/Nothing else will be touched/)).toBeNull();
    expect(mockApi.troubleshoot).not.toHaveBeenCalled();
  });

  it("applies what the report on screen offered, disabled while out, and redraws from the answer", async () => {
    let answer!: (d: Diagnostics) => void;
    mockApi.troubleshoot.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    draw();
    await settle();

    fireEvent.press(screen.getByTestId("stats-troubleshoot"));
    await settle();
    fireEvent.press(screen.getByText("Apply 2 fixes"));
    await settle();

    // The report the dialog was drawn from; the server reads the list off it.
    expect(mockApi.troubleshoot).toHaveBeenCalledWith(7);
    expect(within_("stats-troubleshoot").getByText("Troubleshooting…")).toBeTruthy();
    expect(screen.getByTestId("stats-troubleshoot").props.accessibilityState.disabled).toBe(true);
    // One press at a time.
    expect(screen.getByTestId("stats-diagnose").props.accessibilityState.disabled).toBe(true);
    expect(within_("stats-verdict").getByText("2 problems, 1 warning · 10 checks")).toBeTruthy();

    await act(async () => {
      answer(state(AFTER));
    });

    expect(within_("stats-verdict").getByText("Nothing wrong · 1 checks")).toBeTruthy();
    expect(within_("stats-verdict-sub").getByText("Troubleshoot 3m ago · from this page")).toBeTruthy();
    expect(within_("outcome-restart_queue_worker").getByText("Done · Restart the queue worker task.")).toBeTruthy();
    expect(within_("outcome-retry_failed_jobs").getByText("Failed · Retry every failed job.")).toBeTruthy();
    expect(within_("outcome-retry_failed_jobs").getByText("the queue is on fire")).toBeTruthy();
    // Nothing left to offer, so no button.
    expect(screen.queryByTestId("stats-troubleshoot")).toBeNull();
    fireEvent.press(screen.getByText("Reports"));
    expect(within_("stats-report-9").getByText(/^1 fix done, 1 failed · Nothing wrong/)).toBeTruthy();
  });

  it("keeps the report and shows the sentence when it is refused", async () => {
    mockApi.troubleshoot.mockRejectedValue(new Error("A diagnosis or troubleshoot is already running."));
    draw();
    await settle();

    fireEvent.press(screen.getByTestId("stats-troubleshoot"));
    fireEvent.press(screen.getByText("Apply 2 fixes"));
    await settle();

    expect(within_("stats-diagnosis").getByText(/already running/)).toBeTruthy();
    expect(within_("stats-verdict").getByText("2 problems, 1 warning · 10 checks")).toBeTruthy();
    expect(within_("stats-troubleshoot").getByText("Troubleshoot")).toBeTruthy();
  });
});

describe("all checks and reports, as tabs", () => {
  it("opens on All checks, and Reports replaces it in the same card", async () => {
    draw();
    await settle();

    const tabs = within_("stats-detail").getAllByRole("tab");
    expect(tabs.map((t) => t.props.accessibilityState.selected)).toEqual([true, false]);
    expect(screen.getByTestId("stats-checks")).toBeTruthy();
    expect(screen.queryByTestId("stats-reports")).toBeNull();

    fireEvent.press(screen.getByText("Reports"));

    expect(screen.getByTestId("stats-reports")).toBeTruthy();
    expect(screen.queryByTestId("stats-checks")).toBeNull();
    // The count on the right is the showing tab's.
    expect(within_("stats-detail-right").getByText("2 kept")).toBeTruthy();

    fireEvent.press(screen.getByText("All checks"));
    expect(within_("stats-detail-right").getByText("7 of 10 passed")).toBeTruthy();
  });

  it("keeps the tab chosen when the overlay closes and opens again", async () => {
    const view = draw();
    await settle();
    fireEvent.press(screen.getByText("Reports"));

    view.rerender(<StatsView active={false} system={polled(SYSTEM)} />);
    view.rerender(<StatsView active system={polled(SYSTEM)} />);
    await settle();

    expect(screen.getByTestId("stats-reports")).toBeTruthy();
  });
});

describe("all checks", () => {
  it("lists every check by group, the passing ones with their evidence", async () => {
    draw();
    await settle();

    expect(within_("stats-detail-right").getByText("7 of 10 passed")).toBeTruthy();
    // Where the old cards' numbers live now: journal mode, latency, sizes,
    // heartbeats, calendars, documents.
    expect(within_("check-database.reachable").getByText("driver: sqlite · latency: 0.4 ms")).toBeTruthy();
    expect(within_("check-database.journal_mode").getByText("journal_mode: wal")).toBeTruthy();
    expect(within_("check-storage.documents").getByText("with a file: 4 · on disk: 2.4 MB")).toBeTruthy();
    expect(within_("stats-group-queue").getByText("Queue worker")).toBeTruthy();
    expect(within_("stats-group-queue").getByText("Failed jobs")).toBeTruthy();
    // A group the report holds nothing for draws nothing.
    expect(screen.queryByTestId("stats-group-sign_in")).toBeNull();
  });

  it("is not yet run before the first diagnosis", async () => {
    mockApi.getDiagnostics.mockResolvedValue(state(null));
    draw();
    await settle();

    expect(within_("stats-checks").getByText("not yet run")).toBeTruthy();
  });
});

describe("reports", () => {
  it("lists what is kept, marks the one on screen, and opens its .md", async () => {
    const open = jest.fn();
    window.open = open;
    draw();
    await settle();
    fireEvent.press(screen.getByText("Reports"));

    expect(within_("stats-detail-right").getByText("2 kept")).toBeTruthy();
    expect(within_("stats-report-7").getByText(/\(on screen\)/)).toBeTruthy();
    expect(within_("stats-report-6").getByText("Nothing wrong · 10 checks · from the command line")).toBeTruthy();
    // A report whose file was never written offers nothing to open.
    expect(screen.queryByTestId("stats-report-6-open")).toBeNull();

    fireEvent.press(screen.getByTestId("stats-report-7-open"));
    expect(open).toHaveBeenCalledWith("https://projectmc.test/api/diagnostics/7/file?signature=x", "_blank", "noopener");
  });

  it("says there are none on a checkout that has never diagnosed", async () => {
    mockApi.getDiagnostics.mockResolvedValue(state(null));
    draw();
    await settle();
    fireEvent.press(screen.getByText("Reports"));

    expect(within_("stats-reports").getByText("No reports yet")).toBeTruthy();
  });
});
