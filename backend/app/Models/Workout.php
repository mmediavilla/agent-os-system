<?php

namespace App\Models;

use App\Models\Concerns\BelongsToOwner;
use Illuminate\Database\Eloquent\Casts\Attribute;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;

class Workout extends Model
{
    use BelongsToOwner;

    protected $fillable = [
        'user_id',
        'title',
        'started_at',
        'ended_at',
        'description',
        'notes',
    ];

    protected $casts = [
        'started_at' => 'datetime',
        'ended_at' => 'datetime',
    ];

    protected $appends = ['duration_minutes'];

    protected function durationMinutes(): Attribute
    {
        return Attribute::make(
            get: fn () => $this->ended_at && $this->started_at
                ? (int) round($this->started_at->diffInMinutes($this->ended_at))
                : null,
        );
    }

    public function sets(): HasMany
    {
        return $this->hasMany(WorkoutSet::class);
    }
}
