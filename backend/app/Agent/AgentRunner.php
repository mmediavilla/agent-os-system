<?php

namespace App\Agent;

use App\Agent\Exceptions\ConversationBusy;
use App\Agent\Streaming\NullJournal;
use App\Agent\Streaming\RunJournal;
use App\Agent\Support\Instructions;
use App\Agent\Support\MessageCodec;
use App\Agent\Support\SnapshotStore;
use App\Models\AgentAction;
use App\Models\Conversation;
use App\Models\ConversationMessage;
use App\Models\Snapshot;
use App\Services\Agents\AgentScope;
use App\Services\AssistantSettings;
use App\Services\ClaudeService;
use Illuminate\Support\Collection;
use Illuminate\Support\Str;

/**
 * The tool loop: ask the model, run what it asks for, ask again.
 *
 * Written by hand rather than handed to the SDK's tool runner, for one reason
 * that decides the whole shape of this class. The SDK's runner goes from
 * question to answer inside a single call; this one has to be able to **stop in
 * the middle and come back in a later HTTP request**, because a write is only
 * performed once the user has approved it. A generator cannot be parked in
 * SQLite, so the loop's position lives in the database instead: the transcript
 * says how far it got, and `agent_actions` says what it is waiting for.
 *
 * Three behaviours are load-bearing and easy to get wrong:
 *
 * - **The assistant turn is persisted before any tool runs.** A tool that fatals
 *   must not take the turn that requested it down with it, or the conversation
 *   is left with a hole where the model's reasoning was.
 * - **Every parallel `tool_use` in a turn is answered in one user message.** The
 *   API accepts them split across several, and doing so teaches the model that
 *   parallel calls are not worth making.
 * - **A tool failure is content, never an exception that escapes.** `is_error`
 *   on a `tool_result` is what lets the model see its mistake and fix it; a 500
 *   ends the conversation instead.
 *
 * The loop now usually runs inside a queued job rather than inside the request
 * that asked for it, and the only trace of that here is the {@see RunJournal}
 * threaded through it. Nothing about the loop's correctness depends on anyone
 * listening: the journal defaults to {@see NullJournal}, every event it emits
 * is a duplicate of something already being written to `conversation_messages`
 * or `agent_actions`, and a client that hears none of it and re-reads the
 * conversation ends up with exactly the same thing. It buys latency, not truth.
 */
class AgentRunner
{
    /**
     * How many model calls one message may cost before the loop is stopped.
     *
     * The ceiling is a budget, not a correctness rule: each iteration is a paid
     * round trip, and a model stuck alternating between two tools will happily
     * spend all of them. Hitting it is not an error — see `forceAnswer()`.
     */
    public const MAX_ITERATIONS = 12;

    /** What the model is told when the user declines a write. */
    public const DECLINED = 'The user declined this action, so it was not performed. Do not retry it with the same arguments; acknowledge the decision and continue.';

    /**
     * `$addendum` is whatever is true of the caller that built this runner and
     * of no other, appended to the system prompt — today, only
     * {@see Instructions::SPOKEN}, because the voice path's answers are heard
     * rather than read.
     *
     * It is a constructor argument rather than a parameter on `send()` for the
     * same reason the registry is: what a runner is *for* does not change from
     * one turn to the next, and threading it through `send()`, `advance()`,
     * `resume()` and both prompt sites would put four chances to forget it
     * where there is currently none.
     *
     * `$agents` is the prompt's agents paragraph, for the same reason (17.1).
     * It comes from the same {@see AgentScope} load that cut `$tools`, so the
     * prompt and the registry it describes are never read at different moments.
     * Blank for the full-registry runner the container builds, which only ever
     * decides parked writes and never asks the model anything.
     */
    public function __construct(
        private readonly ClaudeService $claude,
        private readonly ToolRegistry $tools,
        private readonly string $addendum = '',
        private readonly string $agents = '',
    ) {}

    /**
     * Add a message from the user and run until the model stops or a write needs
     * deciding.
     */
    public function send(Conversation $conversation, string $text, RunJournal $journal = new NullJournal): RunOutcome
    {
        return $this->loop($conversation, [$this->accept($conversation, $text)], $journal);
    }

    /**
     * Store the user's turn, without running anything.
     *
     * Split out from `send()` because the two halves now happen in different
     * processes: the request stores the message and answers, and a worker picks
     * up the loop a moment later. Doing it this way round — rather than parking
     * the text on the run row for the job to store — means the message is in
     * the thread the instant the request returns, so a client that re-reads
     * before the worker starts sees its own question rather than an empty
     * transcript.
     */
    public function accept(Conversation $conversation, string $text, ?Snapshot $snapshot = null): ConversationMessage
    {
        // Not a courtesy check: at this point the transcript ends with an
        // assistant turn whose `tool_use` blocks have no results, and appending
        // a user message there produces a request the API refuses.
        if ($conversation->isAwaitingConfirmation()) {
            throw ConversationBusy::make();
        }

        $text = trim($text);

        // Named after whatever opened it, so a thread list is readable without
        // asking the user for a title or paying a model call to invent one. A
        // snapshot sent with nothing typed is the one turn with no words to take
        // a title from, and "New conversation" would say less than the picture.
        if ($conversation->title === null) {
            $conversation->update([
                'title' => Conversation::deriveTitle($text !== '' ? $text : ($snapshot ? 'Camera snapshot' : '')),
            ]);
        }

        $content = [];

        // The picture goes before the words, which is the API's own advice and
        // is also how the question reads: "this — what is it?"
        if ($snapshot) {
            $content[] = SnapshotStore::block($snapshot);
        }

        // Skipped when empty rather than sent blank: a text block with nothing
        // in it is a block the API rejects, and a snapshot on its own is a whole
        // question.
        if ($text !== '') {
            $content[] = ['type' => 'text', 'text' => $text];
        }

        return $this->persist($conversation, ConversationMessage::USER, $content);
    }

