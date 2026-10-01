<?php

namespace App\Models\Concerns;

use Illuminate\Database\Eloquent\Builder;

/**
 * The name search and exact-match filters both catalogs (exercises, equipment)
 * offer.
 *
 * These lived in `ExerciseController::index()` and `EquipmentController::index()`
 * as two copies of the same escaped-LIKE clause and the same filter loop. They
 * are scopes now because the agent's `search_exercises` and `list_equipment`
 * tools have to narrow a catalog the same way the screens do — a tool that
 * matched differently from the UI would answer questions about a list the user
 * cannot see.
 *
 * A model using this declares `public const FILTERS`: the columns a caller may
 * narrow by. Anything not on that list is ignored rather than rejected, so the
 * filter set is a whitelist and a query string can never reach an arbitrary
 * column.
 */
trait FiltersCatalog
{
    /** Substring match on `name` — what both catalogs search by. */
    public function scopeSearchName(Builder $query, ?string $term): Builder
    {
        return $this->scopeSearchColumns($query, $term, ['name']);
    }

    /**
     * Substring match across one or more columns, any of which may hit.
     *
     * LIKE metacharacters are escaped so searching for "50%" or "warm_up"
     * matches those literals instead of acting as wildcards. The escape
     * character is deliberately not a backslash: MySQL processes backslashes
     * inside string literals, so ESCAPE '\' is a syntax error there, while '!'
     * is portable across MySQL and SQLite.
     *
     * A blank term is a no-op — a cleared search box reads the same as an
     * untouched one.
     *
     * The columns are named by the model, never by a request: they are
     * interpolated into raw SQL, so the whitelist is the same rule
     * {@see self::scopeApplyFilters()} follows for filters.
     *
     * Grouped, because a search is one condition however many columns it
     * looks in — left ungrouped, an `orWhere` would escape whatever filter
     * ran before it and return the whole table.
     *
     * @param  list<string>  $columns
     */
    public function scopeSearchColumns(Builder $query, ?string $term, array $columns): Builder
    {
        if ($term === null || trim($term) === '') {
            return $query;
        }

        $escaped = '%'.str_replace(['!', '%', '_'], ['!!', '!%', '!_'], $term).'%';

        return $query->where(function (Builder $query) use ($columns, $escaped): void {
            foreach ($columns as $column) {
                $query->orWhereRaw("{$column} LIKE ? ESCAPE '!'", [$escaped]);
            }
        });
    }

    /**
     * Exact matches on whichever of `self::FILTERS` the caller supplied.
     *
     * Blank and null values are skipped for the same reason a blank search is:
     * a cleared picker means "no filter", not "rows whose column is empty".
     *
     * @param  array<string, mixed>  $values  keyed by column
     */
    public function scopeApplyFilters(Builder $query, array $values): Builder
    {
        foreach (static::FILTERS as $field) {
            $value = $values[$field] ?? null;

            // blank() rather than a null/'' check, matching the `$request->filled()`
            // these scopes replaced: it also skips a whitespace-only value, which
            // otherwise filters on " " and returns nothing where the controllers
            // used to return everything.
            if (blank($value)) {
                continue;
            }

            $query->where($field, $value);
        }

        return $query;
    }
}
