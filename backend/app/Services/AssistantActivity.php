<?php

namespace App\Services;

use App\Agent\RunOutcome;
use App\Models\AgentAction;
use App\Models\AgentRun;
use App\Models\Fact;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;

/**
 * What the assistant holds and what it has done lately — Assistant → Activity.
 *
 * It sits in the Assistant overlay rather than in Stats (the owner's call): threads,
 * runs, tool calls and tokens are the assistant's record, read beside its chat
 * and its settings. Stats keeps what is about the machine.
 *
 * **Live, not cached.** Every number is an indexed aggregate over a one-user
 * SQLite file, read while someone is looking at the tab. A cached count is
 * visibly wrong the moment a run finishes, and a polled read that writes cache
 * rows would be a new writer against the WAL database the worker is writing to
 * (see *Platform traps*). So this class never writes.
 *
 * **Zero is a real answer here** — a sum over an empty week genuinely is zero —
 * so only the two `last_*_at` fields are ever null.
 */
final class AssistantActivity
{
    /**
     * The window the activity is counted over, on the user's own days.
     *
     * A constant rather than an `.env` line: `.env` in this repo is secrets,
     * paths and per-machine tuning, and a reporting window is a design choice,
     * like `E1RM_MAX_REPS`. Seven because shorter is mostly zeros at this
     * assistant's cadence. The payload names it, so the screen never has to.
     */
    public const WINDOW_DAYS = 7;

    /** How many of the most-called tools are listed. */
    public const TOP_TOOLS = 5;

    /**
     * @return array<string, mixed>
     */
    public function current(): array
    {
        $since = $this->since();

        return [
            'generated_at' => CarbonImmutable::now()->toIso8601String(),
            'window' => [
                'days' => self::WINDOW_DAYS,
                'since' => $since->setTimezone($this->zone())->toIso8601String(),
                'timezone' => $this->zone(),
            ],
            ...$this->records($since),
            ...$this->activity($since),
        ];
    }

    /**
     * The start of the window: midnight on the user's day, six days back, as a
     * UTC instant — the precedent is `SnapshotStore::takenToday()`. On UTC's day
     * instead, the first eight hours of every Manila morning would count one day
     * too many.
     */
    private function since(): CarbonImmutable
    {
        return CarbonImmutable::now($this->zone())
            ->startOfDay()
            ->subDays(self::WINDOW_DAYS - 1)
            ->utc();
    }

    private function zone(): string
    {
        return (string) config('agent.timezone', 'UTC');
    }

    /**
     * Everything the assistant has ever kept, in one round trip: scalar
     * subqueries rather than six `count()` calls — the same index scans, one
     * statement.
     *
     * @return array{records: array<string, int|string|null>, facts: array{proposed: int, kept: int}}
     */
    private function records(CarbonImmutable $since): array
    {
        // The week's extraction rides this statement rather than adding one:
        // what the extractor proposed (by when it was learned) and how many of
        // those the owner kept (by when they decided). A kept fact later
        // replaced is `superseded`, and still counts as kept.
        $row = DB::selectOne(<<<'SQL'
            select
                (select count(*) from conversations) as conversations,
                (select count(*) from conversation_messages) as messages,
                (select max(last_message_at) from conversations) as last_conversation_at,
                (select count(*) from insights) as insights,
                (select max(created_at) from insights) as last_insight_at,
                (select count(*) from snapshots) as snapshots,
                (select count(*) from facts where status = ?) as facts,
                (select count(*) from facts where source = ? and learned_at >= ?) as facts_proposed,
                (select count(*) from facts where source = ? and status in (?, ?) and decided_at >= ?) as facts_kept
            SQL, [
            Fact::ACTIVE,
            'extracted', $since,
            'extracted', Fact::ACTIVE, Fact::SUPERSEDED, $since,
        ]);

        return [
            'records' => [
                'conversations' => (int) $row->conversations,
                'messages' => (int) $row->messages,
                'insights' => (int) $row->insights,
                'snapshots' => (int) $row->snapshots,
                'facts' => (int) $row->facts,
                'last_conversation_at' => self::instant($row->last_conversation_at),
                'last_insight_at' => self::instant($row->last_insight_at),
            ],
            'facts' => [
                'proposed' => (int) $row->facts_proposed,
                'kept' => (int) $row->facts_kept,
            ],
        ];
    }

