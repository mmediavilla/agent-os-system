<?php

namespace App\Agent;

use App\Agent\Support\MessageCodec;
use App\Models\AgentAction;
use App\Models\Conversation;
use App\Models\ConversationMessage;

/**
 * What one trip through the loop produced.
 *
 * A run does not always end with an answer, which is the whole reason this is a
 * value rather than a string: it can also stop mid-thought waiting for the user
 * to approve a write, and a client has to be able to tell those apart without
 * inspecting the transcript.
 */
final class RunOutcome
{
    /** The model finished talking. `reply()` is the answer. */
    public const COMPLETED = 'completed';

    /** Parked on a proposed write. Nothing further happens until it is decided. */
    public const AWAITING_CONFIRMATION = 'awaiting_confirmation';

    /**
     * The loop hit its ceiling and was made to answer with what it had. Reported
     * separately from `completed` because the answer is a summary of an
     * unfinished job, and a client that says so is more honest than one that does
     * not.
     */
    public const MAX_ITERATIONS = 'max_iterations';

    /**
     * @param  list<ConversationMessage>  $messages  turns created by this run, in order
     * @param  list<AgentAction>  $pendingActions  writes now awaiting a decision
     */
    public function __construct(
        public readonly Conversation $conversation,
        public readonly string $status,
        public readonly array $messages = [],
        public readonly array $pendingActions = [],
    ) {}

    /**
     * The prose of the last thing the assistant said.
     *
     * Empty when the run parked on a confirmation and the model said nothing
     * before calling the tool — which is normal, and the reason this returns a
     * string rather than throwing.
     */
    public function reply(): string
    {
        for ($i = count($this->messages) - 1; $i >= 0; $i--) {
            if ($this->messages[$i]->role === ConversationMessage::ASSISTANT) {
                return MessageCodec::text($this->messages[$i]->content ?? []);
            }
        }

        return '';
    }
}