    /**
     * Run the loop against the transcript exactly as it stands.
     *
     * The queued half of `send()`: `accept()` has already put the user's turn
     * at the end of the thread, so there is nothing to add before asking the
     * model. Nothing checks that here, deliberately — the caller that stored
     * the turn is the one that knows, and a second `isAwaitingConfirmation()`
     * would only re-answer a question already answered in the request that
     * queued this.
     */
    public function advance(Conversation $conversation, RunJournal $journal = new NullJournal): RunOutcome
    {
        return $this->loop($conversation, [], $journal);
    }

    /**
     * Pick the loop back up after every proposed write in the parked turn has
     * been decided.
     *
     * The results of that turn — the reads that already ran and the writes just
     * decided — go back as the single user message the API is waiting for, and
     * then the loop continues exactly as if it had never stopped.
     */
    public function resume(Conversation $conversation, RunJournal $journal = new NullJournal): RunOutcome
    {
        if ($conversation->isAwaitingConfirmation()) {
            return $this->awaiting($conversation, []);
        }

        $last = $conversation->messages()->get()->last();

        // Nothing was parked, so there is nothing to resume. Returning rather
        // than looping matters: a fresh turn here would be a paid call with no
        // new input, answering a question that was already answered.
        if (! $last || $last->role !== ConversationMessage::ASSISTANT || MessageCodec::toolUses($last->content ?? []) === []) {
            return new RunOutcome($conversation, RunOutcome::COMPLETED);
        }

        $results = $this->persistToolResults($conversation, $last->actions()->get());

        return $this->loop($conversation, [$results], $journal);
    }

    /**
     * Approve or decline one proposed write, running it if approved.
     *
     * Deciding twice cannot write twice. The status is claimed with a
     * conditional update rather than read and then set, so two requests arriving
     * together leave exactly one of them holding the action; the loser returns
     * the row as it now stands and does nothing.
     */
    public function decide(AgentAction $action, bool $approve): AgentAction
    {
        $claimed = AgentAction::query()
            ->whereKey($action->getKey())
            ->where('status', AgentAction::PENDING)
            ->update([
                'status' => $approve ? AgentAction::APPROVED : AgentAction::REJECTED,
                'decided_at' => now(),
                'updated_at' => now(),
            ]);

        if ($claimed === 0) {
            return $action->refresh();
        }

        $outcome = $approve
            ? $this->tools->attempt($action->tool, $action->input ?? [])
            : ['text' => self::DECLINED, 'is_error' => true];

        $action->forceFill([
            'status' => $approve ? AgentAction::APPROVED : AgentAction::REJECTED,
            'decided_at' => now(),
            'result' => $outcome['text'],
            'is_error' => $outcome['is_error'],
        ])->save();

        return $action;
    }

    // ── the loop ─────────────────────────────────────────────────────────────

    /**
     * @param  list<ConversationMessage>  $created  turns this run has already written
     */
    private function loop(Conversation $conversation, array $created, RunJournal $journal): RunOutcome
    {
        $journal->started();

        for ($i = 0; $i < $this->maxIterations(); $i++) {
            $turn = $this->claude->turn(
                Instructions::systemPrompt($this->tools, $this->addendum, $this->agents),
                MessageCodec::transcript($conversation->messages()->get()),
                $this->tools->schemas(),
                onDelta: $this->relay($journal),
            );

            // Before anything is dispatched. A tool that fatals loses its own
            // result, which the model can survive; losing the turn that asked
            // for it leaves a transcript that cannot be replayed at all.
            $assistant = $this->persistTurn($conversation, $turn);
            $created[] = $assistant;

            $toolUses = MessageCodec::toolUses($turn['content']);

            // `stop_reason` and the blocks have to agree before the loop trusts
            // either: a turn that stopped for any other reason is the answer.
            if ($turn['stop_reason'] !== 'tool_use' || $toolUses === []) {
                return new RunOutcome($conversation, RunOutcome::COMPLETED, $created);
            }

            $actions = $this->recordActions($conversation, $assistant, $toolUses, $journal);

            if ($actions->contains(fn (AgentAction $a) => $a->isPending())) {
                return $this->awaiting($conversation, $created);
            }

            $created[] = $this->persistToolResults($conversation, $actions);
        }

        $created[] = $this->forceAnswer($conversation, $journal);

        return new RunOutcome($conversation, RunOutcome::MAX_ITERATIONS, $created);
    }

