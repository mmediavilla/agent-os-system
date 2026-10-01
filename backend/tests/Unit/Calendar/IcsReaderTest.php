<?php

namespace Tests\Unit\Calendar;

use App\Services\Calendar\IcsReader;
use DateTimeImmutable;
use DateTimeZone;
use PHPUnit\Framework\TestCase;
use Sabre\VObject\ParseException;
use Sabre\VObject\Settings;

/**
 * The parser, off literal iCalendar text — no application booted.
 *
 * Every body is built the way Google serves it: CRLF lines, UTC instants for
 * most events, TZID for the rest, DATE values for all-day ones.
 */
class IcsReaderTest extends TestCase
{
    private DateTimeZone $manila;

    protected function setUp(): void
    {
        parent::setUp();
        $this->manila = new DateTimeZone('Asia/Manila');
    }

    /** @param  list<string>  $events  each one VEVENT's lines, without BEGIN/END */
    public static function ics(array $events, string $name = 'Personal'): string
    {
        $lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Google Inc//Google Calendar 70.9054//EN', "X-WR-CALNAME:{$name}"];

        foreach ($events as $event) {
            $lines = [...$lines, 'BEGIN:VEVENT', ...explode("\n", trim($event)), 'END:VEVENT'];
        }

        return implode("\r\n", [...$lines, 'END:VCALENDAR'])."\r\n";
    }

    /** @return array{name: string|null, events: list<array<string, mixed>>, skipped: int} */
    private function read(string $body, string $from = '2026-09-07', string $to = '2026-09-22'): array
    {
        return (new IcsReader)->read(
            $body,
            $this->manila,
            new DateTimeImmutable($from, $this->manila),
            new DateTimeImmutable($to, $this->manila),
        );
    }

    private function titles(array $reading): array
    {
        return array_column($reading['events'], 'title');
    }

    public function test_a_utc_instant_comes_back_on_the_users_wall_clock(): void
    {
        $reading = $this->read(self::ics([<<<'ICS'
            UID:dentist@google.com
            DTSTART:20260910T070000Z
            DTEND:20260910T074500Z
            SUMMARY:Dentist
            LOCATION:Makati\, Metro Manila
            ICS]));

        // The one conversion in the calendar, and it happens here: 07:00 UTC is
        // three in the afternoon in Manila, written with no offset and no Z.
        $this->assertSame([
            'title' => 'Dentist',
            'starts_at' => '2026-09-10T15:00:00',
            'ends_at' => '2026-09-10T15:45:00',
            'all_day' => false,
            'location' => 'Makati, Metro Manila',
        ], $reading['events'][0]);
    }

    public function test_a_zoned_time_is_moved_onto_the_users_clock(): void
    {
        $reading = $this->read(self::ics([<<<'ICS'
            UID:standup@google.com
            DTSTART;TZID=America/New_York:20260911T090000
            DTEND;TZID=America/New_York:20260911T093000
            SUMMARY:New York standup
            ICS]));

        // 09:00 EDT is 13:00 UTC is 21:00 in Manila.
        $this->assertSame('2026-09-11T21:00:00', $reading['events'][0]['starts_at']);
        $this->assertSame('2026-09-11T21:30:00', $reading['events'][0]['ends_at']);
    }

    public function test_an_all_day_event_is_a_date_on_the_users_calendar_not_a_utc_midnight(): void
    {
        $reading = $this->read(self::ics([<<<'ICS'
            UID:birthday@google.com
            DTSTART;VALUE=DATE:20260912
            DTEND;VALUE=DATE:20260913
            SUMMARY:Birthday
            ICS]));

        // Midnight *here*, with iCalendar's exclusive end kept. Read as a UTC
        // midnight it would start at 08:00 and bleed into the day after.
        $this->assertSame([
            'title' => 'Birthday',
            'starts_at' => '2026-09-12T00:00:00',
            'ends_at' => '2026-09-13T00:00:00',
            'all_day' => true,
            'location' => null,
        ], $reading['events'][0]);
    }

    public function test_a_weekly_series_honours_its_exdate_and_its_moved_instance(): void
    {
        $reading = $this->read(self::ics([
            <<<'ICS'
            UID:legs@google.com
            DTSTART;TZID=Asia/Manila:20260831T180000
            DTEND;TZID=Asia/Manila:20260831T190000
            RRULE:FREQ=WEEKLY;BYDAY=MO
            EXDATE;TZID=Asia/Manila:20260914T180000
            SUMMARY:Leg day
            ICS,
            <<<'ICS'
            UID:legs@google.com
            RECURRENCE-ID;TZID=Asia/Manila:20260907T180000
            DTSTART;TZID=Asia/Manila:20260908T190000
            DTEND;TZID=Asia/Manila:20260908T200000
            SUMMARY:Leg day (moved)
            ICS,
        ]));

        // Monday the 7th moved to Tuesday evening, the 14th skipped, the 21st
        // as the rule says.
        $this->assertSame(
            ['2026-09-08T19:00:00', '2026-09-21T18:00:00'],
            array_column($reading['events'], 'starts_at'),
        );
        $this->assertSame(['Leg day (moved)', 'Leg day'], $this->titles($reading));
    }

