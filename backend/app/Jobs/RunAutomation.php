<?php

namespace App\Jobs;

use App\Models\Automation;
use App\Services\Automations\AutomationRunner;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Support\Facades\Log;
use Throwable;

/**
 * One due automation, delivered. {@see AutomationRunner} is the work; this is
 * the queue's handle on it.
 *
 * Off the request thread for the same reason the fact extractor is: assembling
 * the first turn fetches the agenda and the weather over the network, which has
 * no business happening inside the HUD's `POST /automations/due` on Herd's
 * wall-clock time limit.
 *
 * `tries = 1`, like `ExtractFacts`: a retry re-pays for what is usually an
 * outage, and the row already records the failure, so nothing is lost by not
 * trying again automatically — the owner can always press Run now.
 */
class RunAutomation implements ShouldQueue
{
    use Queueable;

    public int $tries = 1;

    public function __construct(public readonly int $automationId) {}

    public function handle(AutomationRunner $runner): void
    {
        $automation = Automation::find($this->automationId);

        if (! $automation) {
            return;
        }

        try {
            $runner->run($automation);
        } catch (Throwable $e) {
            // Logged, because a greeting that never arrives looks exactly like
            // one that was never due.
            Log::warning('Automation failed: '.$e->getMessage(), ['automation_id' => $this->automationId]);

            throw $e;
        }
    }
}
