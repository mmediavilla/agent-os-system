<?php

namespace App\Services;

use Carbon\Carbon;
use Carbon\CarbonInterface;
use Illuminate\Support\Facades\DB;

/**
 * Aggregates the Fitness → Home dashboard in a fixed number of queries.
 *
 * `GET /api/workouts` deliberately omits `sets`, so every metric worth charting
 * (tonnage, hard sets, muscle split, e1RM) is unreachable from the client without
 * an N+1 over every session. This service computes all of them server-side in six
 * grouped queries whose count does not grow with the number of workouts.
 */
class FitnessStatsService
{
    /** Selectable windows, in days. `all` is handled separately. */
    private const RANGES = ['4w' => 28, '12w' => 84, '1y' => 365];

    /**
     * A "hard set" is working volume: not a warmup, and it actually recorded
     * something. `failure` and `dropset` are working sets and count. Rows with no
     * metric at all would otherwise inflate every set count in the dashboard.
     */
    private const HARD_SET = "(s.set_type <> 'warmup' and (s.reps is not null or s.duration_seconds is not null or s.distance_km is not null))";

    /**
     * The e1RM expression per formula (`FitnessSettings::E1RM_FORMULAS`).
     *
     * Epley, weight × (1 + reps / 30), is the default because at 1 rep it returns
     * exactly the weight lifted. Brzycki, weight × 36 / (37 − reps), returns
     * w × 36/35 ≈ 1.029w on a single, so a heavy single reads ~3% high beside a
     * set of five. That is the user's choice to make, and it does not poison the
     * PR list: every point and every prior best in one payload uses the same
     * formula, so a lift is only ever compared with itself.
     */
    private const E1RM = [
        'epley' => '(s.weight_kg * (1 + s.reps / 30.0))',
        'brzycki' => '(s.weight_kg * 36.0 / (37 - s.reps))',
    ];

    /**
     * Both formulas' error grows materially past ~12 reps, so higher-rep sets get
     * no point. The cap is also what keeps Brzycki's denominator positive.
     */
    private const E1RM_MAX_REPS = 12;

    private const WEEK_START_DAYS = [
        'monday' => CarbonInterface::MONDAY,
        'sunday' => CarbonInterface::SUNDAY,
    ];

    /** A lift needs this many distinct days before a trend line means anything. */
    private const MIN_LIFT_DAYS = 3;

    /** Lifts charted in the strength panel. */
    private const MAX_LIFTS = 4;

    /** Entries in the recent-PR list. */
    private const MAX_PRS = 8;

    /**
     * @param  string  $requested  one of auto|4w|12w|1y|all
     */
    public function build(string $requested): array
    {
        // Read once per build, so one payload cannot mix two formulas or two
        // week origins if the setting is saved mid-request.
        $formula = FitnessSettings::e1rmFormula();
        $weekStart = FitnessSettings::weekStart();
        $weekDay = self::WEEK_START_DAYS[$weekStart];

        // Q1 — bounds. Also answers the `auto` range without an extra round-trip.
        $bounds = DB::table('workouts')
            ->selectRaw('min(started_at) as first_at, max(started_at) as last_at')
            ->first();

        $firstDay = $bounds->first_at ? Carbon::parse($bounds->first_at)->toDateString() : null;
        $lastDay = $bounds->last_at ? Carbon::parse($bounds->last_at)->toDateString() : null;

        [$resolved, $from] = $this->resolveRange($requested, $firstDay, $lastDay);

        $to = now()->startOfDay();
        // Half-open upper bound: everything up to the end of today. Sessions dated
        // in the future are excluded from every panel rather than counting toward
        // the KPIs while falling outside the heatmap grid.
        $toExclusive = $to->copy()->addDay();

        // The grid starts on the first day of the week (Monday unless chosen
        // otherwise) on or before the window, so heatmap columns and volume weeks
        // share one origin and cannot disagree about week borders.
        $gridFrom = $from->copy()->startOfWeek($weekDay);

        $days = $this->dailyFacts($from, $toExclusive);
        $muscles = $this->muscleSplit($from, $toExclusive);
        [$lifts, $prs] = $this->strength($from, $toExclusive, self::E1RM[$formula]);

        return [
            'range' => [
                'requested' => $requested,
                'resolved' => $resolved,
                'from' => $from->toDateString(),
                'to' => $to->toDateString(),
                'options' => [...array_keys(self::RANGES), 'all'],
                'data_first' => $firstDay,
                'data_last' => $lastDay,
            ],
            'kpis' => $this->kpis($days, $from, $to),
            'heatmap' => $this->heatmap($days, $gridFrom, $to),
            'volume' => $this->volume($days, $gridFrom, $to, $weekDay),
            'muscles' => $muscles,
            'strength' => ['lifts' => $lifts, 'recent_prs' => $prs],
            // Said in the payload, so every reader — the dashboard, the assistant,
            // the morning check — can name how its numbers were made.
            'settings' => ['e1rm_formula' => $formula, 'week_start' => $weekStart],
        ];
    }