    public function test_a_cancelled_event_is_not_on_the_calendar(): void
    {
        $reading = $this->read(self::ics([<<<'ICS'
            UID:lunch@google.com
            DTSTART:20260910T040000Z
            STATUS:CANCELLED
            SUMMARY:Lunch
            ICS]));

        $this->assertSame([], $reading['events']);
    }

    public function test_a_decade_old_daily_series_does_not_blank_the_calendar(): void
    {
        $this->assertSame(3500, Settings::$maxRecurrences, 'precondition: sabre\'s own cap');

        $reading = $this->read(self::ics([
            <<<'ICS'
            UID:vitamins@google.com
            DTSTART;VALUE=DATE:20100101
            RRULE:FREQ=DAILY
            SUMMARY:Vitamins
            ICS,
            <<<'ICS'
            UID:dentist@google.com
            DTSTART:20260910T070000Z
            SUMMARY:Dentist
            ICS,
        ]), '2026-09-10', '2026-09-11');

        // Sixteen years of instances is past sabre's 3,500, and its own
        // `expand()` throws for the whole calendar when any one series gets
        // there — so a daily reminder set up in 2010 would blank every event.
        $this->assertSame(['Vitamins', 'Dentist'], $this->titles($reading));
        $this->assertSame(0, $reading['skipped']);

        // And the cap is put back for anything else that uses the library.
        $this->assertSame(3500, Settings::$maxRecurrences);
    }

    public function test_a_series_too_long_to_expand_is_skipped_and_counted_not_fatal(): void
    {
        $reading = $this->read(self::ics([
            <<<'ICS'
            UID:minutely@google.com
            DTSTART:20000101T000000Z
            RRULE:FREQ=MINUTELY
            SUMMARY:Runaway
            ICS,
            <<<'ICS'
            UID:dentist@google.com
            DTSTART:20260910T070000Z
            SUMMARY:Dentist
            ICS,
        ]));

        $this->assertSame(['Dentist'], $this->titles($reading));
        $this->assertSame(1, $reading['skipped']);
    }

    public function test_the_window_is_by_overlap_so_a_trip_already_under_way_is_still_on(): void
    {
        $reading = $this->read(self::ics([
            <<<'ICS'
            UID:trip@google.com
            DTSTART;VALUE=DATE:20260905
            DTEND;VALUE=DATE:20260909
            SUMMARY:Siargao
            ICS,
            <<<'ICS'
            UID:gone@google.com
            DTSTART;VALUE=DATE:20260905
            DTEND;VALUE=DATE:20260907
            SUMMARY:Already over
            ICS,
        ]));

        // The window opens on the 7th. The trip runs to the 8th; the other ended
        // at midnight starting the 7th, which is exactly when the window opens.
        $this->assertSame(['Siargao'], $this->titles($reading));
    }

    public function test_one_off_events_outside_the_window_are_cut_before_parsing(): void
    {
        // Not observable in the output — that is the point, the cut must never
        // change it — so what is asserted is that events either side of the
        // window survive while a malformed one far outside it is never parsed.
        $reading = $this->read(self::ics([
            <<<'ICS'
            UID:ancient@google.com
            DTSTART:20150101T000000Z
            DTEND:NOT-A-DATE
            SUMMARY:Ancient
            ICS,
            <<<'ICS'
            UID:edge@google.com
            DTSTART:20260906T170000Z
            DTEND:20260906T180000Z
            SUMMARY:First thing on the 7th
            ICS,
        ]));

        // 17:00 UTC on the 6th is 01:00 on the 7th here — inside, and kept
        // because the cut compares dates with two days of slack.
        $this->assertSame(['First thing on the 7th'], $this->titles($reading));

        // Had the 2015 event reached the parser, its broken end would have been
        // counted as an event that could not be read.
        $this->assertSame(0, $reading['skipped']);
    }

    public function test_it_reads_the_calendars_name(): void
    {
        $this->assertSame('Work', $this->read(self::ics([], 'Work'))['name']);
    }

    public function test_something_that_is_not_a_calendar_is_refused(): void
    {
        $this->expectException(ParseException::class);

        $this->read('<!doctype html><title>Sign in</title>');
    }

    public function test_the_same_moment_sorts_all_day_first(): void
    {
        $reading = $this->read(self::ics([
            <<<'ICS'
            UID:early@google.com
            DTSTART;TZID=Asia/Manila:20260910T000000
            SUMMARY:A midnight call
            ICS,
            <<<'ICS'
            UID:holiday@google.com
            DTSTART;VALUE=DATE:20260910
            SUMMARY:Holiday
            ICS,
        ]));

        $this->assertSame(['Holiday', 'A midnight call'], $this->titles($reading));
    }
}
