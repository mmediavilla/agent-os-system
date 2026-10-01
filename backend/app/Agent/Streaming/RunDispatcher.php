<?php

namespace App\Agent\Streaming;

use App\Jobs\RunAgentTurn;
use App\Models\AgentRun;
use App\Models\Conversation;

/**
 * Starting a run, finishing one, and refusing to start a second one.
 *
 * Two controllers queue runs — a message starts one, and the decision that
 * clears the last parked write starts another — and both need the same two
 * lines and the same guard, so it lives here rather than twice.
 *
 * A third caller neither queues nor waits: the voice turn runs the loop inside
 * its own request, because an ElevenLabs client tool is blocked on the
 * response and has nowhere to watch a run from. It still takes a row, and that
 * is the point of `open()` — the row is what the busy check reads, so a spoken
 * turn and a typed one cannot end up appending to one transcript at once.
 *
 * **One run per conversation at a time is a correctness rule, not politeness.**
 * Two loops appending to one transcript interleave their turns, and the result
 * is not merely confusing: an assistant turn whose `tool_use` blocks are
 * separated from their results by another turn is a request the Messages API
 * refuses outright, so the *next* message fails rather than the one that caused
 * it. The guard is a plain query rather than a lock because the only client is
 * a single user's browser; what it protects against is a double-tapped Send and
 * a refreshed tab, not contention.
 */
final class RunDispatcher
{
    /** Queue a run and hand back the row a client can watch. */
    public static function queue(Conversation $conversation, string $trigger): AgentRun
    {
        $run = AgentRun::create([
            'conversation_id' => $conversation->id,
            'trigger' => $trigger,
            'status' => AgentRun::QUEUED,
        ]);

        // After the row exists, always. With QUEUE_CONNECTION=sync — which is
        // what the test suite runs on — dispatch executes the job inline, and a
        // job that looks for a run that has not been written yet does nothing
        // at all, silently.
        RunAgentTurn::dispatch($run->id);

        return $run->refresh();
    }

    /**
     * Claim the conversation for a run that is about to happen right here.
     *
     * Born `running` rather than `queued`, and with no job dispatched: nobody
     * is going to pick this up later, because the caller is already in the
     * loop. What it buys is the same thing `queue()` buys — a row in
     * {@see AgentRun::ACTIVE}, which is what makes the conversation look busy
     * to everything else for as long as the work lasts.
     */
    public static function open(Conversation $conversation, string $trigger): AgentRun
    {
        return AgentRun::create([
            'conversation_id' => $conversation->id,
            'trigger' => $trigger,
            'status' => AgentRun::RUNNING,
            'started_at' => now(),
        ]);
    }

    /**
     * End a run: the row first, then the event that says so.
     *
     * That order is load-bearing. A client that sees `run.finished` asks for
     * the conversation next, and it must not find a run still claiming to be
     * running when it does — so breaking on the event would race the row it is
     * announcing.
     *
     * Here rather than on the job that used to own it, because a run's end is
     * now written from two processes: a worker, and the request the voice turn
     * arrives on. Two copies of this would be two chances to leave a row saying
     * `running` forever, which is the one failure a watcher cannot recover
     * from.
     */
    public static function finish(AgentRun $run, RunJournal $journal, string $status, ?string $error = null): void
    {
        $run->forceFill([
            'status' => $status,
            'error' => $error,
            'finished_at' => now(),
        ])->save();

        $journal->finished($status, $error);
    }

    /**
     * The run this conversation is already busy with, if any.
     *
     * Ordered newest-first so that the row reported is the one a client would
     * want to watch, in the case where an older run was somehow left `running`
     * by a worker that died.
     */
    public static function active(Conversation $conversation): ?AgentRun
    {
        self::releaseStrandedVoice($conversation);

        return AgentRun::query()
            ->where('conversation_id', $conversation->id)
            ->whereIn('status', AgentRun::ACTIVE)
            ->orderByDesc('created_at')
            ->first();
    }

    /**
     * Fail a voice run whose request died without saying so.
     *
     * A voice turn is finished by the request that opened it, and a PHP fatal
     * (the time limit, most often) ends that request without running another
     * line, so the row stays `running`. For a queued run that is a dead worker
     * and rare. For a voice turn it locked the thread for good: every later
     * question, spoken or typed, was refused as "still working on the last
     * thing". Nothing can still be working on a voice run older than the
     * request's own time limit, so past that, with some margin, it is marked as
     * what it is.
     *
     * With no conversation it releases every one — Troubleshoot's
     * `release_stuck_runs`, applying deliberately what this otherwise does only
     * when a thread is next used.
     *
     * @return int how many were released
     */
    public static function releaseStrandedVoice(?Conversation $conversation = null): int
    {
        return AgentRun::query()
            ->when($conversation, fn ($q) => $q->where('conversation_id', $conversation->id))
            ->where('trigger', AgentRun::TRIGGER_VOICE)
            ->where('status', AgentRun::RUNNING)
            ->where('started_at', '<', now()->subSeconds(AgentRun::VOICE_MAX_SECONDS + 30))
            ->update([
                'status' => AgentRun::FAILED,
                'error' => 'The request running this spoken turn stopped before it could finish.',
                'finished_at' => now(),
            ]);
    }
}
