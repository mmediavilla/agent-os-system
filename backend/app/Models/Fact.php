<?php

namespace App\Models;

use App\Models\Concerns\BelongsToOwner;
use App\Services\Facts\FactWriter;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * One claim about the owner — "food / coffee: black, no sugar".
 *
 * Written only through {@see FactWriter}, which is what
 * keeps the one-active-per-key rule a transaction rather than a hope.
 */
class Fact extends Model
{
    use BelongsToOwner;

    public const STATED = 'stated';

    public const INFERRED = 'inferred';

    public const CONFIDENCES = [self::STATED, self::INFERRED];

    public const SOURCES = ['chat', 'voice', 'manual', 'extracted'];

    public const PROPOSED = 'proposed';

    public const ACTIVE = 'active';

    public const SUPERSEDED = 'superseded';

    public const REJECTED = 'rejected';

    protected $fillable = [
        'user_id',
        'category',
        'key',
        'value',
        'confidence',
        'source',
        'status',
        'conversation_id',
        'learned_at',
        'decided_at',
    ];

    protected $casts = [
        'learned_at' => 'datetime',
        'decided_at' => 'datetime',
    ];

    public function conversation(): BelongsTo
    {
        return $this->belongsTo(Conversation::class);
    }

    public function scopeActive(Builder $query): Builder
    {
        return $query->where('status', self::ACTIVE);
    }
}
