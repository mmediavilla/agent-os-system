<?php

namespace App\Services\Calendar;

use DateTimeImmutable;
use DateTimeInterface;
use DateTimeZone;
use Sabre\VObject\Component\VEvent;
use Sabre\VObject\ParseException;
use Sabre\VObject\Reader;
use Sabre\VObject\Recur\EventIterator;
use Sabre\VObject\Recur\NoInstancesException;
use Sabre\VObject\Settings;
use Throwable;

/**
 * An iCalendar body in, a list of wall-clock rows out.
 *
 * A pure function of its arguments — no HTTP, no cache, no config — so every
 * rule about what an event *means* is tested off a fixture string.
 *
 * **This is the one place in the calendar where a time is converted.** A feed
 * serves instants (`20260910T070000Z`) or zoned times (`TZID=America/New_York`),
 * and the rest of the app speaks wall clock (`2026-09-10T15:00:00`, no offset,
 * no `Z` — see CLAUDE.md on why). Everything is moved onto the user's clock
 * here, once, and nothing downstream converts again.
 *
 * Three things `VCalendar::expand()` would have done wrong, which is why the
 * expansion is written out:
 *
 * - **One runaway series takes the whole calendar down with it.** Sabre counts
 *   every instance from DTSTART, including the ones it fast-forwards past, and
 *   throws at 3,500 — so a daily reminder created ten years ago makes `expand()`
 *   throw for *every* event. Here the cap is raised for the duration and each
 *   series is expanded on its own, so a series that still overflows is skipped
 *   and counted rather than blanking the week. A malformed one-off event is
 *   skipped and counted the same way.
 * - **All-day and floating times need a zone of their own.** An all-day event
 *   is a date, not a UTC midnight; compared as an instant it leaks into the day
 *   before for anyone east of Greenwich.
 * - **Memory.** A feed carries every event the calendar ever held. Parsing is
 *   roughly 40MB per megabyte of text, measured, so one-off events wholly
 *   outside the window are cut from the text before the parser sees it — see
 *   {@see self::trim()}.
 */
final class IcsReader
{
    /**
     * The wire format for a wall-clock time: no offset and no `Z`, which is the
     * one form `new Date()` in the browser reads as local rather than UTC.
     */
    public const WIRE_FORMAT = 'Y-m-d\TH:i:s';

    /** Instances a single series may walk through, fast-forwarding included. */
    private const MAX_INSTANCES = 50_000;

    /**
     * @return array{name: string|null, events: list<array{title: string, starts_at: string, ends_at: string|null, all_day: bool, location: string|null}>, skipped: int}
     *
     * @throws ParseException when the body is not a calendar at all
     */
    public function read(string $body, DateTimeZone $zone, DateTimeInterface $from, DateTimeInterface $to): array
    {
        $calendar = Reader::read($this->trim($body, $from, $to), Reader::OPTION_FORGIVING);

        if ($calendar->name !== 'VCALENDAR') {
            throw new ParseException('Not an iCalendar body.');
        }

        $rows = [];
        $series = [];
        $skipped = 0;

        foreach ($calendar->select('VEVENT') as $event) {
            if (isset($event->{'RECURRENCE-ID'}) || isset($event->RRULE) || isset($event->RDATE)) {
                // Grouped by UID, because a moved instance is a separate VEVENT
                // that only means anything beside the series it overrides.
                $series[(string) $event->UID][] = $event;

                continue;
            }

            // One malformed event costs that event, not the calendar.
            try {
                if ($row = $this->row($event, $zone)) {
                    $rows[] = $row;
                }
            } catch (Throwable) {
                $skipped++;
            }
        }

        $cap = Settings::$maxRecurrences;
        Settings::$maxRecurrences = self::MAX_INSTANCES;

        try {
            foreach ($series as $events) {
                try {
                    $instances = new EventIterator($events, null, $zone);
                    $instances->fastForward(DateTimeImmutable::createFromInterface($from));

                    while ($instances->valid() && $instances->getDtStart() < $to) {
                        if ($row = $this->row($instances->getEventObject(), $zone)) {
                            $rows[] = $row;
                        }
                        $instances->next();
                    }
                } catch (NoInstancesException) {
                    // A rule that generates nothing — every instance excluded.
                    continue;
                } catch (Throwable) {
                    $skipped++;
                }
            }
        } finally {
            Settings::$maxRecurrences = $cap;
        }

        $first = DateTimeImmutable::createFromInterface($from)->setTimezone($zone)->format(self::WIRE_FORMAT);
        $last = DateTimeImmutable::createFromInterface($to)->setTimezone($zone)->format(self::WIRE_FORMAT);

        // Inside the window by wall clock, now that everything is on one clock.
        $rows = array_values(array_filter($rows, fn (array $r) => self::overlaps($r, $first, $last)));

        usort($rows, fn (array $a, array $b) => [$a['starts_at'], ! $a['all_day'], $a['title']]
            <=> [$b['starts_at'], ! $b['all_day'], $b['title']]);

        $name = isset($calendar->{'X-WR-CALNAME'}) ? trim((string) $calendar->{'X-WR-CALNAME'}) : '';

        return ['name' => $name !== '' ? $name : null, 'events' => $rows, 'skipped' => $skipped];
    }

