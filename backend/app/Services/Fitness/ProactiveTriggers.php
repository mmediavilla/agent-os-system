<?php

namespace App\Services\Fitness;

use Carbon\Carbon;

/**
 * Decides whether the assistant has anything worth saying, unprompted.
 *
 * The whole point of this class is that it costs nothing to run. Scheduling
 * "ask Claude every morning whether anything is interesting" pays for a model
 * call every day to be told "no" on most of them, and pays again in trust the
 * first time it invents something to justify the call. So the deterministic
 * layer decides *whether* to speak and supplies the numbers; the model only
 * writes the prose.
 *
 * `check()` is a pure function of one `FitnessStatsService::build()` payload —
 * no queries, no clock, no config. Today's date comes from `range.to`, which
 * the stats service has already resolved, so there is one source of truth for
 * "now" and a test can move time by editing an array.
 *
 * Every trigger carries its own `summary`: a sentence of finished, already-true
 * prose. That is what goes to the model, and it is what keeps the nudge honest
 * — the model rewrites sentences it was handed rather than reading a stats blob
 * and drawing its own conclusions from it.
 */
class ProactiveTriggers
{
    /**
     * The window the triggers are computed over.
     *
     * The plan said 4w. It has to be wider, because `volume.weeks` buckets to
     * the week's first day (Monday, or Sunday if chosen) from a grid that starts
     * on that day *on or before* the window,
     * while the daily facts start at the window itself — so the first bucket of
     * a 4w payload counts only the days from `from` onward and under-reports by
     * however far back that day is. A 4w window yields five buckets, one
     * truncated at each end, which leaves three usable weeks: not enough to
     * compare a week against the three before it without folding the truncated
     * one into the reference mean and quietly depressing it.
     */
    public const RANGE = '12w';

    /**
     * Every trigger's key, in `check()`'s priority order. The closed set Fitness
     * → Settings switches triggers on and off from; a test holds it to what
     * `check()` can actually return.
     */
    public const KEYS = ['layoff', 'volume_drop', 'new_pr', 'muscle_gap'];

    /** Muscle groups a gap is worth mentioning for. Mirrors PRIMARY_MUSCLES in the app, less Cardio and Other. */
    public const TRACKED_MUSCLES = ['Chest', 'Back', 'Shoulders', 'Biceps', 'Triceps', 'Legs', 'Glutes', 'Core'];

    /** Rest days before a layoff is worth mentioning. Three is a normal gap in most splits. */
    private const LAYOFF_MIN_DAYS = 4;

    /**
     * Past this the database is dormant, not lapsed, and nudging it is nagging
     * an inbox nobody is reading. Silence is the honest response to a year off.
     */
    private const LAYOFF_MAX_DAYS = 45;

    /** A week under this fraction of the reference mean counts as a drop. */
    private const DROP_THRESHOLD = 0.7;

    /** Weeks averaged to decide what "normal" is. */
    private const DROP_REFERENCE_WEEKS = 3;

    /** Below this the percentages are noise — 4 sets down from 6 is not a deload. */
    private const DROP_MIN_REFERENCE_SETS = 10;

    /** Share of the window's hard sets below which a muscle group is neglected. */
    private const MUSCLE_SHARE_FLOOR = 0.08;

    /** Shares computed off a handful of sets say nothing about a training split. */
    private const MUSCLE_MIN_TOTAL_SETS = 40;

    /**
     * Every share is a fraction of a total that includes the `Unknown` bucket, so
     * a catalog full of unmatched titles drags all of them down and manufactures
     * gaps. Past this the payload cannot support the claim.
     */
    private const MUSCLE_MAX_UNMATCHED_SHARE = 0.25;

    /** A nudge naming six neglected muscles is a spreadsheet, not a nudge. */
    private const MUSCLE_MAX_REPORTED = 2;

    /**
     * Triggers that fired, most urgent first.
     *
     * Order is priority order, and it is load-bearing twice: the nudge's title
     * comes from the first entry, and a reader skims the first sentence.
     *
     * @param  array  $stats  a `FitnessStatsService::build(self::RANGE)` payload
     * @return list<array{key: string, title: string, summary: string, cooldown_days: int, facts: array}>
     */
    public static function check(array $stats): array
    {
        $today = $stats['range']['to'] ?? now()->toDateString();

        return array_values(array_filter([
            self::layoff($stats, $today),
            self::volumeDrop($stats),
            self::newPr($stats, $today),
            self::muscleGap($stats),
        ]));
    }

    /**
     * `data_last` is the latest session in the whole database, not in the window,
     * so a layoff longer than the window still resolves to a real date.
     */
    private static function layoff(array $stats, string $today): ?array
    {
        $last = $stats['range']['data_last'] ?? null;
        if ($last === null) {
            return null;
        }

        // Signed, so a session dated in the future reads as negative and falls
        // below the floor rather than wrapping into a layoff.
        $days = (int) Carbon::parse($last)->startOfDay()
            ->diffInDays(Carbon::parse($today)->startOfDay(), false);

        if ($days < self::LAYOFF_MIN_DAYS || $days > self::LAYOFF_MAX_DAYS) {
            return null;
        }

        return [
            'key' => 'layoff',
            'title' => "{$days} days since your last session",
            'summary' => "You have not logged a session in {$days} days — the last one was on {$last}.",
            'cooldown_days' => 7,
            'facts' => ['days_since_last_session' => $days, 'last_session_date' => $last],
        ];
    }

