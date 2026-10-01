<?php

namespace App\Models;

use App\Agent\RunOutcome;
use App\Agent\Streaming\RunDispatcher;
use App\Agent\ToolRegistry;
use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

/**
 * One queued trip through the tool loop, and the log of what it did.
 *
 * Not to be confused with {@see RunOutcome}, which is what a *finished* trip
 * returns in memory. This is the row a client watches while that trip is still
 * happening: the job moves it through the statuses and appends events, and the
 * two run routes read it.
 *
 * The statuses a run can *end* on are exactly `RunOutcome`'s, which is why they
 * are referenced rather than restated — a run that finishes reports the same
 * three words the synchronous call used to return. `QUEUED`, `RUNNING` and
 * `FAILED` are new, and only the last of those is interesting: it is the case a
 * blocking request answered with a 502, which has nowhere to be reported now
 * that nobody is waiting on the response.
 */
class AgentRun extends Model
{
    use HasUuids;

    /** Dispatched, no worker has picked it up. */
    public const QUEUED = 'queued';

    /** A worker is in the loop right now. */
    public const RUNNING = 'running';

    /** The model or the tools threw. `error` says what the user is shown. */
    public const FAILED = 'failed';

    /** Started from a user message. */
    public const TRIGGER_MESSAGE = 'message';

    /** Picked the loop back up after the last parked write was decided. */
    public const TRIGGER_RESUME = 'resume';

    /**
     * Delivered by an automation on the HUD's first load past its time (15.3),
     * never typed. The one thing this trigger changes: `RunAgentTurn` builds its
     * runner on {@see ToolRegistry::withoutLocalTools()}, because
     * nobody is at the machine an unattended run could open a window on.
     */
    public const TRIGGER_AUTOMATION = 'automation';

    /**
     * Someone spoke to it.
     *
     * The odd one out: this run is not queued and never was. It is opened,
     * worked and finished inside a single request, because the caller is an
     * ElevenLabs client tool blocked on the response. It takes a row anyway —
     * the row is what makes the conversation look busy while a spoken turn is
     * in flight, and voice and typing share one thread.
     */
    public const TRIGGER_VOICE = 'voice';

    /**
     * How long the request running a voice turn is allowed to live.
     *
     * Past ElevenLabs' own wait on the client tool (`response_timeout_secs`,
     * 120 on the `ask_life_os` tool), so the agent gives up before PHP does.
     * It has to be set at all because Herd's `max_execution_time` is 30s and
     * **on Windows PHP counts that in wall-clock time**, time spent waiting on
     * Claude included, so a turn that thought for half a minute was killed
     * mid-call with a bare 500.
     *
     * It is also what makes a stranded voice run recognisable: a fatal gives
     * the request no chance to finish its row, and no voice run can still be
     * working once this much time has passed. {@see RunDispatcher::active()}.
     */
    public const VOICE_MAX_SECONDS = 150;

    /** Nothing further will happen to a run in one of these. */
    public const TERMINAL = [
        RunOutcome::COMPLETED,
        RunOutcome::AWAITING_CONFIRMATION,
        RunOutcome::MAX_ITERATIONS,
        self::FAILED,
    ];

    /** A run in one of these is still ours to finish, so a second one may not start. */
    public const ACTIVE = [self::QUEUED, self::RUNNING];

    protected $fillable = [
        'conversation_id',
        'trigger',
        'status',
        'error',
        'started_at',
        'finished_at',
    ];

    protected $casts = [
        'started_at' => 'datetime',
        'finished_at' => 'datetime',
    ];

    public function conversation(): BelongsTo
    {
        return $this->belongsTo(Conversation::class);
    }

    public function events(): HasMany
    {
        return $this->hasMany(AgentRunEvent::class)->orderBy('seq');
    }

    public function isFinished(): bool
    {
        return in_array($this->status, self::TERMINAL, true);
    }
}
