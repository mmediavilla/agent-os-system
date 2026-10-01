import React from "react";
import { AssistantActivity as Activity, RunStatus, Spend, api } from "../api";
import * as fmt from "../hudFormat";
import { Polled, usePolled } from "../polling";
import { colors } from "../theme";
import { Card, Group, Line, StatPage, Tile, Tiles, errorNote, since } from "./StatParts";

/**
 * How often the activity is re-read while the tab is showing. Nothing in it
 * moves faster than a run finishing. Exported so a test advances to the real
 * interval rather than a magic number.
 */
export const ACTIVITY_MS = 30_000;

/**
 * Assistant → Activity: what the assistant keeps, and what it did and spent
 * over the last week — tokens, and those tokens at list price. The price is an
 * estimate: Anthropic reports no balance, so the server multiplies its own
 * token counts by a price table (`AnthropicPricing`).
 *
 * It lived in Stats for a day and moved here at the owner's call: threads, runs, tool
 * calls and tokens are the assistant's own record, and belong beside its chat
 * and its settings. Stats kept what is about the machine.
 *
 * **Polled only while this tab is showing** (`active` is "the overlay is open
 * and this is its tab", as for Settings), because the tab is mounted on first
 * visit and then kept, hidden, like every overlay tab.
 */
export default function AssistantActivity({ active }: { active: boolean }) {
  const activity = usePolled(api.getAssistantActivity, { intervalMs: ACTIVITY_MS, active });

  return (
    <StatPage testID="assistant-activity">
      <RecordsCard activity={activity} />
      <WeekCard activity={activity} />
    </StatPage>
  );
}

function RecordsCard({ activity }: { activity: Polled<Activity> }) {
  const r = activity.data?.records;

  return (
    <Card testID="activity-records" title="Records" footnote={errorNote(activity)}>
      <Tiles>
        <Tile label="THREADS" value={fmt.count(r?.conversations)} />
        <Tile label="MESSAGES" value={fmt.count(r?.messages)} />
        <Tile label="INSIGHTS" value={fmt.count(r?.insights)} />
        <Tile label="FRAMES" value={fmt.count(r?.snapshots)} />
      </Tiles>
      <Line label="Facts on file" value={fmt.count(r?.facts)} />
      <Line label="Last conversation" value={r ? since(r.last_conversation_at) : "—"} />
      <Line label="Last insight" value={r ? since(r.last_insight_at) : "—"} />
    </Card>
  );
}

/**
 * The runs worth naming even at zero. The others — queued, running, parked,
 * cut off at the ceiling — are only drawn when there are some, because a row of
 * zeros for states that are over in seconds is noise.
 */
const ALWAYS_SHOWN: RunStatus[] = ["completed", "failed"];

const RUN_LABELS = {
  queued: "Queued",
  running: "Running",
  completed: "Completed",
  awaiting_confirmation: "Awaiting approval",
  max_iterations: "Hit the ceiling",
  failed: "Failed",
} satisfies Record<RunStatus, string>;

function WeekCard({ activity }: { activity: Polled<Activity> }) {
  const a = activity.data;

  return (
    <Card
      testID="activity-week"
      title="This week"
      // Named from the payload, so the tab says what the server counted.
      right={a ? `last ${a.window.days} days` : undefined}
      footnote={
        errorNote(activity) ?? {
          text:
            "Spend is tokens at Anthropic's list price, the month counted from the 1st on your calendar" +
            (a ? ` (${a.spend.prices_as_of})` : "") +
            ", not the bill: the console has the real figure. " +
            "Every paid call is counted, fact extraction included, and deleting a thread takes nothing off it. " +
            "Cache reads are billed at a tenth of fresh input — a high number there is the cache working.",
        }
      }
    >
      <Tiles>
        <Tile label="RUNS" value={a ? fmt.count(Object.values(a.runs).reduce((n, v) => n + v, 0)) : "—"} />
        <Tile label="TOOL CALLS" value={fmt.count(a?.tool_calls)} />
        <Tile label="TOOL ERRORS" value={fmt.count(a?.tool_errors)} />
      </Tiles>

      {a && (
        <Group testID="activity-runs" label="Runs">
          {(Object.keys(RUN_LABELS) as RunStatus[])
            .filter((status) => ALWAYS_SHOWN.includes(status) || a.runs[status] > 0)
            .map((status) => (
              <Line
                key={status}
                testID={`activity-run-${status}`}
                label={RUN_LABELS[status]}
                value={fmt.count(a.runs[status])}
                tone={status === "failed" && a.runs.failed > 0 ? colors.error : undefined}
              />
            ))}
        </Group>
      )}

      {a && (
        // Only calls that needed an approval: every read is born approved, and
        // counting those would call each lookup a write waved through.
        <Group testID="activity-gated" label="Writes asked for">
          <Line label="Approved" value={fmt.count(a.gated.approved)} />
          <Line label="Rejected" value={fmt.count(a.gated.rejected)} />
          <Line label="Waiting" value={fmt.count(a.gated.pending)} tone={a.gated.pending > 0 ? colors.amber : undefined} />
        </Group>
      )}

      {a && (
        // What the extractor read out of quiet conversations (15.2), and how
        // much of it survived review — the evidence for whether it is worth its
        // calls. Facts typed or saved in chat are not in either number.
        <Group testID="activity-facts" label="Facts from conversations">
          <Line label="Proposed" value={fmt.count(a.facts.proposed)} />
          <Line label="Kept" value={fmt.count(a.facts.kept)} />
        </Group>
      )}

      {a && a.tools.length > 0 && (
        <Group testID="activity-tools" label="Most used tools">
          {a.tools.map((t) => (
            <Line key={t.tool} label={t.tool} value={fmt.count(t.calls)} mono />
          ))}
        </Group>
      )}

      <Group testID="activity-spend" label="Estimated spend">
        <Line label="This week" value={fmt.usd(a?.spend.usd)} />
        <Line label="Month to date" value={fmt.usd(a?.spend_month.usd)} />
        {a && <Unpriced when="this week" spend={a.spend} />}
        {a && <Unpriced when="this month" spend={a.spend_month} />}
      </Group>

      <Group testID="activity-tokens" label="Tokens">
        <Line label="Input" value={fmt.count(a?.tokens.input)} />
        <Line label="Output" value={fmt.count(a?.tokens.output)} />
        <Line label="Cache reads" value={fmt.count(a?.tokens.cache_read)} />
        <Line label="Cache writes" value={fmt.count(a?.tokens.cache_write)} />
      </Group>
    </Card>
  );
}

/**
 * Tokens the server could not price, named rather than guessed. Drawn only
 * when there are some: a row of zeros for a table that covers every model the
 * picker offers would be noise.
 */
function Unpriced({ when, spend }: { when: string; spend: Spend }) {
  if (spend.unpriced_models.length === 0) return null;

  return (
    <Line
      label={`Not priced ${when} (${spend.unpriced_models.join(", ")})`}
      value={`${fmt.count(spend.unpriced_tokens)} tokens`}
    />
  );
}
