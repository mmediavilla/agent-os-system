<?php

namespace App\Services\Diagnostics\Checks;

use App\Models\CalendarFeed;
use App\Services\Calendar\CalendarService;
use App\Services\Calendar\FeedAddress;
use App\Services\Diagnostics\Finding;
use App\Services\Diagnostics\Format;
use App\Services\Diagnostics\SoftFix;
use Carbon\CarbonImmutable;
use Throwable;

/**
 * One finding per connected calendar: how its last read went, how old what it
 * shows is, and whether its address still lands somewhere this server may go.
 *
 * **It never fetches.** `present()` reads the cache, as Stats does; a fetch
 * here would be a diagnosis that changes what it is diagnosing. The address is
 * re-checked with `FeedAddress` — a DNS lookup, nothing sent to the host — and,
 * like every other path, no finding quotes it.
 */
class CalendarChecks extends Check
{
    public function __construct(
        private readonly CalendarService $calendars,
        private readonly FeedAddress $addresses,
    ) {}

    public static function group(): string
    {
        return 'calendar';
    }

    public static function title(): string
    {
        return 'Calendars';
    }

    public function run(): array
    {
        $feeds = CalendarFeed::query()->orderBy('id')->get();

        if ($feeds->isEmpty()) {
            return [$this->ok('feeds', 'Calendars', 'No calendar is connected.', ['connected: 0'])];
        }

        return $feeds->map(fn (CalendarFeed $feed) => $this->feed($feed))->values()->all();
    }

    private function feed(CalendarFeed $feed): Finding
    {
        $key = "feed_{$feed->id}";
        $title = "Calendar: {$feed->name}";
        $state = $this->calendars->present($feed);

        if (! $feed->enabled) {
            return $this->ok($key, $title, 'Switched off in Settings → Calendars, so it is not read.', ['enabled: no']);
        }

        // The address is encrypted with APP_KEY; a changed key makes every
        // stored address unreadable, which no amount of re-fetching fixes.
        try {
            $url = $feed->url;
        } catch (Throwable) {
            return $this->problem($key, $title, 'Its address can no longer be decrypted, which happens when APP_KEY changes.', ['address: unreadable'], manual: 'Remove the calendar in Settings → Calendars and paste its address again.');
        }

        $address = $this->addresses->check($url);

        if (! $address['ok']) {
            return $this->problem($key, $title, 'Its address is refused before any fetch: '.$address['message'], ['address: refused'], manual: 'Remove the calendar in Settings → Calendars and paste its address again.');
        }

        $fetched = $state['fetched_at'] ? CarbonImmutable::parse($state['fetched_at']) : null;
        $age = $fetched ? (int) now()->diffInSeconds($fetched, true) : null;

        $evidence = [
            "status: {$state['status']}",
            'events read: '.($age === null ? 'never' : Format::age($age).' ago'),
        ];
        if ($state['skipped'] > 0) {
            $evidence[] = "skipped events: {$state['skipped']}";
        }

        if ($state['status'] !== 'failed') {
            return $this->ok($key, $title, $state['status'] === 'pending' ? 'Not read yet; it is read the next time the agenda is.' : 'The last read worked.', $evidence);
        }

        $evidence[] = 'last error: '.$state['message'];
        $staleAfter = (int) config('diagnostics.calendar.stale_hours') * 3600;

        if ($age === null || $age > $staleAfter) {
            return $this->problem(
                $key,
                $title,
                $age === null
                    ? 'It has never been read successfully.'
                    : 'It has been failing for over '.config('diagnostics.calendar.stale_hours').' hours, so the agenda is showing events from '.Format::age($age).' ago. A reset secret address is the usual cause.',
                $evidence,
                manual: 'If the calendar\'s secret address was reset, remove it in Settings → Calendars and paste the new one.',
            );
        }

        return $this->warn($key, $title, 'The last read failed; the agenda is showing what it read before.', $evidence, fix: SoftFix::RefreshCalendarFeeds);
    }
}
