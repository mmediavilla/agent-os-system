<?php

namespace App\Models;

use App\Models\Concerns\BelongsToOwner;
use Illuminate\Database\Eloquent\Model;

/**
 * A scheduled conversation — "Morning greeting", 06:30, agenda + weather +
 * training. Delivered on the HUD's first load past its time, never a cron tick;
 * see `AutomationController::due()` and `Services\Automations\AutomationRunner`.
 */
class Automation extends Model
{
    use BelongsToOwner;

    public const OK = 'ok';

    public const FAILED = 'failed';

    public const SKIPPED = 'skipped';

    public const OUTCOMES = [self::OK, self::FAILED, self::SKIPPED];

    /**
     * What `AutomationRunner` may fetch to build the first turn. Facts need no
     * fetch — they are already in the system prompt. `deadlines` (16.2) is the
     * whole of how a deadline speaks unprompted: an automation the owner
     * switched on, never a fitness trigger. `news` (19.4) is the local beat,
     * then the owner's interests when any are set.
     */
    public const CONTEXT = ['agenda', 'weather', 'training', 'deadlines', 'facts', 'news'];

    protected $fillable = [
        'user_id',
        'name',
        'time',
        'intent',
        'context',
        'enabled',
        'last_run_on',
        'last_run_at',
        'last_outcome',
        'last_error',
        'last_conversation_id',
    ];

    protected $casts = [
        'context' => 'array',
        'enabled' => 'boolean',
        'last_run_on' => 'date',
        'last_run_at' => 'datetime',
    ];
}
