<?php

namespace App\Models;

use App\Models\Concerns\BelongsToOwner;
use App\Services\Calendar\FeedAddress;
use Illuminate\Database\Eloquent\Model;

/**
 * One calendar, reached through its iCal address — Google's secret address,
 * iCloud's public link, or any other provider's published feed. Stored in the
 * form {@see FeedAddress::normalize()} gives it, so
 * `webcal://` and `https://` spellings of one calendar hash the same.
 *
 * The address is a bearer credential, so it is `encrypted` in the column and
 * `hidden` on the model: nothing that serializes a feed can put it in a
 * response by accident. Setting it also sets `url_hash`, which is the only
 * form of it that can be compared — see the migration.
 */
class CalendarFeed extends Model
{
    use BelongsToOwner;

    /**
     * Google Calendar's own colour names, in the order its picker shows them —
     * for an iCloud calendar too, because Google Calendar is where the user
     * looks at all of them.
     *
     * A closed set for the same reason `equipment.thumbnail` is one: a key the
     * client has no hex for renders as nothing, which cannot be told apart from
     * a calendar that failed to load. The hexes live on the client.
     */
    public const COLORS = [
        'tomato',
        'flamingo',
        'tangerine',
        'banana',
        'sage',
        'basil',
        'peacock',
        'blueberry',
        'lavender',
        'grape',
        'graphite',
    ];

    protected $fillable = ['user_id', 'url', 'name', 'color', 'enabled'];

    protected $hidden = ['url', 'url_hash'];

    // The column's default, repeated so a feed that was just created says
    // `true` rather than null before it has ever been re-read.
    protected $attributes = ['enabled' => true];

    protected $casts = [
        'url' => 'encrypted',
        'enabled' => 'boolean',
    ];

    protected static function booted(): void
    {
        static::saving(function (CalendarFeed $feed): void {
            if ($feed->isDirty('url')) {
                $feed->url_hash = self::hash($feed->url);
            }
        });
    }

    public static function hash(string $url): string
    {
        return hash('sha256', $url);
    }

    /**
     * The first of Google's colours no feed is using yet, so a second calendar
     * does not arrive the same colour as the first unless somebody picks that.
     */
    public static function nextColor(): string
    {
        $used = static::query()->pluck('color')->all();

        foreach (self::COLORS as $color) {
            if (! in_array($color, $used, true)) {
                return $color;
            }
        }

        return 'peacock';
    }
}
