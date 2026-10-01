<?php

namespace App\Models;

use App\Models\Concerns\BelongsToOwner;
use App\Models\Concerns\FiltersCatalog;
use App\Services\Documents\DocumentStore;
use App\Support\SignedUrl;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;

/**
 * One filed artifact — a passport, a policy, a receipt, a contract.
 *
 * The file itself is written only through {@see DocumentStore}, which is what
 * keeps "the type in this row is the type of those bytes" true. Nothing else
 * touches the disk, including this model: its `deleting` hook calls the store.
 */
class Document extends Model
{
    use BelongsToOwner, FiltersCatalog;

    /** Columns a caller may narrow the list by, each matched exactly. */
    public const FILTERS = ['kind'];

    /**
     * What the form offers for `kind`, and what the assistant is told is in
     * use. **A suggestion, not a constraint** — the column is free text, like
     * `equipment_type`, because a closed set would be wrong within a week of
     * the first year's filing and every addition would be a migration.
     *
     * The cost is drift ("policy" and "Insurance policy" as two kinds), which
     * is accepted here as it is there; the list is the mitigation.
     */
    public const KINDS = [
        'passport', 'visa', 'policy', 'contract', 'receipt', 'invoice',
        'certificate', 'licence', 'statement', 'form', 'other',
    ];

    /**
     * The file columns are absent on purpose: they are the store's to write,
     * and leaving them out is what stops a JSON PATCH pointing a row at a file
     * that nothing checked.
     */
    protected $fillable = [
        'user_id',
        'title',
        'kind',
        'issued_on',
        'expires_on',
        'notes',
    ];

    /** The raw disk path is an implementation detail; clients get a URL. */
    protected $hidden = ['file_path'];

    protected $appends = ['file_url'];

    protected $casts = [
        // Bare dates, formatted rather than left to Eloquent's ISO-with-a-Z.
        // A document's dates are wall-calendar dates — a passport expires on a
        // day, not at an instant — and the calendar epic's rule applies: a `Z`
        // is read as UTC by the browser and drawn a day out east of Greenwich.
        'issued_on' => 'date:Y-m-d',
        'expires_on' => 'date:Y-m-d',
        'size_bytes' => 'integer',
    ];

    protected static function booted(): void
    {
        static::deleting(function (Document $document): void {
            // Through the model rather than from the controller, because a
            // database cascade fires no events and the file would outlive the
            // row — `Snapshot`'s precedent exactly.
            DocumentStore::discard($document);
        });
    }

    /**
     * Where the browser fetches this document, or null when nothing is filed.
     *
     * Signed, because neither an `<a download>` nor an `<embed>` can send the
     * bearer token — the same problem the equipment photo has, with the same
     * answer: the URL is minted inside a response that did pass the gate, so
     * holding one is proof of that.
     *
     * `?v=` is the row's `updated_at`, so replacing the file changes the URL,
     * which is what lets the response be `immutable` without ever serving a
     * stale copy.
     */
    public function getFileUrlAttribute(): ?string
    {
        if (! $this->file_path) {
            return null;
        }

        return SignedUrl::file('documents.file', [
            'document' => $this->id,
            'v' => $this->updated_at?->timestamp ?? 0,
        ]);
    }

    /**
     * Substring match across the three columns a person would search by.
     *
     * Wider than the catalogs' `searchName`, and deliberately: a document is
     * looked for by what it is about as often as by what it is called, and
     * "the Allianz one" is in the notes. Full text, tags and folders are all
     * out of this epic — the cap is a file, its metadata, a date, and a tool
     * that can find them.
     */
    public function scopeSearchText(Builder $query, ?string $term): Builder
    {
        return $this->scopeSearchColumns($query, $term, ['title', 'kind', 'notes']);
    }
}
