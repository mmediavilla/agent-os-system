import React from "react";
import { render } from "@testing-library/react-native";
import HudChrome from "../HudChrome";
import { AssistantHealth, Health } from "../../api";
import { Polled } from "../../polling";

/**
 * The chrome bar's two status words.
 *
 * The pill answers "is anything wrong" and the chip answers "has the assistant
 * been switched off", and the whole point of them being separate is that the
 * second is not an instance of the first — so what is asserted here is mostly
 * that the chip appears without disturbing the pill.
 */

const assistant = (over: Partial<AssistantHealth> = {}): AssistantHealth => ({
  state: "up",
  enabled: true,
  configured: true,
  model: "claude-sonnet-5",
  ...over,
});

const health = (data: Health | null, extra: Partial<Polled<Health>> = {}): Polled<Health> => ({
  data,
  error: null,
  loading: false,
  latencyMs: 12,
  refresh: jest.fn(),
  ...extra,
});

const reading = (over: Partial<AssistantHealth> = {}): Health =>
  ({
    ok: true,
    checked_at: "2026-09-06T09:00:00+00:00",
    database: { state: "up" },
    queue: { state: "up", last_beat_at: null, age_seconds: 0, pending: 0 },
    scheduler: { state: "up", last_beat_at: null, age_seconds: 0 },
    assistant: assistant(over),
  }) as Health;

const renderBar = (polled: Polled<Health>) =>
  render(
    <HudChrome narrow={false} health={polled} />,
  );

it("says nothing about the assistant while it is switched on", () => {
  const q = renderBar(health(reading()));

  // There is no `AI ON` chip: the ordinary state does not need announcing, and
  // a badge that is always there stops being read.
  expect(q.queryByTestId("assistant-off-chip")).toBeNull();
  expect(q.getByTestId("status-pill")).toHaveTextContent("ONLINE");
});

it("shows AI OFF once the switch is off", () => {
  const q = renderBar(health(reading({ enabled: false, state: "off" })));

  expect(q.getByTestId("assistant-off-chip")).toHaveTextContent("AI OFF");
});

it("keeps the pill ONLINE while the assistant is off", () => {
  // A machine the user switched off is not a degraded machine. Collapsing the
  // two would make DEGRADED mean "or you turned something off", which is the
  // fastest way to teach someone to ignore it.
  const q = renderBar(health(reading({ enabled: false, state: "off" })));

  expect(q.getByTestId("status-pill")).toHaveTextContent("ONLINE");
});

it("does not claim the API is off when there is no reading at all", () => {
  // The one thing worse than not knowing is being told the wrong thing: a
  // dropped poll must not draw a chip about a switch nobody has read.
  const q = renderBar(health(null, { loading: false }));

  expect(q.queryByTestId("assistant-off-chip")).toBeNull();
});

describe("the NO CREDIT chip", () => {
  const exhausted = { exhausted: true, since: "2026-09-29T08:00:00+00:00", last_refused_at: "2026-09-29T09:00:00+00:00" };

  it("appears once Anthropic has refused a call for credit, beside the pill", () => {
    const q = renderBar(health(reading({ credit: exhausted })));

    expect(q.getByTestId("no-credit-chip")).toHaveTextContent("NO CREDIT");
    // The account, not this machine: the pill stays what the machine is.
    expect(q.getByTestId("status-pill")).toHaveTextContent("ONLINE");
  });

  it("is absent while the flag is clear, and on a reading from before it existed", () => {
    expect(renderBar(health(reading({ credit: { exhausted: false, since: null, last_refused_at: null } }))).queryByTestId("no-credit-chip")).toBeNull();
    expect(renderBar(health(reading())).queryByTestId("no-credit-chip")).toBeNull();
  });

  it("is not drawn without a reading", () => {
    expect(renderBar(health(null)).queryByTestId("no-credit-chip")).toBeNull();
  });
});