    /**
     * Last completed week against the mean of the three before it.
     *
     * Both end buckets are dropped: the first is truncated by the window's start
     * (see RANGE) and the last is the week in progress, which is partial by
     * definition and would report a drop on the first morning of every week.
     * Neither depends on which day that is.
     */
    private static function volumeDrop(array $stats): ?array
    {
        $weeks = $stats['volume']['weeks'] ?? [];
        $usable = array_slice($weeks, 1, max(0, count($weeks) - 2));

        if (count($usable) < self::DROP_REFERENCE_WEEKS + 1) {
            return null;
        }

        $recent = $usable[count($usable) - 1];
        $reference = array_slice($usable, -1 - self::DROP_REFERENCE_WEEKS, self::DROP_REFERENCE_WEEKS);

        // A week with no sessions at all is a layoff, and the layoff trigger
        // says it better — with the real gap length rather than a percentage.
        if (((int) ($recent['sessions'] ?? 0)) === 0) {
            return null;
        }

        $mean = array_sum(array_column($reference, 'hard_sets')) / count($reference);
        if ($mean < self::DROP_MIN_REFERENCE_SETS) {
            return null;
        }

        $sets = (int) $recent['hard_sets'];
        if ($sets >= $mean * self::DROP_THRESHOLD) {
            return null;
        }

        $dropPct = (int) round((1 - $sets / $mean) * 100);
        $meanRounded = round($mean, 1);

        return [
            'key' => 'volume_drop',
            'title' => "Hard sets down {$dropPct}% last week",
            'summary' => "The week of {$recent['week_start']} had {$sets} hard sets, "
                ."down {$dropPct}% on the {$meanRounded} you averaged over the three weeks before it.",
            'cooldown_days' => 7,
            'facts' => [
                'week_start' => $recent['week_start'],
                'hard_sets' => $sets,
                'reference_mean_hard_sets' => $meanRounded,
                'drop_pct' => $dropPct,
            ],
        ];
    }

    /**
     * A record set yesterday, which for a job that runs each morning is the
     * training that just happened. `recent_prs` is already all-time — the stats
     * service compares against the best before the window, not within it.
     */
    private static function newPr(array $stats, string $today): ?array
    {
        $yesterday = Carbon::parse($today)->subDay()->toDateString();

        $prs = array_values(array_filter(
            $stats['strength']['recent_prs'] ?? [],
            fn (array $pr) => ($pr['date'] ?? null) === $yesterday,
        ));

        if ($prs === []) {
            return null;
        }

        $lines = array_map(
            fn (array $pr) => "{$pr['exercise_title']} {$pr['weight_kg']}kg × {$pr['reps']} "
                ."(estimated 1RM {$pr['e1rm_kg']}kg, up {$pr['gain_pct']}% on {$pr['previous_e1rm_kg']}kg)",
            $prs,
        );

        $count = count($prs);

        return [
            'key' => 'new_pr',
            'title' => $count === 1
                ? "New PR: {$prs[0]['exercise_title']}"
                : "{$count} new PRs yesterday",
            'summary' => "Yesterday ({$yesterday}) set "
                .($count === 1 ? 'a personal record' : "{$count} personal records")
                .': '.implode('; ', $lines).'.',
            'cooldown_days' => 7,
            'facts' => ['date' => $yesterday, 'prs' => $prs],
        ];
    }

    /**
     * Muscle groups carrying less than their share of the window's hard sets.
     *
     * The cooldown is four weeks rather than one because this is the only
     * structural trigger of the four: a split that neglects glutes today
     * neglects them next Monday too, and a weekly reminder of a fact that has
     * not changed is the fastest way to teach someone to ignore the card.
     */
    private static function muscleGap(array $stats): ?array
    {
        $muscles = $stats['muscles'] ?? [];
        $total = (int) ($muscles['total_hard_sets'] ?? 0);

        if ($total < self::MUSCLE_MIN_TOTAL_SETS) {
            return null;
        }

        if (((int) ($muscles['unmatched_sets'] ?? 0)) / $total > self::MUSCLE_MAX_UNMATCHED_SHARE) {
            return null;
        }

        $byMuscle = [];
        foreach ($muscles['items'] ?? [] as $item) {
            $byMuscle[$item['muscle']] = $item;
        }

        $gaps = [];
        foreach (self::TRACKED_MUSCLES as $muscle) {
            $share = (float) ($byMuscle[$muscle]['share'] ?? 0.0);
            if ($share < self::MUSCLE_SHARE_FLOOR) {
                $gaps[] = [
                    'muscle' => $muscle,
                    'share' => $share,
                    'hard_sets' => (int) ($byMuscle[$muscle]['hard_sets'] ?? 0),
                ];
            }
        }

        if ($gaps === []) {
            return null;
        }

        // Emptiest first; the name breaks ties so the same split always names
        // the same groups in the same order.
        usort($gaps, fn ($a, $b) => [$a['share'], $a['muscle']] <=> [$b['share'], $b['muscle']]);
        $gaps = array_slice($gaps, 0, self::MUSCLE_MAX_REPORTED);

        $lines = array_map(
            fn (array $g) => "{$g['muscle']} {$g['hard_sets']} sets (".round($g['share'] * 100, 1).'%)',
            $gaps,
        );

        return [
            'key' => 'muscle_gap',
            'title' => count($gaps) === 1
                ? "{$gaps[0]['muscle']} is under-trained"
                : implode(' and ', array_column($gaps, 'muscle')).' are under-trained',
            'summary' => 'Over the last 12 weeks '.implode(' and ', $lines)
                .", against {$total} hard sets in total — under the "
                .(self::MUSCLE_SHARE_FLOOR * 100).'% share worth keeping a group above.',
            'cooldown_days' => 28,
            'facts' => ['total_hard_sets' => $total, 'gaps' => $gaps],
        ];
    }
}
