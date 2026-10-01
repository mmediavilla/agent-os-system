import { RunEvent, api } from "../api";
import { watchRun } from "../runWatcher";

jest.mock("../api", () => ({
  ...jest.requireActual("../api"),
  api: { getRun: jest.fn() },
}));

const mockApi = api as jest.Mocked<typeof api>;

/**
 * The polling half of the watcher.
 *
 * There is no `EventSource` under the test runner, which is not a gap in the
 * setup — it is React Native's situation exactly, and the reason polling is the
 * baseline rather than a fallback. So these tests exercise the transport that
 * has to keep working, and the streaming half degrades into it.
 */

function ev(seq: number, type: string, data: Record<string, unknown> = {}): RunEvent {
  return { seq, type, data };
}

function update(events: RunEvent[], finished = false) {
  return {
    run: {
      id: "run-1",
      conversation_id: 1,
      trigger: "message" as const,
      status: finished ? ("completed" as const) : ("running" as const),
      finished,
      error: null,
      created_at: null,
    },
    events,
  };
}

/** Let every pending promise in the poll settle. */
async function flush() {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

/** Move on to the next poll and let it settle. */
async function tick() {
  jest.advanceTimersByTime(700);
  await flush();
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
});

afterEach(() => {
  jest.useRealTimers();
});

it("hands over events and asks for what comes after them", async () => {
  const seen: RunEvent[] = [];

  mockApi.getRun
    .mockResolvedValueOnce(update([ev(1, "run.started"), ev(2, "text", { delta: "Four." })]))
    .mockResolvedValueOnce(update([ev(3, "run.finished", { status: "completed" })]));

  watchRun("run-1", { onEvents: (events) => seen.push(...events), onDone: jest.fn() });
  await flush();

  expect(mockApi.getRun).toHaveBeenNthCalledWith(1, "run-1", 0);

  await tick();

  // The second ask resumes from the highest seq, not from a moment in time —
  // which is what lets a slow client catch up rather than skip the middle of
  // an answer.
  expect(mockApi.getRun).toHaveBeenNthCalledWith(2, "run-1", 2);
  expect(seen.map((e) => e.seq)).toEqual([1, 2, 3]);
});

it("stops as soon as the run says it has finished", async () => {
  const onDone = jest.fn();

  mockApi.getRun.mockResolvedValue(update([ev(1, "run.finished", { status: "completed" })], true));

  watchRun("run-1", { onEvents: jest.fn(), onDone });

  await flush();
  expect(onDone).toHaveBeenCalledTimes(1);

  await tick();
  await tick();

  // One poll, then silence. A watcher that keeps asking after the end is a
  // background request loop nobody can see.
  expect(mockApi.getRun).toHaveBeenCalledTimes(1);
});

it("stops on a run that ended without a closing event", async () => {
  const onDone = jest.fn();

  // A worker killed mid-loop leaves a terminal row and no `run.finished`.
  mockApi.getRun.mockResolvedValue(update([], true));

  watchRun("run-1", { onEvents: jest.fn(), onDone });

  await flush();

  expect(onDone).toHaveBeenCalledTimes(1);
});

it("gives up rather than retrying when the run cannot be read", async () => {
  const onDone = jest.fn();

  mockApi.getRun.mockRejectedValue(new Error("Not found"));

  watchRun("run-1", { onEvents: jest.fn(), onDone });

  await flush();

  // The run is gone, or the server is. Either way the screen re-reads the
  // thread on the way out and is whole again.
  expect(onDone).toHaveBeenCalledTimes(1);
  expect(mockApi.getRun).toHaveBeenCalledTimes(1);
});

it("asks nothing more once it is stopped", async () => {
  mockApi.getRun.mockResolvedValue(update([ev(1, "text", { delta: "Four." })]));

  const watcher = watchRun("run-1", { onEvents: jest.fn(), onDone: jest.fn() });

  await flush();
  watcher.stop();
  await tick();
  await tick();

  expect(mockApi.getRun).toHaveBeenCalledTimes(1);
});

it("picks up from where a previous watcher left off", async () => {
  mockApi.getRun.mockResolvedValue(update([]));

  watchRun("run-1", { after: 12, onEvents: jest.fn(), onDone: jest.fn() });

  await flush();

  expect(mockApi.getRun).toHaveBeenCalledWith("run-1", 12);
});

describe("streaming", () => {
  /** The smallest `EventSource` the watcher uses: a URL, listeners, `onerror`. */
  class FakeSource {
    static last: FakeSource | null = null;
    listeners: Record<string, (m: { data: string }) => void> = {};
    onerror: (() => void) | null = null;
    readyState = 1;
    closed = false;
    constructor(public url: string) {
      FakeSource.last = this;
    }
    addEventListener(type: string, fn: (m: { data: string }) => void) {
      this.listeners[type] = fn;
    }
    close() {
      this.closed = true;
    }
  }

  beforeEach(() => {
    FakeSource.last = null;
    (globalThis as any).EventSource = FakeSource;
  });

  afterEach(() => {
    delete (globalThis as any).EventSource;
  });

  const SIGNED = "https://api.test/api/agent/runs/run-1/stream?expires=9&signature=abc";

  it("opens the URL the server signed, as it is", () => {
    watchRun("run-1", { streamUrl: SIGNED, onEvents: jest.fn(), onDone: jest.fn() });

    expect(FakeSource.last?.url).toBe(SIGNED);
    expect(mockApi.getRun).not.toHaveBeenCalled();
  });

  it("appends `after` to resume, leaving the signed part alone", () => {
    watchRun("run-1", { streamUrl: SIGNED, after: 12, onEvents: jest.fn(), onDone: jest.fn() });

    expect(FakeSource.last?.url).toBe(`${SIGNED}&after=12`);
  });

  it("polls when the server gave no stream URL, since polling carries the token", async () => {
    mockApi.getRun.mockResolvedValue(update([]));

    watchRun("run-1", { onEvents: jest.fn(), onDone: jest.fn() });
    await flush();

    expect(FakeSource.last).toBeNull();
    expect(mockApi.getRun).toHaveBeenCalledWith("run-1", 0);
  });

  it("falls back to polling when the stream will not open — an expired signature", async () => {
    mockApi.getRun.mockResolvedValue(update([]));

    watchRun("run-1", { streamUrl: SIGNED, onEvents: jest.fn(), onDone: jest.fn() });
    const source = FakeSource.last!;
    source.readyState = 2;
    source.onerror?.();
    await flush();

    expect(source.closed).toBe(true);
    expect(mockApi.getRun).toHaveBeenCalledWith("run-1", 0);
  });
});
