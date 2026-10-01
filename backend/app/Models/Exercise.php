<?php

namespace App\Models;

use App\Models\Concerns\BelongsToOwner;
use App\Models\Concerns\FiltersCatalog;
use Illuminate\Database\Eloquent\Model;

class Exercise extends Model
{
    use BelongsToOwner, FiltersCatalog;

    /**
     * Columns a caller may narrow the list by. Each is matched exactly, against
     * the same vocabulary the form writes, so a filter can only ever name a
     * value an exercise could actually hold.
     */
    public const FILTERS = ['primary_muscle', 'equipment', 'exercise_type'];

    /** Movement patterns an exercise may be, matching the exercise_type rule. */
    public const TYPES = ['weight_reps', 'reps_only', 'duration', 'distance_duration'];

    protected $fillable = [
        'user_id',
        'name',
        'primary_muscle',
        'equipment',
        'exercise_type',
        'notes',
    ];
}
