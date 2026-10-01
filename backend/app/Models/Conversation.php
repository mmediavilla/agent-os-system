<?php

namespace App\Models;

use App\Models\Concerns\BelongsToOwner;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Support\Str;

/**
 * One thread with the assistant.
 *
 * @see AgentRunner for what actually moves a conversation forward.
 */
class Conversation extends Model
{
    use BelongsToOwner;

    /** How long a derived title is allowed to be before it is cut. */
    private const TITLE_LENGTH = 60;

    protected $fillable = [
        'user_id',
        'title',
        'last_message_at',
    ];

    protected $casts = [
        'last_message_at' => 'datetime',
    ];

    /**
     * Snapshots are deleted here rather than by the foreign key.
     *
     * `conversation_id` cascades, so the rows would go either way — but a
     * database cascade fires no model events, and the *files* only go when
     * Snapshot's `deleting` hook runs. Without this, deleting a thread leaves
     * its pictures on disk with nothing left pointing at them.
     */
    protected static function booted(): void
    {
        static::deleting(function (Conversation $conversation): void {
            $conversation->snapshots()->get()->each->delete();
        });
    }

    public function snapshots(): HasMany
    {
        return $this->hasMany(Snapshot::class);
    }

    public function messages(): HasMany
    {
        return $this->hasMany(ConversationMessage::class)->orderBy('id');
    }

    public function actions(): HasMany
    {
        return $this->hasMany(AgentAction::class)->orderBy('id');
    }

    public function pendingActions(): HasMany
    {
        return $this->actions()->where('status', AgentAction::PENDING);
    }

    /**
     * A conversation is waiting on the user when a write it proposed has not
     * been decided. Every entry point checks this first: sending another message
     * while a turn is parked would leave the transcript with an assistant turn
     * whose `tool_use` blocks are never answered, which the API rejects.
     */
    public function isAwaitingConfirmation(): bool
    {
        return $this->pendingActions()->exists();
    }

    /**
     * Name the thread after whatever opened it.
     *
     * Titles are derived rather than asked for because a client that has to
     * prompt for one before the first message adds a step to every conversation,
     * and asking the model to name it costs a call. Cut on a word boundary so
     * the result reads like a phrase rather than a truncated sentence.
     */
    public static function deriveTitle(string $firstMessage): string
    {
        $clean = trim(preg_replace('/\s+/', ' ', $firstMessage) ?? '');

        if ($clean === '') {
            return 'New conversation';
        }

        return Str::limit($clean, self::TITLE_LENGTH, '…');
    }
}
