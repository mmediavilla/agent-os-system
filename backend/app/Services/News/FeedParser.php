<?php

namespace App\Services\News;

use Carbon\CarbonImmutable;
use SimpleXMLElement;
use Throwable;

/**
 * An RSS or Atom body, as a list of plain items.
 *
 * Pure and static, so every shape a feed arrives in is tested off a string.
 * It never throws: a body that is not a feed is `[]` and a reason, because one
 * outlet sending HTML must cost that outlet, not the answer.
 *
 * **Everything that leaves here is plain text.** Titles and summaries have
 * their tags stripped and entities decoded, because they are read by a model
 * and drawn by a screen, and neither should be handed an outlet's markup. What
 * they *say* is still the outlet's — the tool tells the model it is reporting,
 * never instructions.
 *
 * `LIBXML_NONET` keeps the parser off the network (an external entity or DTD
 * is never fetched); entity substitution is left off, which is PHP's default.
 */
final class FeedParser
{
    private const DC = 'http://purl.org/dc/elements/1.1/';

    /**
     * @param  string  $source  the outlet's name, used unless an item names its own (Google News does)
     * @param  string|null  $zone  read every stamp as this zone's wall clock, whatever offset it carries
     * @param  bool  $summaries  false where the description is not a summary
     * @return array{items: list<array{title: string, link: string, source: string, published_at: ?string, summary: ?string}>, error: ?string}
     */
    public static function parse(string $body, string $source, int $summaryChars, ?string $zone = null, bool $summaries = true): array
    {
        $previous = libxml_use_internal_errors(true);

        try {
            $xml = simplexml_load_string(trim($body), SimpleXMLElement::class, LIBXML_NONET | LIBXML_NOCDATA);
        } catch (Throwable) {
            $xml = false;
        } finally {
            libxml_clear_errors();
            libxml_use_internal_errors($previous);
        }

        if ($xml === false) {
            return ['items' => [], 'error' => 'The outlet did not send a readable news feed.'];
        }

        $entries = match (strtolower($xml->getName())) {
            'rss' => $xml->channel->item,
            'rdf' => $xml->item,
            'feed' => $xml->entry,
            default => null,
        };

        if ($entries === null) {
            return ['items' => [], 'error' => 'The outlet sent something other than a news feed.'];
        }

        $atom = strtolower($xml->getName()) === 'feed';
        $items = [];

        foreach ($entries as $entry) {
            $item = $atom
                ? self::atomEntry($entry, $source, $summaryChars, $zone, $summaries)
                : self::rssItem($entry, $source, $summaryChars, $zone, $summaries);

            if ($item !== null) {
                $items[] = $item;
            }
        }

        return ['items' => $items, 'error' => null];
    }

    /** @return array{title: string, link: string, source: string, published_at: ?string, summary: ?string}|null */
    private static function rssItem(SimpleXMLElement $item, string $source, int $chars, ?string $zone, bool $summaries): ?array
    {
        // An aggregator names the outlet an item came from, and appends it to
        // the headline: "Water interruptions set … - GMA Network".
        $named = self::text((string) $item->source);
        $title = self::text((string) $item->title);

        if ($named !== '') {
            $source = $named;
            $suffix = " - {$named}";

            if (str_ends_with($title, $suffix)) {
                $title = rtrim(substr($title, 0, -strlen($suffix)));
            }
        }

        $stamp = (string) $item->pubDate ?: (string) $item->children(self::DC)->date;

        return self::item(
            $title,
            trim((string) $item->link),
            $source,
            self::instant($stamp, $zone),
            $summaries ? self::summary((string) $item->description, $chars) : null,
        );
    }

    /** @return array{title: string, link: string, source: string, published_at: ?string, summary: ?string}|null */
    private static function atomEntry(SimpleXMLElement $entry, string $source, int $chars, ?string $zone, bool $summaries): ?array
    {
        $link = '';

        foreach ($entry->link as $candidate) {
            $rel = (string) $candidate['rel'];

            if ($rel === '' || $rel === 'alternate') {
                $link = trim((string) $candidate['href']);
                break;
            }
        }

        // `published` is when it went out; `updated` moves with every typo fix.
        $stamp = (string) $entry->published ?: (string) $entry->updated;

        return self::item(
            self::text((string) $entry->title),
            $link,
            $source,
            self::instant($stamp, $zone),
            $summaries ? self::summary((string) $entry->summary ?: (string) $entry->content, $chars) : null,
        );
    }

    /** @return array{title: string, link: string, source: string, published_at: ?string, summary: ?string}|null */
    private static function item(string $title, string $link, string $source, ?string $published, ?string $summary): ?array
    {
        // A link is opened in the owner's browser, so it must be a web page:
        // `javascript:` and friends are dropped with the item.
        if ($title === '' || ! preg_match('~^https?://~i', $link)) {
            return null;
        }

        return [
            'title' => $title,
            'link' => $link,
            'source' => $source,
            'published_at' => $published,
            'summary' => $summary === '' ? null : $summary,
        ];
    }

    /** Markup out, entities decoded, whitespace collapsed. */
    public static function text(string $raw): string
    {
        $text = html_entity_decode(strip_tags($raw), ENT_QUOTES | ENT_HTML5, 'UTF-8');

        return trim(preg_replace('/[\s\x{00A0}]+/u', ' ', $text) ?? $text);
    }

    private static function summary(string $raw, int $chars): string
    {
        $text = self::text($raw);

        if (mb_strlen($text) <= $chars) {
            return $text;
        }

        $cut = mb_substr($text, 0, $chars - 1);
        $space = mb_strrpos($cut, ' ');

        // Back to a word boundary, unless that would throw away most of it.
        if ($space !== false && $space > $chars * 0.7) {
            $cut = mb_substr($cut, 0, $space);
        }

        return rtrim($cut, " \t,;:.-–—").'…';
    }

    /**
     * A stamp as an ISO-8601 instant in UTC, or null when there is none to read.
     *
     * With a `$zone`, the stamp's offset is ignored and its wall clock is read
     * in that zone — the correction for a feed that labels local time as UTC.
     */
    private static function instant(string $stamp, ?string $zone): ?string
    {
        $stamp = trim($stamp);

        if ($stamp === '') {
            return null;
        }

        try {
            $at = CarbonImmutable::parse($stamp);

            if ($zone !== null) {
                $at = CarbonImmutable::createFromFormat('Y-m-d H:i:s', $at->format('Y-m-d H:i:s'), $zone);
            }

            return $at->utc()->toIso8601String();
        } catch (Throwable) {
            return null;
        }
    }
}
