<?php

namespace App\Agent\Tools;

use App\Agent\CapabilityGroup;
use App\Services\FitnessStatsService;

class GetFitnessStats extends BaseTool
{
    public function __construct(private readonly FitnessStatsService $stats) {}

    public function name(): string
    {
        return 'get_fitness_stats';
    }

    public function group(): CapabilityGroup
    {
        return CapabilityGroup::Fitness;
    }

    public function description(): string
    {
        return <<<'TEXT'
        Aggregated training metrics over a time window: sessions and rest days, hard sets,
        tonnage, weekly volume, muscle-group split, estimated 1RM trends for the most-trained
        lifts, and recent personal records.

        Call this FIRST for any question about how training is going — progress, consistency,
        volume, whether something is stalling, what is being neglected. The numbers here are
        computed the same way the app's dashboard computes them (e1RM by the user's chosen
        formula, warmups excluded from set counts, PRs checked against all history before the
        window), so an answer built on them agrees with what the user sees on screen. `settings`
        says which e1RM formula was used and which day weeks start on; name the formula when
        quoting an estimated 1RM. Deriving the same figures by hand from
        list_workouts will be slower, more expensive and will disagree at the edges.

        Reach for list_workouts instead only when the question is about specific sessions —
        what was done on a given day, or when a particular exercise was last trained.
        TEXT;
    }

    public function inputSchema(): array
    {
        return $this->object([
            'range' => $this->string(
                'Time window. "4w", "12w" and "1y" are the last 28, 84 and 365 days; "all" is '.
                'the whole history; "auto" (the default) widens from 4w until it finds data. '.
                'An explicit range never widens, so it can legitimately come back empty.',
                ['auto', '4w', '12w', '1y', 'all'],
            ),
        ]);
    }

    public function handle(array $input): array
    {
        $input = $this->validate($input, [
            'range' => ['nullable', 'string', 'in:auto,4w,12w,1y,all'],
        ]);

        $stats = $this->stats->build($input['range'] ?? 'auto');

        // The heatmap is dropped: it is one row per training day carrying the
        // same tonnage and set counts the weekly `volume` buckets already
        // summarize, shaped for a calendar grid nobody is rendering here. It is
        // also the only unbounded part of the payload — a year of training is
        // ~200 rows — so keeping it would spend most of the size budget on the
        // least useful field.
        unset($stats['heatmap']);

        return $stats;
    }
}
