<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

/**
 * One turn of a transcript, stored in the shape the Messages API accepts.
 *
 * `content` is always a *list of content blocks*, never a string — see the
 * migration for why. Nothing here reshapes it; MessageCodec owns every
 * conversion between this row and the wire.
 */
class ConversationMessage extends Model
{
    public const USER = 'user';

    public const ASSISTANT = 'assistant';

    protected $fillable = [
        'conversation_id',
        'role',
        'content',
        'stop_reason',
        'model',
        'usage',
        'meta',
    ];

    protected $casts = [
        'content' => 'array',
        'usage' => 'array',
        'meta' => 'array',
    ];

    public function conversation(): BelongsTo
    {
        return $this->belongsTo(Conversation::class);
    }

    public function actions(): HasMany
    {
        return $this->hasMany(AgentAction::class)->orderBy('id');
    }
}
