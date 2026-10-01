<?php

namespace App\Models;

use App\Agent\Streaming\EventLog;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * One thing that happened during a run, addressed by `seq`.
 *
 * Written only by {@see EventLog}; read by the stream and
 * poll routes. `UPDATED_AT` is off because an event is append-only — it is a
 * fact about a moment, and there is nothing about it that can later change.
 *
 * @see the migration for why these rows are a presentation of the run rather
 *      than its record.
 */
class AgentRunEvent extends Model
{
    public const UPDATED_AT = null;

    /** The run began. Carries nothing; it is the client's cue to clear its buffer. */
    public const STARTED = 'run.started';

    /** A slice of the model's summarised reasoning. */
    public const THINKING = 'thinking';

    /** A slice of the answer, as it is written. */
    public const TEXT = 'text';

    /** A tool call was recorded. Fired for reads and writes alike. */
    public const TOOL_STARTED = 'tool.started';

    /** A tool call came back. Not fired for a write, which stops the run instead. */
    public const TOOL_FINISHED = 'tool.finished';

    /**
     * The run stopped on a proposed write.
     *
     * Emitted before `run.finished` rather than instead of it, so a client has
     * exactly one event that means "stop watching".
     */
    public const AWAITING = 'awaiting';

    /** Terminal. `data.status` is the run's final status, `data.error` set only on a failure. */
    public const FINISHED = 'run.finished';

    protected $fillable = [
        'agent_run_id',
        'seq',
        'type',
        'data',
    ];

    protected $casts = [
        'data' => 'array',
    ];

    public function run(): BelongsTo
    {
        return $this->belongsTo(AgentRun::class, 'agent_run_id');
    }
}
