<?php

namespace App\Models;

use App\Models\Concerns\BelongsToOwner;
use App\Models\Concerns\FiltersCatalog;
use App\Support\SignedUrl;
use Illuminate\Database\Eloquent\Model;

class Equipment extends Model
{
    use BelongsToOwner, FiltersCatalog;

    /**
     * "equipment" is uncountable, so Str::plural() leaves it alone and the
     * convention would already land here — pinned so a future inflector change
     * cannot silently repoint the model at "equipments".
     */
    protected $table = 'equipment';

    /**
     * Columns a caller may narrow the list by, each matched exactly. `status` is
     * a closed set; `equipment_type` is free text the form suggests values for,
     * so a filter on it can only usefully name one the catalog already holds.
     */
    public const FILTERS = ['equipment_type', 'status'];

    /** Statuses a client may set. Kept in sync with app/src/equipmentConstants.ts. */
    public const STATUSES = ['active', 'broken', 'wishlist'];

    /**
     * Illustrations a client may pin an item to when it has no photo. Nothing
     * is stored on disk for these — the drawing itself lives in the app
     * (app/src/equipmentArt.ts) and this is only the key naming it, so the
     * list has to be kept in sync with EQUIPMENT_ARTS there.
     *
     * Validated as a closed set rather than free text, unlike equipment_type:
     * a key with no drawing behind it would render as an empty box, and the
     * client could not tell that apart from a picture that failed to load.
     */
    public const THUMBNAILS = [
        'barbell', 'dumbbell', 'kettlebell', 'plate', 'bench', 'rack', 'pullup', 'treadmill',
        'bike', 'rower', 'cable', 'machine', 'band', 'mat', 'rope', 'duffel',
    ];

    protected $fillable = [
        'user_id',
        'name',
        'equipment_type',
        'image_path',
        'thumbnail',
        'status',
        'notes',
    ];

    /** The raw disk path is an implementation detail; clients get a URL instead. */
    protected $hidden = ['image_path'];

    protected $appends = ['image_url'];

    /**
     * Where the client fetches this item's photo, or null when it has none.
     *
     * Images are served by the API, not from the web root, so there is no
     * `storage:link` step to get wrong on a fresh checkout. The `v` parameter is
     * the row's updated_at: uploading a replacement touches the row, which
     * changes the URL and defeats the browser's cache for the old photo.
     *
     * Signed, because an `<img>` cannot send the bearer token — see SignedUrl.
     */
    public function getImageUrlAttribute(): ?string
    {
        if (! $this->image_path) {
            return null;
        }

        return SignedUrl::picture('equipment.image', [
            'equipment' => $this->id,
            'v' => $this->updated_at?->timestamp ?? 0,
        ]);
    }
}
