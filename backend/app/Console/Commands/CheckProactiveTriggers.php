<?php

namespace App\Console\Commands;

use App\Jobs\GenerateProactiveInsights;
use App\Services\Fitness\ProactiveTriggers;
use App\Services\FitnessSettings;
use App\Services\FitnessStatsService;
use Illuminate\Console\Command;

/**
 * Shows what the proactive layer would say, without saying it.
 *
 * The scheduled job is silent by design — on most mornings it correctly does
 * nothing at all — which makes "is any of this wired up?" unanswerable from the
 * outside. This is the answer: it runs the same free check the job runs and
 * prints the result, so the Windows Task Scheduler setup can be verified
 * without waiting until 07:00 and without paying for a model call.
 */
class CheckProactiveTriggers extends Command
{
    protected $signature = 'proactive:check {--send : Dispatch the job as well, which may call the model and write an insight}';

    protected $description = 'Report which proactive nudge triggers currently fire';

    public function handle(FitnessStatsService $stats): int
    {
        $all = ProactiveTriggers::check($stats->build(ProactiveTriggers::RANGE));
        $fired = FitnessSettings::allowed($all);
        $silenced = array_diff(array_column($all, 'key'), array_column($fired, 'key'));

        // The schedule's half of the answer first: a check that fires every
        // trigger says nothing useful if the nudge is switched off.
        $this->line(FitnessSettings::nudgesEnabled()
            ? 'Nudges are on, daily at '.FitnessSettings::nudgeTime().' ('.config('agent.timezone').').'
            : 'Nudges are switched off in Fitness → Settings; the schedule will not run the job.');
        $this->newLine();

        if ($silenced !== []) {
            $this->line('Firing but switched off: '.implode(', ', $silenced).'.');
            $this->newLine();
        }

        if ($fired === []) {
            $this->info('Nothing fires. No nudge, no model call.');
        } else {
            $this->line('Triggers firing over the last '.ProactiveTriggers::RANGE.':');
            $this->newLine();

            foreach ($fired as $trigger) {
                $this->line("  <options=bold>{$trigger['key']}</> — {$trigger['title']}");
                $this->line("    {$trigger['summary']}");
                $this->line("    cooldown: {$trigger['cooldown_days']} days");
                $this->newLine();
            }
        }

        // Said plainly, because the difference between the two modes is a
        // charge on the Anthropic account.
        if (! $this->option('send')) {
            $this->comment('Dry run — nothing was dispatched. Add --send to actually run the job.');

            return self::SUCCESS;
        }

        GenerateProactiveInsights::dispatch();
        $this->info('Job dispatched. Triggers still inside their cooldown will be dropped by the job itself.');

        return self::SUCCESS;
    }
}
