<?php

namespace App\Http\Controllers;

use App\Services\Calendar\CalendarService;
use Carbon\CarbonImmutable;
use Closure;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * GET /api/calendar?from=&to=
 *
 * The user's calendars in one list, and how each feed is doing.
 *
 * Always 200, like the weather: no calendars, and a calendar whose provider
 * would not answer, are states of the panel rather than failures of the request.
 *
 * **Both bounds are required**, which is the rule the app's own table already
 * followed: the times are wall clock and this server is eight hours behind the
 * only person using it, so which day is "today" is the client's to say. They
 * are dates, and both are inclusive.
 */
class CalendarController extends Controller
{
    /** A calendar is a window you move; nothing here asks for a quarter at once. */
    public const MAX_DAYS = 92;

    public function __invoke(Request $request, CalendarService $calendar): JsonResponse
    {
        $data = $request->validate([
            'from' => ['required', 'date_format:Y-m-d'],
            'to' => ['required', 'date_format:Y-m-d', 'after_or_equal:from', $this->span($request)],
        ]);

        return response()->json($calendar->window($data['from'], $data['to']));
    }

    private function span(Request $request): Closure
    {
        return function (string $attribute, mixed $value, Closure $fail) use ($request): void {
            $from = CarbonImmutable::createFromFormat('Y-m-d', (string) $request->input('from'));
            $to = CarbonImmutable::createFromFormat('Y-m-d', (string) $value);

            if ($from && $to && $from->diffInDays($to) >= self::MAX_DAYS) {
                $fail('A calendar window can be at most '.self::MAX_DAYS.' days.');
            }
        };
    }
}
