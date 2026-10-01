<?php

namespace App\Agent\Tools;

use App\Agent\CapabilityGroup;
use App\Http\Controllers\CalendarController;
use App\Services\Calendar\CalendarService;
use Carbon\CarbonImmutable;

/**
 * The user's calendars, for the model — Google, iCloud, whatever they connected.
 *
 * Same name and same slot in the registry as the tool it replaced, which read
 * the app's own `events` table: the definitions are the cached prompt prefix,
 * so a rename would move every tool after it. What changed is the source, and
 * with it the one thing the old description could promise that this one cannot
 * — that an empty result means an empty day. A feed can be unreachable, so the
 * result says which ones were, and the description says what that means.
 */
class ListEvents extends BaseTool
{
    private const DEFAULT_LIMIT = 25;

    /** Days read when the question names no period: today and the six after. */
    private const DEFAULT_DAYS = 7;

    public function __construct(private readonly CalendarService $calendar) {}

    public function name(): string
    {
        return 'list_events';
    }

    public function group(): CapabilityGroup
    {
        return CapabilityGroup::Calendar;
    }

    public function description(): string
    {
        return <<<'TEXT'
        What is on the user's calendars, soonest first, across every calendar they have connected
        — Google, iCloud or any other. Each event carries its calendar's name, its title, when it
        is — a start and an end for a timed event; `all_day: true` with a date, plus a last day if
        it runs longer, for an all-day one — and where, when the event says. All-day events are
        holidays, birthdays, trips and deadlines: include them whenever you say what a day holds.

        Calendars change while you talk, and a calendar can be connected mid-conversation. Call
        this again for every question about the calendar rather than answering from a result
        earlier in the conversation.

        Read-only. Nothing here can add, move or delete an event; that is done in the calendar's
        own app, so say so rather than offering to.

        Pass from/to whenever the question names a period: today, this week, "before I fly out".
        Both are dates and both are inclusive; with neither, it reads today and the six days
        after. Times are the user's local wall clock, already converted, so quote them exactly
        as they come.

        An empty list means a free stretch only when `unreachable` is absent. A calendar that
        could not be read is named there, and its last known events are still included — never
        report its days as free.
        TEXT;
    }

    public function inputSchema(): array
    {
        return $this->object([
            'from' => $this->string('The first day to read (YYYY-MM-DD). Defaults to today.'),
            'to' => $this->string('The last day to read (YYYY-MM-DD), inclusive. Defaults to six days after `from`. At most '.CalendarController::MAX_DAYS.' days after it.'),
            'limit' => $this->limitProperty(self::DEFAULT_LIMIT),
        ]);
    }

    public function handle(array $input): array
    {
        $input = $this->validate($input, [
            'from' => ['nullable', 'date_format:Y-m-d'],
            'to' => ['nullable', 'date_format:Y-m-d', 'after_or_equal:from'],
            'limit' => ['nullable', 'integer'],
        ]);

        // Every date on the user's clock, so none of the comparisons below is
        // quietly eight hours out.
        $zone = $this->calendar->zone();
        $from = isset($input['from'])
            ? CarbonImmutable::createFromFormat('!Y-m-d', $input['from'], $zone)
            : $this->calendar->today();
        $to = isset($input['to'])
            ? CarbonImmutable::createFromFormat('!Y-m-d', $input['to'], $zone)
            : $from->addDays(self::DEFAULT_DAYS - 1);

        // Clamped rather than refused: "everything until Christmas" is a fair
        // question, and the useful answer is the first quarter of it plus a
        // note saying where it stopped.
        $notes = [];
        if ($from->diffInDays($to) >= CalendarController::MAX_DAYS) {
            $to = $from->addDays(CalendarController::MAX_DAYS - 1);
            $notes[] = 'Only '.CalendarController::MAX_DAYS.' days are read at once; this stops at '.$to->toDateString().'. Ask again from the day after for the rest.';
        }

        $window = $this->calendar->window($from->toDateString(), $to->toDateString());

        if (! $window['configured']) {
            $notes[] = 'No calendars are connected. They are added in Settings, by pasting each calendar\'s iCal address.';
        }

        $horizon = $this->calendar->horizon();
        $lastRead = $horizon['to']->subDay();
        if ($from->toDateString() < $horizon['from']->toDateString() || $to->toDateString() > $lastRead->toDateString()) {
            $notes[] = 'Calendars are only read from '.$horizon['from']->toDateString().' to '.$lastRead->toDateString()
                .'. Days outside that are unknown here, not free.';
        }

        $names = [];
        $unreachable = [];
        foreach ($window['feeds'] as $feed) {
            $names[$feed['id']] = $feed['name'] ?? 'Untitled calendar';

            if ($feed['status'] === 'failed') {
                $unreachable[] = array_filter([
                    'calendar' => $names[$feed['id']],
                    'reason' => $feed['message'],
                    'last_read' => $feed['fetched_at'],
                ], fn ($v) => $v !== null);
            }

            if ($feed['skipped'] > 0) {
                $notes[] = "{$feed['skipped']} event(s) in {$names[$feed['id']]} could not be read, so it may be missing some — repeating ones especially.";
            }
        }

        $limit = $this->limit($input, self::DEFAULT_LIMIT);
        $events = array_slice($window['events'], 0, $limit);

        return array_filter([
            'events' => array_map(fn (array $e) => $this->project($e, $names[$e['calendar_id']] ?? null), $events),
            'returned' => count($events),
            // Counted before the limit, so "that is the whole week" and "those
            // are the first twenty-five of forty" can be told apart.
            'total_matching' => count($window['events']),
            'window' => ['from' => $window['from'], 'to' => $window['to']],
            'unreachable' => $unreachable ?: null,
            'notes' => $notes ?: null,
        ], fn ($v) => $v !== null);
    }

    /**
     * One event, the way a person would say it.
     *
     * An all-day event is given as dates rather than as a pair of midnights,
     * and its last day inclusively: iCalendar's exclusive end would have the
     * model saying a holiday on the 12th "ends on the 13th".
     *
     * @param  array{title: string, starts_at: string, ends_at: string|null, all_day: bool, location: string|null}  $event
     */
    private function project(array $event, ?string $calendar): array
    {
        if ($event['all_day']) {
            $date = substr($event['starts_at'], 0, 10);
            $last = $event['ends_at'] !== null
                ? CarbonImmutable::parse($event['ends_at'])->subDay()->toDateString()
                : $date;

            // Said outright rather than left to be inferred from a missing
            // time: "none of them are all-day events" is what a model says
            // when it has to work out what a bare date means.
            $when = ['all_day' => true, 'date' => $date, 'until' => $last !== $date ? $last : null];
        } else {
            $when = ['starts_at' => $event['starts_at'], 'ends_at' => $event['ends_at']];
        }

        // Absent rather than null: an empty end and location on every row is
        // noise re-sent on every later turn of the loop.
        return array_filter(
            ['calendar' => $calendar, 'title' => $event['title']] + $when + ['location' => $event['location']],
            fn ($v) => $v !== null,
        );
    }
}
