<?php

namespace App\Services;

use App\Models\Setting;

/**
 * The owner's news interests: a short list of topics, each one Google News
 * search when `get_news` is asked for `interests`.
 *
 * **A row, not `localStorage`, for `AssistantSettings`' reason**: the tool runs
 * on the queue worker and inside a voice turn, and an automation's greeting
 * (19.4) reads them with no browser open.
 *
 * **Stored clean, read defensively.** A write is trimmed, blank lines dropped,
 * duplicates dropped case-insensitively (the first spelling wins) and capped at
 * `news.interests.max`; the controller refuses anything longer than
 * {@see self::MAX_CHARS} rather than cutting it. A read re-applies the same
 * cleaning, so a hand-edited row costs its bad entries, never a turn.
 */
final class NewsSettings
{
    public const INTERESTS = 'news.interests';

    /** One topic, not a paragraph: it becomes a search query. */
    public const MAX_CHARS = 60;

    public static function max(): int
    {
        return (int) config('news.interests.max', 10);
    }

    /** @return list<string> */
    public static function interests(): array
    {
        $stored = Setting::value(self::INTERESTS, []);

        return is_array($stored) ? self::clean($stored) : [];
    }

    /** @param  list<?string>  $interests  already validated; nulls are blank lines */
    public static function setInterests(array $interests): void
    {
        Setting::put(self::INTERESTS, self::clean($interests));
    }

    /** @return array{interests: list<string>, max: int, max_chars: int} */
    public static function state(): array
    {
        return [
            'interests' => self::interests(),
            'max' => self::max(),
            'max_chars' => self::MAX_CHARS,
        ];
    }

    /**
     * @param  array<mixed>  $values
     * @return list<string>
     */
    private static function clean(array $values): array
    {
        $kept = [];

        foreach ($values as $value) {
            if (! is_string($value)) {
                continue;
            }

            $value = trim(preg_replace('/\s+/u', ' ', $value) ?? $value);

            if ($value === '' || mb_strlen($value) > self::MAX_CHARS) {
                continue;
            }

            $kept[mb_strtolower($value)] ??= $value;
        }

        return array_slice(array_values($kept), 0, self::max());
    }
}