    /**
     * One last call with tools switched off, so the user gets a sentence rather
     * than a 500 after a dozen paid round trips.
     *
     * Safe to make because the loop only reaches here having just written the
     * results of the previous turn: the transcript ends with a user message, as
     * a request requires.
     */
    private function forceAnswer(Conversation $conversation, RunJournal $journal): ConversationMessage
    {
        $turn = $this->claude->turn(
            Instructions::systemPrompt($this->tools, $this->addendum, $this->agents),
            MessageCodec::transcript($conversation->messages()->get()),
            $this->tools->schemas(),
            toolChoice: ['type' => 'none'],
            onDelta: $this->relay($journal),
        );

        return $this->persistTurn($conversation, $turn);
    }

    /**
     * Record one turn's tool calls, running the ones that do not need asking.
     *
     * Reads run here and now, and their results are written to their rows,
     * because the turn may be about to stop for a write sitting beside them —
     * and when it resumes, those results have to still exist to go back in the
     * same message.
     *
     * @param  list<array<string, mixed>>  $toolUses
     * @return Collection<int, AgentAction>
     */
    private function recordActions(Conversation $conversation, ConversationMessage $assistant, array $toolUses, RunJournal $journal): Collection
    {
        return collect($toolUses)->map(function (array $block) use ($conversation, $assistant, $journal): AgentAction {
            $name = is_string($block['name'] ?? null) ? $block['name'] : '';
            $input = is_array($block['input'] ?? null) ? $block['input'] : [];

            // An unknown name cannot be mutating — it is not in the registry, so
            // there is nothing behind it to write. It still gets a row and still
            // gets run, so the model is told what is wrong in the ordinary way.
            $gated = $this->tools->has($name) && $this->tools->isMutating($name);

            $action = AgentAction::create([
                'conversation_id' => $conversation->id,
                'conversation_message_id' => $assistant->id,
                'tool_use_id' => is_string($block['id'] ?? null) ? $block['id'] : (string) Str::uuid(),
                'tool' => $name,
                'input' => $input,
                'requires_confirmation' => $gated,
                'status' => $gated ? AgentAction::PENDING : AgentAction::APPROVED,
            ]);

            $journal->toolStarted($action);

            if (! $gated) {
                $outcome = $this->tools->attempt($name, $input);
                $action->forceFill([
                    'result' => $outcome['text'],
                    'is_error' => $outcome['is_error'],
                    'decided_at' => now(),
                ])->save();

                $journal->toolFinished($action);
            }

            return $action;
        });
    }

    // ── persistence ──────────────────────────────────────────────────────────

    /** @param  array{content: array, stop_reason: string, usage: array, model: string}  $turn */
    private function persistTurn(Conversation $conversation, array $turn): ConversationMessage
    {
        return $this->persist(
            $conversation,
            ConversationMessage::ASSISTANT,
            $turn['content'],
            ['stop_reason' => $turn['stop_reason'], 'model' => $turn['model'], 'usage' => $turn['usage']],
        );
    }

    /**
     * The whole turn's results, as one user message, in the order the calls were
     * made.
     *
     * @param  Collection<int, AgentAction>  $actions
     */
    private function persistToolResults(Conversation $conversation, Collection $actions): ConversationMessage
    {
        $blocks = $actions
            ->map(fn (AgentAction $a) => MessageCodec::toolResultBlock($a->tool_use_id, (string) $a->result, (bool) $a->is_error))
            ->values()
            ->all();

        return $this->persist($conversation, ConversationMessage::USER, $blocks);
    }

    /** @param  list<array<string, mixed>>  $content */
    private function persist(Conversation $conversation, string $role, array $content, array $extra = []): ConversationMessage
    {
        $message = $conversation->messages()->create(array_merge([
            'role' => $role,
            'content' => array_values($content),
        ], $extra));

        // Denormalised onto the conversation so a list of threads can be sorted
        // by activity without touching this table.
        $conversation->forceFill(['last_message_at' => $message->created_at])->save();

        return $message;
    }

    /** @param  list<ConversationMessage>  $created */
    private function awaiting(Conversation $conversation, array $created): RunOutcome
    {
        return new RunOutcome(
            $conversation,
            RunOutcome::AWAITING_CONFIRMATION,
            $created,
            $conversation->pendingActions()->get()->all(),
        );
    }

    /**
     * The bridge between a streamed turn and whoever is watching the run.
     *
     * A closure rather than the journal itself, because `ClaudeService` has no
     * business knowing what a run is: it hands out slices of text, and it is
     * this loop's job to decide that a slice is worth telling somebody about.
     *
     * @return callable(string, string): void
     */
    private function relay(RunJournal $journal): callable
    {
        return function (string $kind, string $delta) use ($journal): void {
            if ($kind === 'thinking') {
                $journal->thinking($delta);

                return;
            }

            $journal->text($delta);
        };
    }

    private function maxIterations(): int
    {
        return AssistantSettings::maxIterations();
    }
}
