<?php

namespace App\Jobs;

use App\Agent\AgentRunner;
use App\Agent\RunOutcome;
use App\Agent\Streaming\EventLog;
use App\Agent\Streaming\RunDispatcher;
use App\Agent\ToolRegistry;
use App\Models\AgentRun;
use App\Services\Agents\AgentScope;
use App\Services\ClaudeService;
use App\Services\Exceptions\AnthropicOutOfCredit;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Throwable;

/**
 * The tool loop, off the request thread.
 *
 * `POST /messages` used to run this inline and answer when it was done, which
 * for a question needing two or three tools is fifteen to twenty seconds of
 * spinner. Now the request stores the user's turn, queues this, and answers
 * with a run id; the client watches the run while this works.
 *
 * **The job owns the run row's whole lifecycle, including its terminal event.**
 * `AgentRunner` reports what happened by returning, and by throwing when it
 * cannot — neither of which a client in another process can see. So the loop
 * emits only the things it alone knows (a slice of text, a tool starting) and
 * *how the run ended* is decided here, where the failure path is visible beside
 * the success path. Writing it down is {@see RunDispatcher::finish()}, which is
 * shared with the voice turn: it runs the loop in its own request rather than
 * on a worker, and two copies of "row first, then the event" would be two
 * chances to leave a row saying `running` forever.
 *
 * `tries = 1`, for the same reason `GenerateProactiveInsights` has it and a
 * sharper one besides: a retry re-sends a transcript that has since grown by
 * however many turns the first attempt completed, so it is not the same call
 * twice — it is a second, more expensive call, arriving after the user has been
 * told the first one failed.
 */
class RunAgentTurn implements ShouldQueue
{
    use Queueable;

    /** @see the class docblock — a retry is a different, larger request. */
    public int $tries = 1;

    public function __construct(public readonly string $runId) {}

    public function handle(ClaudeService $claude, ToolRegistry $tools): void
    {
        $run = AgentRun::query()->with('conversation')->find($this->runId);

        // Gone, or already claimed. A conversation deleted between the dispatch
        // and the worker takes its runs with it (the foreign key cascades), and
        // a run that is no longer `queued` is one this worker must not start a
        // second time.
        if (! $run || $run->status !== AgentRun::QUEUED || ! $run->conversation) {
            return;
        }

        $run->forceFill(['status' => AgentRun::RUNNING, 'started_at' => now()])->save();

        $journal = new EventLog($run);

        // An automation (15.3) runs unattended on this same worker, with nobody
        // at the machine to watch a window open — so it gets every local tool
        // left out rather than one it could only ever propose.
        //
        // Then the agents (17.1): a switched-off agent's tools are not offered,
        // and the prompt says so. Read here, per run, so a toggle lands on the
        // next message without restarting a worker that holds the singleton.
        $scope = AgentScope::load();

        $runner = new AgentRunner(
            $claude,
            $scope->registry($run->trigger === AgentRun::TRIGGER_AUTOMATION ? $tools->withoutLocalTools() : $tools),
            agents: $scope->instructions(),
        );

        try {
            $outcome = $run->trigger === AgentRun::TRIGGER_RESUME
                ? $runner->resume($run->conversation, $journal)
                : $runner->advance($run->conversation, $journal);
        } catch (Throwable $e) {
            // Not rethrown. Letting it escape puts the run in `failed_jobs` and
            // leaves this row saying `running` forever, so the client watches a
            // stream that will never end — which is a worse failure than the
            // one that just happened. The message is stored because it is the
            // only thing the user will be shown.
            // An empty account is already a sentence; "Claude call failed:" in
            // front of it would make a top-up read like a bug.
            RunDispatcher::finish($run, $journal, AgentRun::FAILED, $e instanceof AnthropicOutOfCredit
                ? $e->getMessage()
                : 'Claude call failed: '.$e->getMessage());

            return;
        }

        if ($outcome->status === RunOutcome::AWAITING_CONFIRMATION) {
            $journal->awaiting($outcome->pendingActions);
        }

        RunDispatcher::finish($run, $journal, $outcome->status);
    }
}
