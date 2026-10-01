<?php

namespace App\Models;

use App\Models\Concerns\BelongsToOwner;
use App\Models\Concerns\FiltersCatalog;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * A date somebody must act on — renew the visa, file the return, pay the
 * premium. May point at the document it is about, and outlives it.
 *
 * **Completion has its own route**, not a field in the PATCH: `completed_at`
 * is left out of `$fillable` so an edit to the title can never tick a deadline
 * off, and so completing twice keeps the first date rather than burying it.
 */
class Deadline extends Model
{
    use BelongsToOwner, FiltersCatalog;

    /** Columns a caller may narrow the list by, each matched exactly. */
    public const FILTERS = ['kind'];

    /**
     * What the form offers for `kind`. **A suggestion, not a constraint** —
     * `Document::KINDS`' rule, for its reason: whatever this year brings has to
     * be trackable without a migration.
     */
    public const KINDS = [
        'renewal', 'filing', 'payment', 'application', 'submission', 'other',
    ];

    /** `open`, `completed` or `all` — what the list and the tool may ask for. */
    public const STATUSES = ['open', 'completed', 'all'];

    protected $fillable = [
        'user_id',
        'title',
        'due_on',
        'kind',
        'document_id',
        'notes',
    ];

    protected $casts = [
        // A wall-calendar date, formatted rather than left to Eloquent's
        // ISO-with-a-Z, which the browser would read as UTC and draw a day out.
        'due_on' => 'date:Y-m-d',
        'completed_at' => 'datetime',
    ];

    public function document(): BelongsTo
    {
        return $this->belongsTo(Document::class);
    }

    /** Narrow to open or completed rows; `all` or null leaves the query alone. */
    public function scopeStatus(Builder $query, ?string $status): Builder
    {
        return match ($status) {
            'open' => $query->whereNull('completed_at'),
            'completed' => $query->whereNotNull('completed_at'),
            default => $query,
        };
    }

    /**
     * Open rows first, soonest due at the top — overdue ones included, since
     * they are the most urgent — then completed rows, most recently done
     * first. One order for the overlay and the tool, so they cannot disagree
     * about what comes next.
     */
    public function scopeInAgendaOrder(Builder $query): Builder
    {
        return $query
            ->orderByRaw('completed_at is not null')
            ->orderByRaw('case when completed_at is null then due_on end asc')
            ->orderByDesc('completed_at')
            ->orderBy('id');
    }

    /** Substring match over what a person would search by. */
    public function scopeSearchText(Builder $query, ?string $term): Builder
    {
        return $this->scopeSearchColumns($query, $term, ['title', 'kind', 'notes']);
    }
}
