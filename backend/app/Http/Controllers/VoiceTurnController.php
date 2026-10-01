<?php

namespace App\Http\Controllers;

use App\Agent\AgentRunner;
use App\Agent\Exceptions\ConversationBusy;
use App\Agent\Streaming\EventLog;
use App\Agent\Streaming\RunDispatcher;
use App\Agent\ToolRegistry;
use App\Models\AgentRun;
use App\Models\Conversation;
use App\Services\AnthropicSwitch;
use App\Services\Exceptions\AnthropicDisabled;
use App\Services\Exceptions\AnthropicOutOfCredit;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Throwable;

/**
 * One spoken question, answered in the same breath.
 *
 * The ElevenLabs agent holds no knowledge and no judgement: it does speech to
 * text, text to speech and turn-taking, and for anything about the user it
 * calls a **client tool** which posts here. The brain stays in Laravel, so
 * there is one loop, one set of tools, one audit log and one place where a
 * write would ever be approved.
 *
 * **A client tool, rather than the webhook the architecture doc proposed.** A
 * webhook (or a Custom LLM endpoint) has to be publicly reachable, which today
 * means a tunnel — scaffolding for a VPS that does not exist yet, and a hole in
 * a perimeter whose whole design rests on `projectmc.test` being Herd-only DNS.
 * A client tool runs in the page, on this machine, and reaches the API the same
 * way the HUD does. The cost is stated rather than hidden: voice only works
 * with the app open in a browser here.
 *
 * **Synchronous, and that is not a regression.** `POST /messages` answers 202
 * and queues, because a *browser* was waiting on a screen and could be given a
 * run to watch. Nothing here can watch anything: the caller is a tool call
 * blocked on this response, with a timeout on it. `AgentRunner::send()` is the
 * shape that was written for exactly this and was only ever moved off the
 * request thread for the UI's benefit.
 *
 * **Read-only, by decision.** The runner is built on
 * {@see ToolRegistry::readOnly()}, so the writing tools are not offered at all
 * rather than offered and refused. The prompt says so too, so "log four sets"
 * is answered with "that has to be typed" instead of a claim that it happened.
 * 9.3 revisited this with reads proven and kept it: an approved write's answer
 * would land in the transcript and never be spoken, and approval must stay a
 * click rather than a "yes" a microphone can hear. CLAUDE.md has the rest, and
 * the change that would lift it.
 *
 * **One exception, and it writes nothing.** Where this machine allows local
 * actions, `show_google_calendar` is appended after the reads: it opens Google
 * Calendar in a browser tab, ungated. It is voice-only because this request
 * runs on the interactive desktop and the typed loop's worker does not — see
 * `AgentServiceProvider::voiceTools()`.
 *
 * **It lands in the conversation the HUD is showing**, when the client passes
 * its id. Speaking and typing then share one thread, one transcript and one
 * audit log, which is the whole architecture taken literally — and it is why
 * this takes a run row despite not being queued: the row is what stops a typed
 * message and a spoken one appending to the same transcript at once.
 */
class VoiceTurnController extends Controller
{
    /**
     * What is said when the loop finishes without prose.
     *
     * Rare — a completed turn almost always ends in words — but the alternative
     * is handing the agent an empty string to read, which is silence with no
     * explanation for it. Anything is better than dead air on a voice call.
     */
    public const NOTHING_SAID = 'I have nothing to say to that, Sir. Would you put it another way?';

    /** Said when a write proposed on the typed side is still waiting to be decided. */
    public const PARKED = 'There is a pending action waiting to be approved on screen, Sir. Decide that first and I can carry on.';

    /** Read out when Anthropic will not bill for the turn; the fix is a top-up, not a retry. */
    public const OUT_OF_CREDIT = 'The Anthropic account is out of credit, Sir. It needs topping up before I can answer.';

    public function __construct(private readonly AgentRunner $runner) {}

