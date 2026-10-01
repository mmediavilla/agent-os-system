import React from "react";
import { act, render, screen, within } from "@testing-library/react-native";
import { AssistantActivity as Activity, api } from "../../api";
import AssistantActivity, { ACTIVITY_MS } from "../AssistantActivity";

/**
 * Assistant → Activity: what the assistant keeps and what it did this week. It
 * polls one endpoint, only while its tab is showing.
 */

jest.mock("../../api", () => ({
  ...jest.requireActual("../../api"),
  api: { getAssistantActivity: jest.fn(), getDiagnostics: jest.fn() },
}));

const mockApi = api as jest.Mocked<typeof api>;

const ACTIVITY: Activity = {
  generated_at: "2026-09-06T09:00:00+00:00",
  window: { days: 7, since: "2026-08-31T00:00:00+08:00", timezone: "Asia/Manila" },
  records: {
    conversations: 74,
    messages: 1902,
    insights: 58,
    snapshots: 0,
    facts: 12,
    last_conversation_at: null,
    last_insight_at: null,
  },
  facts: { proposed: 5, kept: 3 },
  runs: { queued: 0, running: 0, completed: 31, awaiting_confirmation: 1, max_iterations: 0, failed: 2 },
  tool_calls: 96,
  tool_errors: 3,
  gated: { approved: 4, rejected: 1, pending: 1 },
  tools: [
    { tool: "get_fitness_stats", calls: 22 },
    { tool: "list_workouts", calls: 9 },
  ],
  tokens: { input: 184_203, output: 21_877, cache_read: 1_204_551, cache_write: 38_210 },
  spend: { usd: 1.8234, unpriced_models: [], unpriced_tokens: 0, prices_as_of: "2026-09" },
  spend_month: {
    usd: 6.4,
    unpriced_models: [],
    unpriced_tokens: 0,
    prices_as_of: "2026-09",
    since: "2026-09-01T00:00:00+08:00",
  },
};

async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockApi.getAssistantActivity.mockResolvedValue(ACTIVITY);
});

const card = (id: string) => within(screen.getByTestId(id));

it("draws what the assistant keeps", async () => {
  render(<AssistantActivity active />);
  await settle();

  const records = card("activity-records");
  expect(records.getByText("74")).toBeTruthy();
  expect(records.getByText("1,902")).toBeTruthy();
  // No frames stored is an answer, and is drawn as one.
  expect(records.getByText("0")).toBeTruthy();
  expect(records.getAllByText("never")).toHaveLength(2);
});

it("draws the runs worth naming, the gated writes, the tools and the tokens", async () => {
  render(<AssistantActivity active />);
  await settle();

  const week = card("activity-week");
  expect(week.getByText("Completed")).toBeTruthy();
  expect(week.getByText("Failed")).toBeTruthy();
  expect(week.getByText("Awaiting approval")).toBeTruthy();
  // Zero, and over in seconds: not worth a row.
  expect(week.queryByText("Queued")).toBeNull();
  expect(week.getByText("34")).toBeTruthy(); // 31 + 1 + 2 runs
  expect(week.getByText("get_fitness_stats")).toBeTruthy();
  expect(week.getByText("1,204,551")).toBeTruthy();
  expect(within(screen.getByTestId("activity-gated")).getByText("4")).toBeTruthy();
});

it("shows the week's spend at list price, and says it is an estimate", async () => {
  render(<AssistantActivity active />);
  await settle();

  const spend = card("activity-spend");
  expect(spend.getByText("This week")).toBeTruthy();
  expect(spend.getByText("$1.82")).toBeTruthy();
  expect(spend.getByText("Month to date")).toBeTruthy();
  expect(spend.getByText("$6.40")).toBeTruthy();
  // Nothing unpriced this week: no line for it.
  expect(spend.queryByText(/Not priced/)).toBeNull();
  expect(screen.getByText(/not the bill/)).toBeTruthy();
  // The ledger's promise, said where the number is read.
  expect(screen.getByText(/deleting a thread takes nothing off it/)).toBeTruthy();
});

it("names a model it could not price rather than guessing its cost", async () => {
  mockApi.getAssistantActivity.mockResolvedValue({
    ...ACTIVITY,
    spend: { usd: 0.001, unpriced_models: ["claude-opus-5-5"], unpriced_tokens: 12_400, prices_as_of: "2026-09" },
  });
  render(<AssistantActivity active />);
  await settle();

  const spend = card("activity-spend");
  // Under half a cent is not "$0.00": something was spent.
  expect(spend.getByText("<$0.01")).toBeTruthy();
  expect(spend.getByText("Not priced this week (claude-opus-5-5)")).toBeTruthy();
  expect(spend.getByText("12,400 tokens")).toBeTruthy();
  // The month had none of it: no line for the month.
  expect(spend.queryByText(/Not priced this month/)).toBeNull();
});

it("counts the facts on file, and what the extractor proposed and the owner kept this week", async () => {
  render(<AssistantActivity active />);
  await settle();

  expect(card("activity-records").getByText("12")).toBeTruthy();
  const facts = within(screen.getByTestId("activity-facts"));
  expect(facts.getByText("Proposed")).toBeTruthy();
  expect(facts.getByText("5")).toBeTruthy();
  expect(facts.getByText("Kept")).toBeTruthy();
  expect(facts.getByText("3")).toBeTruthy();
});

it("names the window from the payload, not from a number of its own", async () => {
  mockApi.getAssistantActivity.mockResolvedValue({ ...ACTIVITY, window: { ...ACTIVITY.window, days: 14 } });
  render(<AssistantActivity active />);
  await settle();

  expect(card("activity-week").getByText("last 14 days")).toBeTruthy();
});

it("reads nothing while it is not the tab on show, and re-reads on its interval while it is", async () => {
  jest.useFakeTimers({ doNotFake: ["nextTick", "queueMicrotask"] });
  try {
    const view = render(<AssistantActivity active={false} />);
    await settle();
    expect(mockApi.getAssistantActivity).not.toHaveBeenCalled();

    view.rerender(<AssistantActivity active />);
    await settle();
    expect(mockApi.getAssistantActivity).toHaveBeenCalledTimes(1);

    await act(async () => {
      jest.advanceTimersByTime(ACTIVITY_MS);
      await Promise.resolve();
    });
    expect(mockApi.getAssistantActivity).toHaveBeenCalledTimes(2);
    // Stats' report is Stats' to read.
    expect(mockApi.getDiagnostics).not.toHaveBeenCalled();
  } finally {
    jest.useRealTimers();
  }
});

it("keeps the last numbers when a refresh fails, and says so", async () => {
  jest.useFakeTimers({ doNotFake: ["nextTick", "queueMicrotask"] });
  try {
    render(<AssistantActivity active />);
    await settle();

    mockApi.getAssistantActivity.mockRejectedValue(new Error("network"));
    await act(async () => {
      jest.advanceTimersByTime(ACTIVITY_MS);
      await Promise.resolve();
    });
    await settle();

    expect(card("activity-records").getByText("74")).toBeTruthy();
    expect(card("activity-records").getByText("Couldn't refresh — showing the last reading.")).toBeTruthy();
  } finally {
    jest.useRealTimers();
  }
});
