<?php

namespace App\Http\Controllers;

use App\Models\CalendarFeed;
use App\Services\Calendar\CalendarService;
use App\Services\Calendar\FeedAddress;
use Closure;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;

/**
 * The calendars Settings manages: add one by its iCal address — Google's secret
 * address, iCloud's public link, any provider's published feed — rename it,
 * recolour it, switch it off, remove it.
 *
 * **The address goes in and never comes out.** Not in the list, not in the
 * answer to the POST that stored it, not in an error. It is a bearer credential
 * for the whole calendar, so there is no screen that needs it back and no
 * endpoint that returns it; changing it is removing the calendar and adding it
 * again, which is also what a provider's "reset" or "stop sharing" asks of every
 * other client.
 */
class CalendarFeedController extends Controller
{
    public function __construct(
        private readonly CalendarService $calendar,
        private readonly FeedAddress $address,
    ) {}

    public function index(): JsonResponse
    {
        $feeds = CalendarFeed::query()->orderBy('id')->get();

        return response()->json(['data' => $feeds->map(fn (CalendarFeed $feed) => $this->calendar->present($feed))->all()]);
    }

    /**
     * POST /api/calendar/feeds { url, color? }
     *
     * Fetched once before anything is saved, so a mistyped address is a 422
     * on the form rather than a calendar that is unreachable forever — and so
     * the name can be read off the feed instead of typed.
     */
    public function store(Request $request): JsonResponse
    {
        $data = $request->validate([
            'url' => ['required', 'string', 'max:2048', $this->fetchable()],
            'color' => ['nullable', Rule::in(CalendarFeed::COLORS)],
        ]);

        $url = FeedAddress::normalize($data['url']);

        if (CalendarFeed::query()->where('url_hash', CalendarFeed::hash($url))->exists()) {
            throw ValidationException::withMessages(['url' => 'That calendar is already added.']);
        }

        $probe = $this->calendar->probe($url);

        if (! $probe['ok']) {
            throw ValidationException::withMessages(['url' => $probe['message']]);
        }

        $feed = CalendarFeed::create([
            'url' => $url,
            'name' => $probe['reading']['name'],
            'color' => $data['color'] ?? CalendarFeed::nextColor(),
        ]);

        $this->calendar->remember($feed, $probe['reading']);

        return response()->json($this->calendar->present($feed), 201);
    }

    /** PATCH /api/calendar/feeds/{feed} { name?, color?, enabled? } */
    public function update(Request $request, CalendarFeed $feed): JsonResponse
    {
        $data = $request->validate([
            'url' => ['prohibited'],
            'name' => ['sometimes', 'nullable', 'string', 'max:100'],
            'color' => ['sometimes', 'required', Rule::in(CalendarFeed::COLORS)],
            'enabled' => ['sometimes', 'required', 'boolean'],
        ], [
            'url.prohibited' => 'The address cannot be changed. Remove the calendar and add the new address.',
        ]);

        if (array_key_exists('name', $data)) {
            $data['name'] = trim((string) $data['name']) ?: null;
        }

        $feed->update($data);

        return response()->json($this->calendar->present($feed));
    }

    public function destroy(CalendarFeed $feed): JsonResponse
    {
        $this->calendar->forget($feed);
        $feed->delete();

        return response()->json(null, 204);
    }

    /**
     * Any iCal address that lands outside this machine's network.
     *
     * Checked here, before the duplicate lookup and the probe, so an address
     * pointing at `127.0.0.1` or a router is refused without the server ever
     * asking it anything. What "outside" means, and why it replaced a
     * Google-only rule, is {@see FeedAddress}'s.
     */
    private function fetchable(): Closure
    {
        return function (string $attribute, mixed $value, Closure $fail): void {
            $check = $this->address->check(FeedAddress::normalize((string) $value));

            if (! $check['ok']) {
                $fail($check['message']);
            }
        };
    }
}
