<?php

namespace App\Services\Diagnostics\Fixes;

use App\Models\CalendarFeed;
use App\Services\Calendar\CalendarService;
use App\Services\Diagnostics\SoftFix;

/**
 * Read the failing calendars again, now.
 *
 * Forgetting a failure alone would make the report written straight after this
 * call the calendar fine — `present()` falls back to the last good reading when
 * there is no attempt — without anything having been asked. So the fix forgets
 * each failing feed's attempt and then reads, which fetches exactly those
 * feeds, and the checks after it judge a real answer. Only the cache is
 * touched; an address is never read out, changed or re-pasted.
 */
class RefreshCalendarFeeds extends Fix
{
    public function __construct(private readonly CalendarService $calendars) {}

    public static function fix(): SoftFix
    {
        return SoftFix::RefreshCalendarFeeds;
    }

    public function run(): string
    {
        $failing = CalendarFeed::query()
            ->where('enabled', true)
            ->orderBy('id')
            ->get()
            ->filter(fn (CalendarFeed $feed) => $this->calendars->present($feed)['status'] === 'failed')
            ->values();

        if ($failing->isEmpty()) {
            return 'No calendar was failing by the time this ran.';
        }

        $failing->each(fn (CalendarFeed $feed) => $this->calendars->retry($feed));

        $today = $this->calendars->today()->format('Y-m-d');
        $this->calendars->window($today, $today);

        $still = $failing->filter(fn (CalendarFeed $feed) => $this->calendars->present($feed)['status'] === 'failed')->count();
        $read = $failing->count();
        $answered = $read - $still;

        return match (true) {
            $still === 0 => $read === 1 ? 'Read the failing calendar again, and it answered.' : "Read the {$read} failing calendars again, and each answered.",
            $answered === 0 => $read === 1 ? 'Read the failing calendar again; it is still failing.' : "Read the {$read} failing calendars again; all are still failing.",
            default => "Read the {$read} failing calendars again: {$answered} answered, {$still} still failing.",
        };
    }
}
