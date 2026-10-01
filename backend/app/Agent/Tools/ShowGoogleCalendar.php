<?php

namespace App\Agent\Tools;

use App\Agent\CapabilityGroup;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Process;
use RuntimeException;

/**
 * Put Google Calendar on the screen, in a new tab of the default browser.
 *
 * **The one effect in this app that runs without an approval card**, and every
 * part of how it is wired is what makes that acceptable:
 *
 * - **Voice only.** It is not in `AgentServiceProvider::TOOLS`, so typed chat
 *   and `tools/list` over MCP never see it; it is appended to the spoken
 *   assistant's registry alone. That is not a preference about voice. The
 *   voice turn runs inside Herd's request, in the interactive desktop session,
 *   while the typed loop runs on the S4U queue worker, which has no desktop —
 *   an ungated opener there would open a page in a browser nobody can see, and
 *   a gated one would ask for approval in a place the spoken conversation never
 *   looks.
 * - **One address.** It opens `config('calendar.open.url')` and a view of it.
 *   The model chooses day, week or month and a date, both validated and both
 *   assembled into the path here, so it can never name a URL — the same
 *   closed-set shape as `open_on_this_machine`'s targets.
 * - **Only where this machine has opted in** to local actions at all, the same
 *   switch `open_on_this_machine` sits behind.
 *
 * What it opens is Google's page rather than any data of ours, and a tab is
 * closed with one click, so the cost of a wrong call is a stray tab — which is
 * the trade the owner chose over saying "approve this on screen" to a microphone.
 *
 * **A tab, not a window**, at the owner's instruction. It first opened a new window,
 * which meant naming the browser's executable (`--new-window` is a flag of the
 * program, not of the URL) and a setting to hold its path. A tab is what the
 * default browser does with an address on its own, so the launch is the same
 * `start` that `open_on_this_machine` uses and there is nothing to configure.
 *
 * **The tab comes to the front, and the call survives it.** Chrome gives
 * nothing outside it a way to open a tab behind the current one, so the HUD
 * goes hidden mid-turn — and the HUD ends a voice session when its tab is
 * hidden. `useAgentSession` therefore excuses a hide that lands while a spoken
 * question is in this loop, which is the only time this tool can run.
 */
class ShowGoogleCalendar extends BaseTool
{
    public const VIEWS = ['day', 'week', 'month'];

    /** Long enough for a cold `start`; the browser itself is detached and not waited on. */
    private const TIMEOUT_SECONDS = 15;

    /**
     * How long after opening a tab another call opens nothing.
     *
     * Ungated means nothing stands between a model repeating itself and a
     * row of identical tabs, and the iteration ceiling allows a dozen calls per
     * question. A person asking for a *different* week waits longer than this
     * between sentences.
     */
    private const DEBOUNCE_SECONDS = 5;

    private const DEBOUNCE_KEY = 'calendar.shown';

    /** Whether this machine lets the assistant open anything at all. */
    public static function available(): bool
    {
        return (bool) config('agent.local.enabled', false);
    }

    public function name(): string
    {
        return 'show_google_calendar';
    }

    public function group(): CapabilityGroup
    {
        return CapabilityGroup::Calendar;
    }

    public function description(): string
    {
        return <<<'TEXT'
        Open Google Calendar in a new browser tab on the user's computer, in front of them.
        Call it when they ask to see, show, open or pull up their calendar, their week or a day
        — "show me what my week looks like".

        It only opens the page; it reads nothing back. So call list_events as well and say
        what is on, rather than describing the page. Opening it needs no approval, and a
        second call within a few seconds opens nothing, so call it once.

        Pick the view that matches what was asked for, and a date inside the period when it is
        not the current one: "next week" is the week view with any date in next week.
        TEXT;
    }

    public function inputSchema(): array
    {
        return $this->object([
            'view' => $this->string('What to show: one day, a week, or a month. Default week.', self::VIEWS),
            'date' => $this->string('A day inside the period to show (YYYY-MM-DD). Omit for the current one.'),
        ]);
    }

    public function handle(array $input): array
    {
        $data = $this->validate($input, [
            'view' => ['nullable', 'in:'.implode(',', self::VIEWS)],
            'date' => ['nullable', 'date_format:Y-m-d'],
        ]);

        $view = $data['view'] ?? 'week';
        $url = self::url($view, $data['date'] ?? null);

        if (! Cache::add(self::DEBOUNCE_KEY, true, self::DEBOUNCE_SECONDS)) {
            return [
                'opened' => false,
                'reason' => 'Google Calendar was opened a moment ago and is already on screen.',
            ];
        }

        // The default browser's own "open this address", which lands as a new
        // tab in the window it already has.
        $result = Process::timeout(self::TIMEOUT_SECONDS)->run(OpenOnThisMachine::commandFor($url));

        if ($result->failed()) {
            // The tab never appeared, so another try must be allowed at once.
            Cache::forget(self::DEBOUNCE_KEY);

            throw new RuntimeException('Could not open Google Calendar: '.trim($result->errorOutput() ?: $result->output()));
        }

        return array_filter([
            'opened' => true,
            'view' => $view,
            'date' => $data['date'] ?? null,
        ], fn ($v) => $v !== null);
    }

    /**
     * The page for a view, assembled here from validated parts.
     *
     * Google's own path shape — `/r/week/2026/9/14`, unpadded — so the page
     * lands on the period asked about rather than on today.
     */
    public static function url(string $view, ?string $date = null): string
    {
        $base = rtrim((string) config('calendar.open.url'), '/')."/{$view}";

        if ($date === null) {
            return $base;
        }

        return $base.CarbonImmutable::createFromFormat('!Y-m-d', $date)->format('/Y/n/j');
    }
}
