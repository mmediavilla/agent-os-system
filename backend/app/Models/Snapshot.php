<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Facades\Storage;

/**
 * One camera frame the user chose to send.
 *
 * A snapshot is immutable by construction: it is written once, streamed back
 * unchanged, and deleted with the thread it belongs to. There is no update
 * path, which is what lets `GET /api/agent/snapshots/{id}` answer `immutable`
 * without a version in the URL — unlike an equipment photo, which can be
 * replaced and therefore carries `?v={updated_at}`.
 *
 * The file is removed here rather than by the caller. A snapshot reaches its
 * end two ways — the thread is deleted, or the daily sweep drops an old one —
 * and a hook is the only place both of them pass through.
 */
class Snapshot extends Model
{
    protected $fillable = [
        'conversation_id',
        'path',
        'media_type',
        'bytes',
        'width',
        'height',
    ];

    protected $casts = [
        'bytes' => 'integer',
        'width' => 'integer',
        'height' => 'integer',
    ];

    protected static function booted(): void
    {
        static::deleting(function (Snapshot $snapshot): void {
            // Missing is fine and is the ordinary case for a checkout whose
            // storage folder was never copied: the row is what is being
            // removed, and the file not being there is the desired end state.
            if ($snapshot->path && Storage::exists($snapshot->path)) {
                Storage::delete($snapshot->path);
            }
        });
    }

    public function conversation(): BelongsTo
    {
        return $this->belongsTo(Conversation::class);
    }

    /** The bytes, or null where the row outlived its file. */
    public function contents(): ?string
    {
        if (! $this->path || ! Storage::exists($this->path)) {
            return null;
        }

        return Storage::get($this->path);
    }
}