    /**
     * @return array<string, mixed>
     */
    private function activity(CarbonImmutable $since): array
    {
        // Every status is a key, zero where there were none, so the screen never
        // has to tell "none" from "missing". A status outside the closed set (a
        // hand-edited row) is dropped rather than inventing a label.
        $runs = array_fill_keys([
            AgentRun::QUEUED,
            AgentRun::RUNNING,
            RunOutcome::COMPLETED,
            RunOutcome::AWAITING_CONFIRMATION,
            RunOutcome::MAX_ITERATIONS,
            AgentRun::FAILED,
        ], 0);

        $byStatus = DB::table('agent_runs')
            ->where('created_at', '>=', $since)
            ->selectRaw('status, count(*) as n')
            ->groupBy('status')
            ->pluck('n', 'status');

        foreach ($byStatus as $status => $n) {
            if (array_key_exists($status, $runs)) {
                $runs[$status] = (int) $n;
            }
        }

        // The approvals are counted on `requires_confirmation` *and* status,
        // because every read is born `approved` — `status = 'approved'` alone
        // would report each `get_fitness_stats` as a write the owner waved
        // through.
        $actions = DB::table('agent_actions')
            ->where('created_at', '>=', $since)
            ->selectRaw(
                'count(*) as calls,
                 coalesce(sum(case when is_error then 1 else 0 end), 0) as errors,
                 coalesce(sum(case when requires_confirmation and status = ? then 1 else 0 end), 0) as approved,
                 coalesce(sum(case when requires_confirmation and status = ? then 1 else 0 end), 0) as rejected,
                 coalesce(sum(case when requires_confirmation and status = ? then 1 else 0 end), 0) as pending',
                [AgentAction::APPROVED, AgentAction::REJECTED, AgentAction::PENDING],
            )
            ->first();

        $tools = DB::table('agent_actions')
            ->where('created_at', '>=', $since)
            ->selectRaw('tool, count(*) as calls')
            ->groupBy('tool')
            ->orderByDesc('calls')
            ->orderBy('tool')
            ->limit(self::TOP_TOOLS)
            ->get()
            ->map(fn (object $row) => ['tool' => (string) $row->tool, 'calls' => (int) $row->calls])
            ->all();

        // Every paid call as one total: the question is what the assistant
        // spent this week, not which writer spent it. Read off the ledger and
        // not off the turns and insights that carry a `usage` of their own,
        // because those go when a thread is deleted and the spend does not.
        // Per model, because the same token costs 2.5× more on Opus, and for
        // the month in the same statement, because the month is what the
        // invoice is.
        $month = $this->monthStart();
        $byModel = $this->tokens($since, $month);

        $week = array_map(fn (array $row) => ['model' => $row['model'], 'tokens' => $row['week']], $byModel);
        $monthly = array_map(fn (array $row) => ['model' => $row['model'], 'tokens' => $row['month']], $byModel);

        $tokens = ['input' => 0, 'output' => 0, 'cache_read' => 0, 'cache_write' => 0];
        foreach ($week as $row) {
            foreach (array_keys($tokens) as $key) {
                $tokens[$key] += $row['tokens'][$key];
            }
        }

        return [
            'runs' => $runs,
            'tool_calls' => (int) $actions->calls,
            'tool_errors' => (int) $actions->errors,
            'gated' => [
                'approved' => (int) $actions->approved,
                'rejected' => (int) $actions->rejected,
                'pending' => (int) $actions->pending,
            ],
            'tools' => $tools,
            'tokens' => $tokens,
            'spend' => $this->spend($week),
            'spend_month' => [
                ...$this->spend($monthly),
                'since' => $month->setTimezone($this->zone())->toIso8601String(),
            ],
        ];
    }

