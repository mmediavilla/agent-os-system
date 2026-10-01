<?php

namespace App\Models\Concerns;

use App\Models\User;
use App\Services\Owner;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * An owned row: it belongs to a user, and it fills that in for itself.
 *
 * **The stamping is on the model rather than in the writers, and that is the
 * point of the trait.** Six of the nine places that create an owned row wrote no
 * owner at all — `WorkoutWriter`, the CSV import, the weekly assessment, the
 * agent's `save_insight`, the 07:00 nudge, and `Conversation::create` — so a
 * rule of the form "remember to pass an owner" had already been forgotten twice
 * as often as it had been followed. Filling it in at `creating` means a write
 * site added tomorrow cannot skip it, which is the same argument that makes
 * `MutatingTool` a marker interface rather than a list of tool names kept
 * somewhere else.
 *
 * **It defers to an owner already set** (`??=`), so the three callers that pass
 * one explicitly keep deciding, and a multi-user path later has somewhere to put
 * its answer. The default is a default, not a mandate.
 */
trait BelongsToOwner
{
    public static function bootBelongsToOwner(): void
    {
        static::creating(function (Model $model): void {
            $model->user_id ??= Owner::id();
        });
    }

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }
}
