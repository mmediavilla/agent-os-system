<?php

namespace Tests\Unit\Fitness;

use App\Services\Fitness\ProactiveTriggers;
use PHPUnit\Framework\TestCase;

/**
 * `check()` takes a stats payload and returns triggers — no database, no clock,
 * no container — so every case here is an array literal and the whole file runs
 * without a Laravel application. That is the point of keeping the decision
 * layer pure: the expensive half of the proactive feature is the half that
 * never calls anything.
 */
class ProactiveTriggersTest extends TestCase
{
    private const TODAY = '2026-09-04';   // a Friday

    /**
     * A payload where nothing fires. Every test below is this, with one thing
     * changed, so a trigger firing is always attributable.
     */
    private function stats(array $overrides = []): array
    {
        $base = [
            'range' => ['to' => self::TODAY, 'data_last' => '2026-09-03'],
            'volume' => ['weeks' => $this->weeks(20, 20, 20, 20, 20, 6)],
            'strength' => ['recent_prs' => []],
            'muscles' => [
                'total_hard_sets' => 200,
                'unmatched_sets' => 0,
                'items' => array_map(fn (string $m) => [
                    'muscle' => $m,
                    'hard_sets' => 25,
                    'share' => 0.125,
                ], ProactiveTriggers::TRACKED_MUSCLES),
            ],
        ];

        foreach ($overrides as $section => $values) {
            $base[$section] = array_merge($base[$section], $values);
        }

        return $base;
    }

    /** Consecutive Monday-started weeks, oldest first, carrying the given hard-set counts. */
    private function weeks(int ...$hardSets): array
    {
        return $this->weeksFrom('2026-08-03', ...$hardSets);   // a Monday
    }

    private function weeksFrom(string $origin, int ...$hardSets): array
    {
        $out = [];
        $first = new \DateTimeImmutable($origin);

        foreach ($hardSets as $i => $sets) {
            $out[] = [
                'week_start' => $first->modify("+{$i} weeks")->format('Y-m-d'),
                'sessions' => $sets > 0 ? 3 : 0,
                'hard_sets' => $sets,
                'tonnage_kg' => $sets * 500.0,
            ];
        }

        return $out;
    }

    /** @return list<string> */
    private function keys(array $stats): array
    {
        return array_column(ProactiveTriggers::check($stats), 'key');
    }

    private function trigger(array $stats, string $key): ?array
    {
        foreach (ProactiveTriggers::check($stats) as $trigger) {
            if ($trigger['key'] === $key) {
                return $trigger;
            }
        }

        return null;
    }

    public function test_a_normal_week_says_nothing(): void
    {
        $this->assertSame([], ProactiveTriggers::check($this->stats()));
    }

    // ── Layoff ────────────────────────────────────────────────────────────────

    public function test_four_days_without_a_session_fires(): void
    {
        $t = $this->trigger($this->stats(['range' => ['data_last' => '2026-08-31']]), 'layoff');

        $this->assertNotNull($t);
        $this->assertSame(4, $t['facts']['days_since_last_session']);
        $this->assertStringContainsString('4 days', $t['summary']);
    }

    public function test_three_rest_days_are_just_rest(): void
    {
        $this->assertNotContains('layoff', $this->keys(
            $this->stats(['range' => ['data_last' => '2026-09-01']])
        ));
    }

    public function test_a_dormant_database_is_left_alone(): void
    {
        // Six months off is not a lapse to be nudged out of, and a weekly
        // reminder of it would run forever.
        $this->assertNotContains('layoff', $this->keys(
            $this->stats(['range' => ['data_last' => '2026-03-01']])
        ));
    }

    public function test_a_session_dated_in_the_future_is_not_a_layoff(): void
    {
        $this->assertNotContains('layoff', $this->keys(
            $this->stats(['range' => ['data_last' => '2026-09-20']])
        ));
    }

    public function test_an_empty_database_fires_nothing_at_all(): void
    {
        $empty = [
            'range' => ['to' => self::TODAY, 'data_last' => null],
            'volume' => ['weeks' => $this->weeks(0, 0, 0, 0, 0, 0)],
            'strength' => ['recent_prs' => []],
            'muscles' => ['total_hard_sets' => 0, 'unmatched_sets' => 0, 'items' => []],
        ];

        $this->assertSame([], ProactiveTriggers::check($empty));
    }

