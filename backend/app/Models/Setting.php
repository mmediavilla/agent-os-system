<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * One user-flipped setting, stored by name.
 *
 * The accessors are static because every caller wants one value and none wants
 * the row: `Setting::bool()` reads it and `Setting::put()` writes it, and
 * nothing in the app holds an instance of this. That keeps the call sites
 * honest — `AnthropicSwitch::enabled()` is a question about the switch, not a
 * query about a table.
 *
 * Reads are **not cached**. This is looked at once per model call and once per
 * health poll, which is a primary-key lookup on a table with one row in it, and
 * the alternative is a second copy of the truth that a cache flush can silently
 * disagree with — see the migration for why that direction is the dangerous
 * one.
 */
class Setting extends Model
{
    protected $primaryKey = 'key';

    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['key', 'value'];

    /**
     * A stored boolean, or `$default` when nothing has ever been stored.
     *
     * "Never set" and "set to false" are deliberately different: the first
     * means the user has not had an opinion yet and the shipped default holds,
     * the second means they said no.
     */
    public static function bool(string $key, bool $default): bool
    {
        $row = static::query()->find($key);

        if ($row === null) {
            return $default;
        }

        // Decoded here rather than through a cast: `array` is the only json
        // cast Eloquent offers and this column holds scalars, so the cast would
        // be describing the wrong shape to save one call.
        $value = json_decode((string) $row->value, true);

        return is_bool($value) ? $value : $default;
    }

    /**
     * A stored value of any shape, or `$default` when nothing has been stored.
     *
     * Unvalidated on purpose: the caller owns the closed set its value belongs
     * to (`FitnessSettings` checks a time against its pattern and a trigger
     * list against the triggers), so a row that no longer fits falls back there
     * rather than here.
     */
    public static function value(string $key, mixed $default = null): mixed
    {
        $row = static::query()->find($key);

        return $row === null ? $default : json_decode((string) $row->value, true);
    }

    public static function put(string $key, mixed $value): void
    {
        static::query()->updateOrCreate(['key' => $key], ['value' => json_encode($value)]);
    }
}
