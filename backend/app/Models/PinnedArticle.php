<?php

namespace App\Models;

use App\Models\Concerns\BelongsToOwner;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;

/**
 * A news item the owner put aside to read later — a snapshot of what was
 * reported, which outlives the feed and the item registry it came from.
 *
 * **`PinWriter` is the only writer.** `read_at` is left out of `$fillable`, so
 * nothing but its own route can mark a pin read — the deadlines' `completed_at`
 * rule.
 */
class PinnedArticle extends Model
{
    use BelongsToOwner;

    /** `unread`, `read` or `all` — what the list and the tool may ask for. */
    public const STATUSES = ['unread', 'read', 'all'];

    protected $fillable = [
        'user_id',
        'item_id',
        'title',
        'source',
        'link',
        'summary',
        'published_at',
    ];

    protected $casts = [
        'published_at' => 'datetime',
        'read_at' => 'datetime',
    ];

    /** Narrow to unread or read rows; `all` or null leaves the query alone. */
    public function scopeStatus(Builder $query, ?string $status): Builder
    {
        return match ($status) {
            'unread' => $query->whereNull('read_at'),
            'read' => $query->whereNotNull('read_at'),
            default => $query,
        };
    }

    /**
     * Unread first, then read, each newest pin first. One order for the HUD
     * and the tool, so "the first one I pinned" means the same thing on both.
     */
    public function scopeInReadingOrder(Builder $query): Builder
    {
        return $query
            ->orderByRaw('read_at is not null')
            ->orderByDesc('created_at')
            ->orderByDesc('id');
    }
}
