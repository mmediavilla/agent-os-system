<?php

namespace App\Http\Controllers;

use App\Agent\AgentRunner;
use App\Agent\Streaming\RunDispatcher;
use App\Agent\Support\TranscriptPresenter;
use App\Models\AgentAction;
use App\Models\AgentRun;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * The confirmation gate: approve or decline one write the assistant proposed.
 *
 * This is the half of the tool layer MCP does not have. An MCP host prompts the
 * user itself, so the marker on a `MutatingTool` is only a hint there; on this
 * path it is the thing that stops a write from happening, and the decision has
 * to survive a round trip because the loop stopped and the user went away to
 * think about it.
 *
 * Deciding the last outstanding action resumes the conversation, and that
 * continuation is queued exactly like a message: the response carries a run id
 * rather than the rest of the transcript. The decision itself is still made
 * here and now — an approved write runs inside this request, because "did my
 * change land?" is the one question a user should never have to watch a stream
 * to answer.
 *
 * **Not gated by the Anthropic switch**, unlike sending a message. Switching
 * the API off with a write already parked must not strand it: the two things a
 * user can do about a card are the two this endpoint does, and taking them away
 * would leave a conversation that can neither be answered nor tidied up. The
 * continuation run it queues then fails and says why, which costs nothing —
 * `resume()` writes the tool results before it calls the model, so the
 * transcript is left valid and the thread works again the moment the switch
 * goes back on.
 */
class AgentActionController extends Controller
{
    public function __construct(private readonly AgentRunner $runner) {}

    /** POST /api/agent/actions/{action} */
    public function __invoke(Request $request, AgentAction $action): JsonResponse
    {
        $data = $request->validate([
            'decision' => ['required', 'string', 'in:approve,reject'],
        ]);

        $approve = $data['decision'] === 'approve';

        // Deciding an already-decided action is a no-op rather than an error —
        // a double-tapped button and a retried request must not write twice, and
        // must not look like a failure either. `decide()` claims the row
        // conditionally, so the second caller changes nothing.
        $action = $this->runner->decide($action, $approve);
        $conversation = $action->conversation;

        // Others in the same turn are still undecided, so there is nothing to
        // resume yet. No run, and the client keeps showing the remaining cards.
        if ($conversation->isAwaitingConfirmation()) {
            return response()->json([
                'action' => TranscriptPresenter::action($action),
                'conversation' => TranscriptPresenter::conversation($conversation),
                'pending_actions' => TranscriptPresenter::actions($conversation->pendingActions()->get()),
                'run' => null,
            ]);
        }

        $run = RunDispatcher::queue($conversation, AgentRun::TRIGGER_RESUME);

        return response()->json([
            'action' => TranscriptPresenter::action($action),
            'conversation' => TranscriptPresenter::conversation($conversation),
            'pending_actions' => [],
            'run' => TranscriptPresenter::run($run),
        ], 202);
    }
}
