<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * One tool call: proposed, decided, and recorded.
 *
 * @see AgentRunner, which creates these, and the migration, which explains why
 *      reads are recorded here alongside writes.
 */
class AgentAction extends Model
{
    /** Proposed and not yet decided. Only ever set on a write. */
    public const PENDING = 'pending';

    /** Ran. A read is born in this state; a write reaches it when the user says so. */
    public const APPROVED = 'approved';

    /** The user said no. The model is told, in a `tool_result` marked as an error. */
    public const REJECTED = 'rejected';

    protected $fillable = [
        'conversation_id',
        'conversation_message_id',
        'tool_use_id',
        'tool',
        'input',
        'requires_confirmation',
        'status',
        'result',
        'is_error',
        'decided_at',
    ];

    protected $casts = [
        'input' => 'array',
        'requires_confirmation' => 'boolean',
        'is_error' => 'boolean',
        'decided_at' => 'datetime',
    ];

    public function conversation(): BelongsTo
    {
        return $this->belongsTo(Conversation::class);
    }

    public function message(): BelongsTo
    {
        return $this->belongsTo(ConversationMessage::class, 'conversation_message_id');
    }

    public function isPending(): bool
    {
        return $this->status === self::PENDING;
    }
}