    /**
     * Midnight on the first of the user's month, as a UTC instant — `since()`'s
     * rule, for the same reason: on UTC's calendar the first eight hours of the
     * 1st in Manila would still be last month.
     *
     * Not Anthropic's billing period, which this app cannot read; a calendar
     * month is the closest thing it can name, and the tab says which it is.
     */
    private function monthStart(): CarbonImmutable
    {
        return CarbonImmutable::now($this->zone())->startOfMonth()->utc();
    }

    /**
     * What those tokens cost at list price — an estimate, never the bill.
     *
     * Anthropic reports no balance ({@see AnthropicCredit}), so this is the one
     * spend figure the app can show. It leaves out what it cannot price: a model
     * missing from {@see AnthropicPricing} is named rather than guessed.
     *
     * @param  list<array{model: string|null, tokens: array{input: int, output: int, cache_read: int, cache_write: int}}>  $byModel
     * @return array{usd: float, unpriced_models: list<string>, unpriced_tokens: int, prices_as_of: string}
     */
    private function spend(array $byModel): array
    {
        $usd = 0.0;
        $unpriced = [];
        $unpricedTokens = 0;

        foreach ($byModel as $row) {
            $cost = AnthropicPricing::cost($row['model'], $row['tokens']);

            if ($cost !== null) {
                $usd += $cost;

                continue;
            }

            $count = array_sum($row['tokens']);
            if ($count > 0) {
                $unpriced[] = $row['model'] ?? 'unknown';
                $unpricedTokens += $count;
            }
        }

        return [
            'usd' => round($usd, 4),
            'unpriced_models' => array_values(array_unique($unpriced)),
            'unpriced_tokens' => $unpricedTokens,
            'prices_as_of' => AnthropicPricing::AS_OF,
        ];
    }

    /**
     * The four token counts every paid call reported, summed per model over the
     * week and over the month — off {@see AnthropicUsage}'s ledger.
     *
     * Always behind the ranged `created_at` predicate, which is the ledger's one
     * index — an all-time total would be a scan that grows forever for a number
     * nobody acts on. `coalesce` because `sum()` over nothing is null.
     *
     * One statement: grouping by `model` adds rows, not queries, and the two
     * windows are conditional sums over whichever starts first — the week
     * reaches back into last month for its first six days of every month, and
     * the month is longer than the week the rest of the time. So the endpoint
     * stays under the statement count `AssistantActivityTest` caps.
     *
     * @return list<array{model: string|null, week: array{input: int, output: int, cache_read: int, cache_write: int}, month: array{input: int, output: int, cache_read: int, cache_write: int}}>
     */
    private function tokens(CarbonImmutable $week, CarbonImmutable $month): array
    {
        $fields = [
            'input' => 'input_tokens',
            'output' => 'output_tokens',
            'cache_read' => 'cache_read_tokens',
            'cache_write' => 'cache_write_tokens',
        ];

        $columns = ['model'];
        $bindings = [];
        foreach (['week' => $week, 'month' => $month] as $window => $from) {
            foreach ($fields as $key => $column) {
                $columns[] = "coalesce(sum(case when created_at >= ? then {$column} end), 0) as {$window}_{$key}";
                $bindings[] = $from;
            }
        }

        return DB::table(AnthropicUsage::TABLE)
            ->where('created_at', '>=', $week->min($month))
            ->selectRaw(implode(', ', $columns), $bindings)
            ->groupBy('model')
            ->get()
            ->map(function (object $row) use ($fields) {
                $read = fn (string $window) => array_combine(
                    array_keys($fields),
                    array_map(fn (string $key) => (int) $row->{"{$window}_{$key}"}, array_keys($fields)),
                );

                return [
                    'model' => $row->model === null ? null : (string) $row->model,
                    'week' => $read('week'),
                    'month' => $read('month'),
                ];
            })
            ->values()
            ->all();
    }

    /** A stored UTC timestamp as an ISO 8601 instant, or null. */
    private static function instant(?string $value): ?string
    {
        return $value === null ? null : CarbonImmutable::parse($value, 'UTC')->toIso8601String();
    }
}
