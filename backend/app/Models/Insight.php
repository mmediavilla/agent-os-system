<?php

namespace App\Models;

use App\Models\Concerns\BelongsToOwner;
use Illuminate\Database\Eloquent\Model;

class Insight extends Model
{
    use BelongsToOwner;

    protected $fillable = [
        'user_id',
        'domain',
        'kind',
        'title',
        'response',
        'input_summary',
        'usage',
        'model',
    ];

    protected $casts = [
        'input_summary' => 'array',
        'usage' => 'array',
    ];
}
