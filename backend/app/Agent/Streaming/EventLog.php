<?php

namespace App\Agent\Streaming;

use App\Models\AgentAction;
use App\Models\AgentRun;
use App\Models\AgentRunEvent;

/**
 * The journal that writes to `agent_run_events`, for a client in another
 * process to read back.
 *
 * **Deltas are coalesced, and that is not an optimisation.** A streamed answer
 * arrives a few characters at a time, so writing a row per delta would put
 * several hundred rows in the table per turn — and a poller asking once a
 * second would then be handed several hundred rows to reassemble into the same
 * paragraph. The buffer flushes on a time bound *and* a size bound, so a fast
 * answer still arrives in readable pieces and a slow one is never held back
 * longer than {@see FLUSH_MS}.
 *
 * Anything that is not a delta flushes first. Order is the only thing a client
 * has to reconstruct meaning from — text written before a tool call must not
 * arrive after it — so the buffer is never allowed to outlive the next real
 * event.
 *
 * Nothing here throws into the loop. A journal that fails should cost the user
 * a stuttering progress display, never the answer: `AgentRunner` is holding a
 * paid, half-finished conversation and a broken `INSERT` is not a reason to
 * lose it.
 */
final class EventLog implements RunJournal
{
    /** Longest a buffered delta may wait before it is written. */
    private const FLUSH_MS = 120;

    /** Longest a buffered delta may get before it is written regardless of time. */
    private const FLUSH_CHARS = 240;

    private int $seq = 0;

    private string $buffer = '';

    /** Which kind of delta is in the buffer — text and thinking must not merge. */
    private ?string $buffered = null;

    private float $bufferedSince = 0.0;

    public function __construct(private readonly AgentRun $run) {}

    public function started(): void
    {
        $this->write(AgentRunEvent::STARTED);
    }

    public function thinking(string $delta): void
    {
        $this->delta(AgentRunEvent::THINKING, $delta);
    }

    public function text(string $delta): void
    {
        $this->delta(AgentRunEvent::TEXT, $delta);
    }

    public function toolStarted(AgentAction $action): void
    {
        $this->write(AgentRunEvent::TOOL_STARTED, [
            'action_id' => $action->id,
            'tool_use_id' => $action->tool_use_id,
            'tool' => $action->tool,
            'input' => $action->input,
            'requires_confirmation' => (bool) $action->requires_confirmation,
        ]);
    }

    public function toolFinished(AgentAction $action): void
    {
        // The result itself is left out on purpose. It is capped at 20KB by
        // `ResultEncoder`, it is already on the action row the client can read,
        // and a stream is not the place to re-send it once per watcher.
        $this->write(AgentRunEvent::TOOL_FINISHED, [
            'action_id' => $action->id,
            'tool_use_id' => $action->tool_use_id,
            'tool' => $action->tool,
            'is_error' => (bool) $action->is_error,
        ]);
    }

    public function awaiting(array $actions): void
    {
        $this->write(AgentRunEvent::AWAITING, [
            'action_ids' => array_map(fn (AgentAction $a) => $a->id, array_values($actions)),
        ]);
    }

    public function finished(string $status, ?string $error = null): void
    {
        $this->write(AgentRunEvent::FINISHED, array_filter([
            'status' => $status,
            'error' => $error,
        ], fn ($v) => $v !== null));
    }

    // ── buffering ────────────────────────────────────────────────────────────

    private function delta(string $type, string $delta): void
    {
        if ($delta === '') {
            return;
        }

        if ($this->buffered !== null && $this->buffered !== $type) {
            $this->flush();
        }

        if ($this->buffered === null) {
            $this->buffered = $type;
            $this->bufferedSince = microtime(true);
        }

        $this->buffer .= $delta;

        $waited = (microtime(true) - $this->bufferedSince) * 1000;

        if (mb_strlen($this->buffer) >= self::FLUSH_CHARS || $waited >= self::FLUSH_MS) {
            $this->flush();
        }
    }

    private function flush(): void
    {
        if ($this->buffered === null || $this->buffer === '') {
            $this->buffer = '';
            $this->buffered = null;

            return;
        }

        $type = $this->buffered;
        $text = $this->buffer;

        $this->buffer = '';
        $this->buffered = null;

        $this->insert($type, ['delta' => $text]);
    }

    /** @param array<string, mixed> $data */
    private function write(string $type, array $data = []): void
    {
        $this->flush();
        $this->insert($type, $data);
    }

    /** @param  array<string, mixed>  $data */
    private function insert(string $type, array $data): void
    {
        $row = [
            'agent_run_id' => $this->run->id,
            'seq' => ++$this->seq,
            'type' => $type,
            'data' => $data === [] ? null : $data,
            'created_at' => now(),
        ];

        // Tried twice, because the one failure worth retrying here is a
        // momentary SQLite lock taken by the request streaming this very log,
        // and it clears in microseconds. Everything else fails the same way the
        // second time and is then let go.
        for ($attempt = 0; $attempt < 2; $attempt++) {
            try {
                AgentRunEvent::create($row);

                return;
            } catch (\Throwable) {
                usleep(20_000);
            }
        }

        // Swallowed deliberately — see the class docblock. The seq stays
        // consumed rather than being handed to the next event: a client asking
        // for "everything after 7" must not be given an 8 that means something
        // different from the 8 it missed.
    }
}