    // ── Volume drop ───────────────────────────────────────────────────────────

    public function test_a_third_off_last_week_fires(): void
    {
        $t = $this->trigger(
            $this->stats(['volume' => ['weeks' => $this->weeks(20, 20, 20, 20, 12, 6)]]),
            'volume_drop',
        );

        $this->assertNotNull($t);
        $this->assertSame(40, $t['facts']['drop_pct']);
        $this->assertSame(12, $t['facts']['hard_sets']);
        $this->assertSame(20.0, $t['facts']['reference_mean_hard_sets']);
    }

    public function test_a_sunday_origin_judges_the_same_completed_week(): void
    {
        // Weeks starting on Sunday (Fitness → Settings) shift every bucket back a
        // day. Today is still inside the last one, so dropping both end buckets
        // still leaves exactly the completed weeks.
        $sundays = $this->weeksFrom('2026-08-02', 20, 20, 20, 20, 12, 6);
        $t = $this->trigger($this->stats(['volume' => ['weeks' => $sundays]]), 'volume_drop');

        $this->assertNotNull($t);
        $this->assertSame('2026-08-30', $t['facts']['week_start']);
        $this->assertSame(40, $t['facts']['drop_pct']);

        $this->assertNotContains('volume_drop', $this->keys(
            $this->stats(['volume' => ['weeks' => $this->weeksFrom('2026-08-02', 20, 20, 20, 20, 20, 1)]])
        ));
    }

    public function test_the_week_in_progress_is_not_the_week_being_judged(): void
    {
        // The last bucket is always partial — on a Monday morning it holds
        // nothing at all — so reading it as "last week" reports a collapse
        // every single week.
        $this->assertNotContains('volume_drop', $this->keys(
            $this->stats(['volume' => ['weeks' => $this->weeks(20, 20, 20, 20, 20, 1)]])
        ));
    }

    public function test_the_truncated_first_bucket_stays_out_of_the_reference_mean(): void
    {
        // Bucket 0 is clipped by the start of the window and holds 2 sets. Folded
        // into the mean it would drag the reference to 14 and silence a real 40%
        // drop; excluded, the mean is 20 and the drop is reported.
        $t = $this->trigger(
            $this->stats(['volume' => ['weeks' => $this->weeks(2, 20, 20, 20, 12, 6)]]),
            'volume_drop',
        );

        $this->assertNotNull($t);
        $this->assertSame(40, $t['facts']['drop_pct']);
    }

    public function test_a_tiny_reference_week_is_not_a_baseline(): void
    {
        // 8 → 4 is halved and means nothing; percentages need a real denominator.
        $this->assertNotContains('volume_drop', $this->keys(
            $this->stats(['volume' => ['weeks' => $this->weeks(8, 8, 8, 8, 4, 2)]])
        ));
    }

    public function test_a_week_with_no_sessions_is_left_to_the_layoff_trigger(): void
    {
        $keys = $this->keys($this->stats([
            'range' => ['data_last' => '2026-08-28'],
            'volume' => ['weeks' => $this->weeks(20, 20, 20, 20, 0, 0)],
        ]));

        $this->assertContains('layoff', $keys);
        $this->assertNotContains('volume_drop', $keys);
    }

    public function test_too_few_weeks_to_compare_says_nothing(): void
    {
        // Four buckets leave two usable once both ends are dropped.
        $this->assertNotContains('volume_drop', $this->keys(
            $this->stats(['volume' => ['weeks' => $this->weeks(20, 20, 20, 4)]])
        ));
    }

    // ── PRs ───────────────────────────────────────────────────────────────────

    private function pr(string $date): array
    {
        return [
            'exercise_title' => 'Bench Press',
            'date' => $date,
            'e1rm_kg' => 120.0,
            'weight_kg' => 100.0,
            'reps' => 6,
            'previous_e1rm_kg' => 115.0,
            'gain_pct' => 4.3,
        ];
    }

    public function test_a_record_set_yesterday_fires(): void
    {
        $t = $this->trigger(
            $this->stats(['strength' => ['recent_prs' => [$this->pr('2026-09-03')]]]),
            'new_pr',
        );

        $this->assertNotNull($t);
        $this->assertSame('New PR: Bench Press', $t['title']);
        $this->assertStringContainsString('100kg × 6', $t['summary']);
    }

