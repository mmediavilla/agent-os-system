<?php

namespace App\Jobs;

use App\Models\Insight;
use App\Services\AnthropicSwitch;
use App\Services\AssistantInstructions;
use App\Services\ClaudeService;
use App\Services\Fitness\ProactiveTriggers;
use App\Services\FitnessSettings;
use App\Services\FitnessStatsService;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Support\Facades\Log;

/**
 * The scheduled half of the proactive layer: run the free check, and only pay
 * for the model when it has something to say.
 *
 * Two properties are the whole design.
 *
 * **Nothing fires, nothing is spent.** `ProactiveTriggers::check()` is six
 * queries' worth of stats and no API call, and on a normal week it returns an
 * empty list and this job ends there. A test asserts exactly that, because the
 * failure mode — a daily call that costs money to be told "no" — is invisible
 * until the bill arrives.
 *
 * **A trigger that has already been said stays quiet.** Without the cooldown a
 * five-day layoff produces five identical nudges, one per morning, and the card
 * stops being read. The guard is per trigger rather than per insight so that a
 * PR is still announced during a lull the assistant has already mentioned, and
 * each trigger names its own window — a structural imbalance is a monthly
 * conversation, a missed week is a weekly one.
 *
 * The nudge lands in the existing `insights` table as `kind: proactive_nudge`.
 * `GET /api/insights` already lists it and the Insights screen already renders
 * it, so the proactive layer adds no client surface at all.
 */
class GenerateProactiveInsights implements ShouldQueue
{
    use Queueable;

    public const DOMAIN = 'fitness';

    public const KIND = 'proactive_nudge';

    /**
     * The nudge's system prompt — the default. Assistant → Instructions may
     * reword it ({@see AssistantInstructions}), so read it through there.
     */
    public const PROMPT = <<<'PROMPT'
    You are the user's fitness coach, writing an unprompted note because something in
    their training log is worth a word. They did not ask for this, so earn the
    interruption: be short, be specific, and say something they can act on today.

    You will be given observations that have already been checked against the data.
    Every number in them is true. Use them, and do not add numbers, exercises, dates
    or claims of your own — you cannot see the log itself, and an invented detail is
    what makes the next one of these get ignored.

    Under 70 words. Plain text, no markdown, no headers, no emojis, no greeting and no
    sign-off. Address the user as "you". Open with the observation that matters most,
    then one concrete next step. If the news is good, say so plainly and leave it
    there — a record does not need a lecture attached.
    PROMPT;

    /**
     * One attempt. A retry re-runs a paid model call to fix a failure that is
     * almost always the API being down, and tomorrow's run covers the same
     * ground anyway — a nudge is not worth two invoices. Failures land in
     * `failed_jobs`, which is where they can actually be seen.
     */
    public int $tries = 1;

    public function handle(FitnessStatsService $stats, ClaudeService $claude): void
    {
        // First, and before the free check even runs. This is the one paid path
        // with nobody watching it — it fires at 07:00 on a queue worker — so it
        // is the one where a switch that was only enforced in the UI would go
        // on spending money for weeks without anyone noticing.
        if (! AnthropicSwitch::enabled()) {
            return;
        }

        // Triggers switched off in Fitness → Settings are dropped first, so a
        // morning on which only those fire ends here and costs nothing.
        $fired = FitnessSettings::allowed(ProactiveTriggers::check($stats->build(ProactiveTriggers::RANGE)));

        if ($fired === []) {
            return;
        }

        $fresh = $this->dropRecentlySpoken($fired);

        if ($fresh === []) {
            return;
        }

        try {
            $result = $claude->complete(AssistantInstructions::get(AssistantInstructions::NUDGE), $this->userMessage($fresh));
        } catch (\Throwable $e) {
            // Logged rather than swallowed: a nudge that never arrives looks
            // exactly like a week with nothing to say, so the only evidence
            // this path ever ran is what is written here.
            Log::warning('Proactive nudge skipped, Claude call failed: '.$e->getMessage(), [
                'triggers' => array_column($fresh, 'key'),
            ]);

            throw $e;
        }

        Insight::create([
            'domain' => self::DOMAIN,
            'kind' => self::KIND,
            'title' => $fresh[0]['title'],
            'response' => $result['text'],
            'input_summary' => [
                // A flat list of keys, because that is what the cooldown reads
                // back on every subsequent run.
                'triggers' => array_column($fresh, 'key'),
                'range' => ProactiveTriggers::RANGE,
                'facts' => array_combine(
                    array_column($fresh, 'key'),
                    array_column($fresh, 'facts'),
                ),
            ],
            'usage' => $result['usage'],
            'model' => $result['model'],
        ]);
    }

    /**
     * Drop the triggers whose key was already spoken inside its own cooldown.
     *
     * Decided in PHP off the last few rows rather than with a JSON predicate:
     * the window holds a handful of insights at most, and `input_summary` is a
     * JSON column on SQLite whose querying is the sort of thing that works
     * until the day it does not.
     *
     * @param  list<array>  $fired
     * @return list<array>
     */
    private function dropRecentlySpoken(array $fired): array
    {
        $longest = max(array_column($fired, 'cooldown_days'));

        $recent = Insight::query()
            ->where('domain', self::DOMAIN)
            ->where('kind', self::KIND)
            ->where('created_at', '>=', now()->subDays($longest))
            ->orderByDesc('created_at')
            ->get(['created_at', 'input_summary']);

        $lastSpoken = [];
        foreach ($recent as $insight) {
            foreach ($insight->input_summary['triggers'] ?? [] as $key) {
                // Rows arrive newest first, so the first sighting of a key is
                // the most recent one.
                $lastSpoken[$key] ??= $insight->created_at;
            }
        }

        return array_values(array_filter($fired, function (array $trigger) use ($lastSpoken) {
            $spokenAt = $lastSpoken[$trigger['key']] ?? null;

            return $spokenAt === null
                || $spokenAt->lt(now()->subDays($trigger['cooldown_days']));
        }));
    }

    /** @param  list<array>  $fired */
    private function userMessage(array $fired): string
    {
        $observations = '';
        foreach ($fired as $i => $trigger) {
            $observations .= ($i + 1).'. '.$trigger['summary']."\n";
        }

        return 'Today is '.now()->toDateString().". Observations from my training log:\n\n"
            .$observations
            ."\nWrite the note.";
    }
}