    /**
     * `auto` widens until it finds data; an explicit range never does.
     *
     * Clicking "4w" on a stale database shows an empty 4w — that is the honest
     * answer, and the panels say so in words. Only the unasked-for default widens.
     * Windows anchor to today rather than sliding back to the last session, which
     * would quietly misreport how recently you trained.
     *
     * @return array{0: string, 1: Carbon}
     */
    private function resolveRange(string $requested, ?string $firstDay, ?string $lastDay): array
    {
        $today = now()->startOfDay();

        if ($requested !== 'auto') {
            $from = $requested === 'all'
                ? ($firstDay ? Carbon::parse($firstDay)->startOfDay() : $today->copy())
                : $today->copy()->subDays(self::RANGES[$requested] - 1);

            return [$requested, $from];
        }

        // An empty database gets the narrowest window, not "all of time".
        if ($lastDay === null) {
            return ['4w', $today->copy()->subDays(self::RANGES['4w'] - 1)];
        }

        foreach (self::RANGES as $key => $days) {
            $from = $today->copy()->subDays($days - 1);
            if (Carbon::parse($lastDay)->gte($from)) {
                return [$key, $from];
            }
        }

        return ['all', Carbon::parse($firstDay)->startOfDay()];
    }

    /**
     * Q2 + Q3 — one row per calendar day that had a session.
     *
     * Session facts and set facts are queried separately and merged in PHP: joining
     * `workout_sets` into the session query would fan each workout out per set and
     * multiply its duration by its set count.
     *
     * @return array<string, array{sessions:int, hard_sets:int, tonnage:float, duration_min:float, timed:int}>
     */
    private function dailyFacts(Carbon $from, Carbon $toExclusive): array
    {
        $sessions = DB::table('workouts')
            ->selectRaw('date(started_at) as day')
            ->selectRaw('count(*) as sessions')
            // `duration_minutes` is a PHP accessor on the model, not a column, so
            // the SQL side has to derive it.
            ->selectRaw('sum(case when ended_at is not null then (julianday(ended_at) - julianday(started_at)) * 1440.0 else 0 end) as duration_min')
            ->selectRaw('sum(case when ended_at is not null then 1 else 0 end) as timed')
            ->where('started_at', '>=', $from)
            ->where('started_at', '<', $toExclusive)
            ->groupBy('day')
            ->get();

        $sets = DB::table('workouts as w')
            ->join('workout_sets as s', 's.workout_id', '=', 'w.id')
            ->selectRaw('date(w.started_at) as day')
            ->selectRaw('sum(case when '.self::HARD_SET.' then 1 else 0 end) as hard_sets')
            ->selectRaw('coalesce(sum(case when '.self::HARD_SET.' then coalesce(s.weight_kg, 0) * coalesce(s.reps, 0) else 0 end), 0) as tonnage')
            ->where('w.started_at', '>=', $from)
            ->where('w.started_at', '<', $toExclusive)
            ->groupBy('day')
            ->get()
            ->keyBy('day');

        $out = [];
        foreach ($sessions as $row) {
            $setRow = $sets->get($row->day);
            $out[$row->day] = [
                'sessions' => (int) $row->sessions,
                'timed' => (int) $row->timed,
                'duration_min' => (float) $row->duration_min,
                'hard_sets' => (int) ($setRow->hard_sets ?? 0),
                'tonnage' => (float) ($setRow->tonnage ?? 0),
            ];
        }
        ksort($out);

        return $out;
    }

    private function kpis(array $days, Carbon $from, Carbon $to): array
    {
        $sessions = array_sum(array_column($days, 'sessions'));
        $timed = array_sum(array_column($days, 'timed'));
        $duration = array_sum(array_column($days, 'duration_min'));
        $windowDays = max(1, $from->diffInDays($to) + 1);

        return [
            'sessions' => $sessions,
            'hard_sets' => array_sum(array_column($days, 'hard_sets')),
            'tonnage_kg' => round(array_sum(array_column($days, 'tonnage')), 1),
            'avg_duration_min' => $timed > 0 ? round($duration / $timed, 1) : 0.0,
            'sessions_per_week' => round($sessions / ($windowDays / 7), 1),
        ];
    }