    public function test_an_older_record_has_already_been_mentioned(): void
    {
        $this->assertNotContains('new_pr', $this->keys(
            $this->stats(['strength' => ['recent_prs' => [$this->pr('2026-09-01')]]])
        ));
    }

    public function test_several_records_on_one_day_become_one_trigger(): void
    {
        $t = $this->trigger($this->stats(['strength' => ['recent_prs' => [
            $this->pr('2026-09-03'),
            array_merge($this->pr('2026-09-03'), ['exercise_title' => 'Back Squat']),
            $this->pr('2026-08-20'),
        ]]]), 'new_pr');

        $this->assertNotNull($t);
        $this->assertSame('2 new PRs yesterday', $t['title']);
        $this->assertCount(2, $t['facts']['prs']);
    }

    // ── Muscle gaps ───────────────────────────────────────────────────────────

    /** An even split with the named muscles pushed down to the given set counts. */
    private function split(array $sets): array
    {
        $counts = array_fill_keys(ProactiveTriggers::TRACKED_MUSCLES, 25);
        foreach ($sets as $muscle => $n) {
            $counts[$muscle] = $n;
        }
        $total = array_sum($counts);

        return [
            'total_hard_sets' => $total,
            'unmatched_sets' => 0,
            'items' => array_map(fn (string $m) => [
                'muscle' => $m,
                'hard_sets' => $counts[$m],
                'share' => round($counts[$m] / $total, 4),
            ], ProactiveTriggers::TRACKED_MUSCLES),
        ];
    }

    public function test_the_two_emptiest_groups_are_named(): void
    {
        $t = $this->trigger(
            $this->stats(['muscles' => $this->split(['Glutes' => 2, 'Core' => 5, 'Biceps' => 9])]),
            'muscle_gap',
        );

        $this->assertNotNull($t);
        $this->assertSame(['Glutes', 'Core'], array_column($t['facts']['gaps'], 'muscle'));
        $this->assertSame('Glutes and Core are under-trained', $t['title']);
    }

    public function test_a_group_absent_from_the_split_counts_as_zero(): void
    {
        $muscles = $this->split([]);
        // Legs trained not at all: the stats service omits the row entirely
        // rather than reporting a zero, so a missing key has to read as 0%.
        $muscles['items'] = array_values(array_filter(
            $muscles['items'],
            fn (array $i) => $i['muscle'] !== 'Legs',
        ));

        $t = $this->trigger($this->stats(['muscles' => $muscles]), 'muscle_gap');

        $this->assertNotNull($t);
        $this->assertSame('Legs', $t['facts']['gaps'][0]['muscle']);
        $this->assertSame(0, $t['facts']['gaps'][0]['hard_sets']);
    }

    public function test_a_thin_log_cannot_support_a_claim_about_a_split(): void
    {
        $muscles = $this->split(['Glutes' => 0]);
        $muscles['total_hard_sets'] = 30;

        $this->assertNotContains('muscle_gap', $this->keys($this->stats(['muscles' => $muscles])));
    }

    public function test_unmatched_titles_that_drag_every_share_down_silence_it(): void
    {
        // A third of the sets name exercises the catalog does not hold, so every
        // percentage below is measured against a total that is partly unknown.
        $muscles = $this->split(['Glutes' => 0]);
        $muscles['unmatched_sets'] = (int) round($muscles['total_hard_sets'] * 0.35);

        $this->assertNotContains('muscle_gap', $this->keys($this->stats(['muscles' => $muscles])));
    }

    public function test_an_even_split_has_no_gap(): void
    {
        $this->assertNotContains('muscle_gap', $this->keys($this->stats(['muscles' => $this->split([])])));
    }

    // ── Ordering ──────────────────────────────────────────────────────────────

    public function test_triggers_come_back_most_urgent_first(): void
    {
        $keys = $this->keys($this->stats([
            'range' => ['data_last' => '2026-08-30'],
            'volume' => ['weeks' => $this->weeks(20, 20, 20, 20, 10, 4)],
            'muscles' => $this->split(['Glutes' => 0]),
        ]));

        $this->assertSame(['layoff', 'volume_drop', 'muscle_gap'], $keys);
    }
}