    /**
     * Whether a row falls in [from, to), both wall-clock strings.
     *
     * Overlap rather than "starts inside": a holiday that began on Friday is
     * still on Saturday. A moment with no end counts where it starts.
     *
     * @param  array{starts_at: string, ends_at: string|null}  $row
     */
    public static function overlaps(array $row, string $from, string $to): bool
    {
        if ($row['starts_at'] >= $to) {
            return false;
        }

        return $row['ends_at'] === null
            ? $row['starts_at'] >= $from
            : $row['ends_at'] > $from;
    }

    /**
     * One VEVENT as a row, or null when it is not on the calendar at all.
     *
     * @return array{title: string, starts_at: string, ends_at: string|null, all_day: bool, location: string|null}|null
     */
    private function row(VEvent $event, DateTimeZone $zone): ?array
    {
        if (! isset($event->DTSTART) || strtoupper((string) $event->STATUS) === 'CANCELLED') {
            return null;
        }

        $allDay = ! $event->DTSTART->hasTime();

        // `getDateTime($zone)` reads a floating time or a date *in* the user's
        // zone; `setTimezone` then moves an instant or a zoned time onto it.
        $start = $event->DTSTART->getDateTime($zone)->setTimezone($zone);

        if (isset($event->DTEND)) {
            $end = $event->DTEND->getDateTime($zone)->setTimezone($zone);
        } elseif (isset($event->DURATION)) {
            $end = $start->add($event->DURATION->getDateInterval());
        } else {
            // RFC 5545: an all-day event with no end is that one day, and a
            // timed one with no end is a moment.
            $end = $allDay ? $start->modify('+1 day') : null;
        }

        $title = trim((string) $event->SUMMARY);
        $location = trim((string) $event->LOCATION);

        return [
            'title' => $title !== '' ? $title : '(No title)',
            'starts_at' => $start->format(self::WIRE_FORMAT),
            // Exclusive, as iCalendar has it: an all-day event on the 12th ends
            // at midnight starting the 13th.
            'ends_at' => $end?->format(self::WIRE_FORMAT),
            'all_day' => $allDay,
            'location' => $location !== '' ? $location : null,
        ];
    }

    /**
     * The body with every one-off event wholly outside the window removed.
     *
     * Deliberately conservative, because a wrong cut loses an event and a wrong
     * keep only costs memory: anything recurring, anything with a DURATION, and
     * anything whose dates cannot be read off its text is kept for the parser to
     * decide, and the dates are compared with two days of slack so a UTC value
     * near midnight is never cut on the wrong side of the user's day.
     */
    private function trim(string $body, DateTimeInterface $from, DateTimeInterface $to): string
    {
        $floor = DateTimeImmutable::createFromInterface($from)->modify('-2 days')->format('Ymd');
        $ceiling = DateTimeImmutable::createFromInterface($to)->modify('+2 days')->format('Ymd');

        $trimmed = preg_replace_callback(
            '/BEGIN:VEVENT\r?\n.*?END:VEVENT(\r?\n|$)/s',
            function (array $match) use ($floor, $ceiling): string {
                $event = $match[0];

                if (preg_match('/^(RRULE|RDATE|RECURRENCE-ID|DURATION)[;:]/m', $event)
                    || ! preg_match('/^DTSTART[^:\r\n]*:(\d{8})/m', $event, $start)) {
                    return $event;
                }

                $end = preg_match('/^DTEND[^:\r\n]*:(\d{8})/m', $event, $e) ? $e[1] : $start[1];

                return $end < $floor || $start[1] > $ceiling ? '' : $event;
            },
            $body,
        );

        // A backtracking failure returns null; the untrimmed body is still
        // correct, only more expensive.
        return $trimmed ?? $body;
    }
}