    /**
     * Sparse: only days that had a session. The client zero-fills the grid, which
     * keeps the payload at ~72 rows instead of 366.
     */
    private function heatmap(array $days, Carbon $gridFrom, Carbon $to): array
    {
        $out = [];
        foreach ($days as $date => $d) {
            $out[] = [
                'date' => $date,
                'sessions' => $d['sessions'],
                'hard_sets' => $d['hard_sets'],
                'tonnage_kg' => round($d['tonnage'], 1),
                'duration_min' => round($d['duration_min'], 1),
            ];
        }

        return [
            'from' => $gridFrom->toDateString(),
            'to' => $to->toDateString(),
            'max_hard_sets' => $days ? max(array_column($days, 'hard_sets')) : 0,
            'days' => $out,
        ];
    }

    /**
     * Dense: every week in the window, zero-filled.
     *
     * The gaps are the point — a month you did not train has to render as empty
     * bars, not get compressed out of the axis. Bucketing happens here rather than
     * in SQL because SQLite has no `date_trunc` and `strftime('%W')` misbehaves at
     * year boundaries; we already hold the day rows in memory.
     */
    private function volume(array $days, Carbon $gridFrom, Carbon $to, int $weekDay): array
    {
        $weeks = [];
        $cursor = $gridFrom->copy();
        while ($cursor->lte($to)) {
            $weeks[$cursor->toDateString()] = [
                'week_start' => $cursor->toDateString(),
                'sessions' => 0,
                'hard_sets' => 0,
                'tonnage_kg' => 0.0,
            ];
            $cursor->addWeek();
        }

        foreach ($days as $date => $d) {
            $key = Carbon::parse($date)->startOfWeek($weekDay)->toDateString();
            if (! isset($weeks[$key])) {
                continue;
            }
            $weeks[$key]['sessions'] += $d['sessions'];
            $weeks[$key]['hard_sets'] += $d['hard_sets'];
            $weeks[$key]['tonnage_kg'] += $d['tonnage'];
        }

        $weeks = array_values(array_map(function (array $w) {
            $w['tonnage_kg'] = round($w['tonnage_kg'], 1);

            return $w;
        }, $weeks));

        return [
            'weeks' => $weeks,
            'max_tonnage_kg' => $weeks ? max(array_column($weeks, 'tonnage_kg')) : 0.0,
            'max_hard_sets' => $weeks ? max(array_column($weeks, 'hard_sets')) : 0,
        ];
    }

    /**
     * Q4 — hard sets per primary muscle.
     *
     * `workout_sets.exercise_title` is a denormalised string, so the catalog join is
     * a name match. It is deduped first, and the reason changed with the owner
     * backfill: `exercises` has unique(user_id, name), which was inert while every
     * `user_id` was null — SQL counts each null as distinct — so two rows called
     * "Bench Press" were simply possible. They no longer are for one owner, but the
     * index is scoped *per* owner and this subquery is not, so the same name can
     * still arrive twice from two owners and a plain join would double-count the
     * set. Unmatched titles land in a visible `Unknown` bucket rather than vanishing
     * from the totals.
     */
    private function muscleSplit(Carbon $from, Carbon $toExclusive): array
    {
        $catalog = DB::table('exercises')
            ->selectRaw('name, min(primary_muscle) as primary_muscle')
            ->groupBy('name');

        $rows = DB::table('workout_sets as s')
            ->join('workouts as w', 'w.id', '=', 's.workout_id')
            ->leftJoinSub($catalog, 'e', 'e.name', '=', 's.exercise_title')
            ->selectRaw("coalesce(e.primary_muscle, 'Unknown') as muscle")
            ->selectRaw('count(s.id) as hard_sets')
            ->selectRaw('coalesce(sum(coalesce(s.weight_kg, 0) * coalesce(s.reps, 0)), 0) as tonnage')
            ->where('w.started_at', '>=', $from)
            ->where('w.started_at', '<', $toExclusive)
            ->whereRaw(self::HARD_SET)
            ->groupBy('muscle')
            ->orderByDesc('hard_sets')
            ->get();

        $total = (int) $rows->sum('hard_sets');

        return [
            'total_hard_sets' => $total,
            'unmatched_sets' => (int) ($rows->firstWhere('muscle', 'Unknown')->hard_sets ?? 0),
            'items' => $rows->map(fn ($r) => [
                'muscle' => $r->muscle,
                'hard_sets' => (int) $r->hard_sets,
                'tonnage_kg' => round((float) $r->tonnage, 1),
                'share' => $total > 0 ? round($r->hard_sets / $total, 4) : 0.0,
            ])->all(),
        ];
    }

