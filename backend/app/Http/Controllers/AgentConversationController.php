<?php

namespace App\Http\Controllers;

use App\Agent\AgentRunner;
use App\Agent\Exceptions\ConversationBusy;
use App\Agent\Exceptions\SnapshotRejected;
use App\Agent\Streaming\RunDispatcher;
use App\Agent\Support\SnapshotStore;
use App\Agent\Support\TranscriptPresenter;
use App\Models\AgentRun;
use App\Models\Conversation;
use App\Services\AnthropicSwitch;
use App\Services\Exceptions\AnthropicDisabled;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;

/**
 * Conversations with the assistant: list them, read one, and talk.
 *
 * Rate-limited but not token-gated, unlike `/api/mcp` — see the two agent groups
 * in routes/api.php for why the app's own chat sits on the app's own trust
 * boundary. Everything reachable here can spend money and, once a write is
 * approved, change data; what stops the second of those is the confirmation
 * gate, not the perimeter.
 *
 * **A message no longer waits for the answer.** It stores the user's turn,
 * queues a run, and returns 202 with a run id; the loop happens in a worker and
 * the client watches it through `/api/agent/runs/{run}`. What that buys is not
 * only the fifteen seconds of spinner it replaces — it is that the wait is now
 * *legible*, because a watcher sees the tools being called and the answer being
 * written rather than a bubble that says "Working…".
 *
 * The response deliberately still carries the conversation and the stored
 * message. The thread has just been named after that message, and the client's
 * optimistic bubble can be swapped for the real row immediately rather than at
 * the end of the run.
 */
class AgentConversationController extends Controller
{
    public function __construct(private readonly AgentRunner $runner) {}

    /** GET /api/agent/conversations */
    public function index(): JsonResponse
    {
        $conversations = Conversation::query()
            ->orderByDesc('last_message_at')
            ->orderByDesc('id')
            ->limit(50)
            ->get();

        return response()->json([
            'data' => $conversations->map(TranscriptPresenter::conversation(...))->all(),
        ]);
    }

    /** POST /api/agent/conversations */
    public function store(Request $request): JsonResponse
    {
        $data = $request->validate([
            'title' => ['nullable', 'string', 'max:120'],
        ]);

        // Left untitled on purpose when none is given: the first message names
        // the thread, which is one fewer thing to ask for before the user can
        // type anything.
        $conversation = Conversation::create(['title' => $data['title'] ?? null]);

        return response()->json(TranscriptPresenter::conversation($conversation), 201);
    }

    /** GET /api/agent/conversations/{conversation} */
    public function show(Conversation $conversation): JsonResponse
    {
        // The active run, if there is one, so that reopening a thread — or
        // reloading the page — picks the live view back up instead of showing a
        // finished-looking transcript with a run still writing into it.
        $run = RunDispatcher::active($conversation);

        return response()->json([
            'conversation' => TranscriptPresenter::conversation($conversation),
            'messages' => TranscriptPresenter::messages($conversation->messages()->get()),
            'pending_actions' => TranscriptPresenter::actions($conversation->pendingActions()->get()),
            'run' => $run ? TranscriptPresenter::run($run) : null,
        ]);
    }

    /** DELETE /api/agent/conversations/{conversation} */
    public function destroy(Conversation $conversation): JsonResponse
    {
        // Messages and actions go with it — both cascade. Nothing the assistant
        // has already written to workouts, exercises or insights is touched:
        // deleting the record of a change is not undoing it.
        $conversation->delete();

        return response()->json(null, 204);
    }

    /** POST /api/agent/conversations/{conversation}/messages */
    public function message(Request $request, Conversation $conversation): JsonResponse
    {
        $data = $request->validate([
            // `required_without` rather than `required`: a camera frame is a
            // whole question on its own, and forcing a word out of someone
            // pointing a lens at something would only produce "this".
            'message' => ['required_without:image', 'nullable', 'string', 'max:8000'],
            'image' => ['nullable', 'array'],
            'image.data' => ['required_with:image', 'string'],
            'image.media_type' => ['required_with:image', 'string', Rule::in(SnapshotStore::MEDIA_TYPES)],
        ]);

        // Refused here rather than left to fail inside the run, and that is not
        // only politeness. A queued run would store the user's turn, spend a
        // worker on it and report the same sentence a second later on
        // `agent_runs.error` — by which time the transcript holds a message
        // nobody answered and the composer has been cleared. 503 leaves the
        // thread exactly as it was and puts the text back in the box.
        if (! AnthropicSwitch::enabled()) {
            return response()->json(['message' => AnthropicDisabled::MESSAGE], 503);
        }

        // Checked before the turn is stored rather than after: a second loop
        // running against the same transcript does not make the conversation
        // slower, it makes the *next* message fail — see RunDispatcher.
        if ($busy = RunDispatcher::active($conversation)) {
            return response()->json([
                'message' => 'This conversation is already working on something.',
                'run' => TranscriptPresenter::run($busy),
            ], 409);
        }

        // Stored only once everything above has said yes, because this is the
        // one part of the request that writes to disk. A frame kept and then
        // refused would leave a file nothing points at, and nothing sweeps.
        try {
            $snapshot = null;

            if ($image = $data['image'] ?? null) {
                SnapshotStore::guardDailyCeiling();
                $snapshot = SnapshotStore::store($conversation, $image['data'], $image['media_type']);
            }
        } catch (SnapshotRejected $e) {
            // Its own status, because the three refusals want different things
            // done about them — see the exception.
            return response()->json(['message' => $e->getMessage()], $e->status);
        }

        try {
            $message = $this->runner->accept($conversation, (string) ($data['message'] ?? ''), $snapshot);
        } catch (ConversationBusy $e) {
            // The frame was accepted a moment ago and is now attached to a turn
            // that will never exist. Deleting the row takes the file with it.
            $snapshot?->delete();

            // 409 rather than 422: the request is fine, the conversation is not
            // in a state that can accept it, and the fix is to decide the
            // pending action rather than to change the message.
            return response()->json([
                'message' => $e->getMessage(),
                'pending_actions' => TranscriptPresenter::actions($conversation->pendingActions()->get()),
            ], 409);
        }

        $run = RunDispatcher::queue($conversation, AgentRun::TRIGGER_MESSAGE);

        // 202, not 200: the work has been accepted and has not been done. There
        // is no `reply` here and no 502 above it either — a model call that
        // fails now fails inside the job, and is reported on the run.
        return response()->json([
            'run' => TranscriptPresenter::run($run),
            // The thread has just been named after this message, and the rail
            // is still showing the old title.
            'conversation' => TranscriptPresenter::conversation($conversation->refresh()),
            // So the client can swap its optimistic bubble for the stored row
            // straight away, rather than at the end of the run.
            'message' => TranscriptPresenter::message($message),
        ], 202);
    }
}
