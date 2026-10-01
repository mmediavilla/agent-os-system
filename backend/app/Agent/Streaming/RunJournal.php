<?php

namespace App\Agent\Streaming;

use App\Models\AgentAction;

/**
 * Somewhere for the loop to say what it is doing while it does it.
 *
 * `AgentRunner` used to be silent by construction: it returned once, at the
 * end, and everything it had done was recovered afterwards by reading the
 * transcript. That is still true and still the source of truth — a client that
 * hears none of this and re-reads the conversation gets exactly the same
 * answer. This interface only exists so it does not have to *wait* to find out.
 *
 * It is an interface rather than a Laravel event because a run has an identity
 * and the events have an order. A listener on the global bus would have to
 * rediscover which run it was hearing about, and every test that exercises the
 * loop would have to fake the bus; a journal is passed in, so the synchronous
 * path passes {@see NullJournal} and nothing changes for it.
 *
 * Implementations must be safe to call with nothing listening — the loop does
 * not know or care whether anyone is watching, and must not slow down or fail
 * because nobody is.
 */
interface RunJournal
{
    /** The loop is about to make its first model call. */
    public function started(): void;

    /** A slice of the model's summarised reasoning, as it arrives. */
    public function thinking(string $delta): void;

    /** A slice of the answer, as it is written. */
    public function text(string $delta): void;

    /** A tool call was recorded — a read about to run, or a write about to be proposed. */
    public function toolStarted(AgentAction $action): void;

    /** A tool call came back. Never fired for a write: that stops the run instead. */
    public function toolFinished(AgentAction $action): void;

    /**
     * The run stopped on one or more proposed writes.
     *
     * @param  list<AgentAction>  $actions
     */
    public function awaiting(array $actions): void;

    /** Terminal, and the client's cue to stop watching. `$error` only ever accompanies a failure. */
    public function finished(string $status, ?string $error = null): void;
}