    /** POST /api/voice/turn */
    public function __invoke(Request $request): JsonResponse
    {
        // The whole loop runs inside this request, and Herd's 30s limit is wall
        // clock on Windows — see the constant.
        set_time_limit(AgentRun::VOICE_MAX_SECONDS);

        $data = $request->validate([
            // Shorter than the typed ceiling on purpose: this arrives as a
            // transcription of something a person said out loud.
            'message' => ['required', 'string', 'max:2000'],
            'conversation_id' => ['nullable', 'integer'],
        ]);

        // Before anything is stored, exactly as the typed path does it. The
        // switch has to mean the same thing for voice as for typing, or the
        // `AI OFF` chip in the chrome bar is a lie.
        if (! AnthropicSwitch::enabled()) {
            return $this->refuse(AnthropicDisabled::MESSAGE, 503);
        }

        $conversation = $this->conversation($data['conversation_id'] ?? null);

        // A typed run already working on this thread. Answering anyway would
        // interleave two loops in one transcript, which does not confuse the
        // API so much as break it: the *next* request is the one refused.
        if (RunDispatcher::active($conversation)) {
            return $this->refuse('I am still working on the last thing, Sir. Give me a moment and ask again.', 409, $conversation);
        }

        // A write proposed from the typed side is sitting on an approval card,
        // so the transcript ends with an unanswered `tool_use` and nothing can
        // be appended to it. Checked before a run is opened rather than left to
        // `accept()` below, so a refusal does not leave a `failed` run behind
        // for something that never started — the catch is still there for the
        // race, which is the only way it can now happen.
        if ($conversation->isAwaitingConfirmation()) {
            return $this->refuse(self::PARKED, 409, $conversation);
        }

        $run = RunDispatcher::open($conversation, AgentRun::TRIGGER_VOICE);
        $journal = new EventLog($run);

        try {
            $outcome = $this->runner->send($conversation, $data['message'], $journal);
        } catch (ConversationBusy $e) {
            // Only reachable if a write was parked between the check above and
            // this line. Said in words the agent can read out, because it will.
            RunDispatcher::finish($run, $journal, AgentRun::FAILED, $e->getMessage());

            return $this->refuse(self::PARKED, 409, $conversation);
        } catch (AnthropicOutOfCredit $e) {
            // Not reported: an empty account is a state the HUD already names,
            // not an exception anyone needs a stack trace for. 503 like the
            // switch, because it is the account and not this request.
            RunDispatcher::finish($run, $journal, AgentRun::FAILED, $e->getMessage());

            return $this->refuse(self::OUT_OF_CREDIT, 503, $conversation);
        } catch (Throwable $e) {
            report($e);

            RunDispatcher::finish($run, $journal, AgentRun::FAILED, 'Claude call failed: '.$e->getMessage());

            // 502 rather than a 200 carrying an apology: the client tool turns
            // this into a sentence for the agent to relay, and a failure that
            // arrives looking like an answer is one nothing upstream can log,
            // retry or count.
            return $this->refuse('I could not reach my own thoughts just then, Sir. Try me again in a moment.', 502, $conversation);
        }

        RunDispatcher::finish($run, $journal, $outcome->status);

        return response()->json([
            'text' => $outcome->reply() ?: self::NOTHING_SAID,
            'conversation_id' => $conversation->id,
        ]);
    }

    /**
     * The thread this turn belongs to.
     *
     * An id that no longer exists is treated as no id at all rather than as a
     * 404. The only way to get one is for the HUD to name a thread that has
     * since been deleted, and the useful answer to that is a fresh thread and
     * the new id in the response — the client follows it. "Conversation not
     * found", read aloud, helps nobody.
     */
    private function conversation(?int $id): Conversation
    {
        $existing = $id ? Conversation::find($id) : null;

        // Untitled, so `accept()` names it after the first thing said — the
        // same way a typed thread is named.
        return $existing ?? Conversation::create(['title' => null]);
    }

    /** A refusal the agent can read out, with the thread it happened on. */
    private function refuse(string $text, int $status, ?Conversation $conversation = null): JsonResponse
    {
        return response()->json([
            'message' => $text,
            'conversation_id' => $conversation?->id,
        ], $status);
    }
}