    /**
     * Q5 + Q6 — estimated-1RM trend per lift, and PRs.
     *
     * Warmups, unloaded sets and sets above the rep cap produce no point: a
     * bodyweight set has no barbell load, and a zero load would plant a false
     * floor that makes every later session look like a personal record.
     *
     * @return array{0: list<array>, 1: list<array>}
     */
    private function strength(Carbon $from, Carbon $toExclusive, string $e1rm): array
    {
        $catalog = DB::table('exercises')
            ->selectRaw('name, min(primary_muscle) as primary_muscle')
            ->groupBy('name');

        $points = DB::table('workout_sets as s')
            ->join('workouts as w', 'w.id', '=', 's.workout_id')
            ->leftJoinSub($catalog, 'e', 'e.name', '=', 's.exercise_title')
            ->selectRaw('s.exercise_title as title')
            ->selectRaw('date(w.started_at) as day')
            ->selectRaw('e.primary_muscle as muscle')
            ->selectRaw('max('.$e1rm.') as e1rm')
            // Bare columns beside a single max(): SQLite returns them from the row
            // that produced the maximum, so these are the weight and reps of the
            // best set of the day rather than arbitrary ones. Asserted in the tests.
            ->selectRaw('s.weight_kg as weight_kg')
            ->selectRaw('s.reps as reps')
            ->where('w.started_at', '>=', $from)
            ->where('w.started_at', '<', $toExclusive)
            ->where('s.set_type', '<>', 'warmup')
            ->where('s.weight_kg', '>', 0)
            ->whereBetween('s.reps', [1, self::E1RM_MAX_REPS])
            ->groupBy('title', 'day', 'muscle')
            ->orderBy('title')
            ->orderBy('day')
            ->get();

        // Q6 — the best each lift ever hit *before* this window. Without it, asking
        // for 4w would call a lift a PR even though you lifted heavier last year.
        $priorBest = DB::table('workout_sets as s')
            ->join('workouts as w', 'w.id', '=', 's.workout_id')
            ->selectRaw('s.exercise_title as title')
            ->selectRaw('max('.$e1rm.') as best')
            ->where('w.started_at', '<', $from)
            ->where('s.set_type', '<>', 'warmup')
            ->where('s.weight_kg', '>', 0)
            ->whereBetween('s.reps', [1, self::E1RM_MAX_REPS])
            ->groupBy('title')
            ->get()
            ->pluck('best', 'title');

        $byTitle = [];
        foreach ($points as $p) {
            $byTitle[$p->title][] = $p;
        }

        $lifts = [];
        $prs = [];

        foreach ($byTitle as $title => $rows) {
            $best = (float) ($priorBest[$title] ?? 0);
            $hasHistory = isset($priorBest[$title]);

            foreach ($rows as $r) {
                $e1rm = (float) $r->e1rm;
                // 0.1% epsilon: floats that round-trip to the same displayed number
                // must not re-announce themselves as a record every session.
                if ($hasHistory && $e1rm > $best * 1.001) {
                    $prs[] = [
                        'exercise_title' => $title,
                        'date' => $r->day,
                        'e1rm_kg' => round($e1rm, 1),
                        'weight_kg' => (float) $r->weight_kg,
                        'reps' => (int) $r->reps,
                        'previous_e1rm_kg' => round($best, 1),
                        'gain_pct' => round((($e1rm - $best) / $best) * 100, 1),
                    ];
                }
                if ($e1rm > $best) {
                    $best = $e1rm;
                }
                $hasHistory = true;
            }

            if (count($rows) < self::MIN_LIFT_DAYS) {
                continue;
            }

            $values = array_map(fn ($r) => (float) $r->e1rm, $rows);
            $first = $values[0];
            $latest = end($values);

            $lifts[] = [
                'exercise_title' => $title,
                'primary_muscle' => $rows[0]->muscle,
                'points' => array_map(fn ($r) => [
                    'date' => $r->day,
                    'e1rm_kg' => round((float) $r->e1rm, 1),
                    'weight_kg' => (float) $r->weight_kg,
                    'reps' => (int) $r->reps,
                ], $rows),
                'first_e1rm_kg' => round($first, 1),
                'latest_e1rm_kg' => round($latest, 1),
                'best_e1rm_kg' => round(max($values), 1),
                'change_pct' => $first > 0 ? round((($latest - $first) / $first) * 100, 1) : 0.0,
            ];
        }

        // Most-trained lifts first; ties broken deterministically so the panel does
        // not reshuffle between identical requests.
        usort($lifts, fn ($a, $b) => [count($b['points']), $b['latest_e1rm_kg'], $a['exercise_title']]
            <=> [count($a['points']), $a['latest_e1rm_kg'], $b['exercise_title']]);

        usort($prs, fn ($a, $b) => [$b['date'], $b['gain_pct']] <=> [$a['date'], $a['gain_pct']]);

        return [
            array_slice($lifts, 0, self::MAX_LIFTS),
            array_slice($prs, 0, self::MAX_PRS),
        ];
    }
}
