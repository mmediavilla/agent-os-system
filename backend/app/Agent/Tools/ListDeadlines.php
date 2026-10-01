<?php

namespace App\Agent\Tools;

use App\Agent\CapabilityGroup;
use App\Models\Deadline;
use App\Services\Calendar\CalendarService;
use Carbon\CarbonImmutable;
use Illuminate\Validation\Rule;

/**
 * The deadlines the owner is tracking, for the model.
 *
 * **Read-only**, like `list_events`: adding, completing and editing a deadline
 * are the Records overlay's. A write tool is a later decision, and the
 * description says so, so the model does not offer to set a reminder it has no
 * way to keep.
 *
 * **The arithmetic is done here.** Each row carries `days_until` from today on
 * the owner's clock, because a model counting days between two dates is a
 * model that will one day call a deadline tomorrow when it was yesterday —
 * `ProactiveTriggers`' rule that the numbers in the prose must be the server's.
 */
class ListDeadlines extends BaseTool
{
    private const DEFAULT_LIMIT = 25;

    public function __construct(private readonly CalendarService $calendar) {}

    public function name(): string
    {
        return 'list_deadlines';
    }

    public function group(): CapabilityGroup
    {
        return CapabilityGroup::Deadlines;
    }

    public function description(): string
    {
        return <<<'TEXT'
        The deadlines the user is tracking — dates they must act on: a visa to renew, a tax return
        to file, a premium to pay. Use it for "what's due", "when do I have to renew X" and "have
        I done Y yet", and before saying nothing is due.

        By default it returns open deadlines, overdue ones first, then soonest due. Each carries
        `days_until` from today on the user's clock — negative means overdue by that many days,
        0 means due today — so quote it rather than counting days yourself. A deadline about a
        filed document names it; search_documents has the rest of that record.

        Completed deadlines are kept, with the date they were done: ask for status "completed"
        to answer "when did I last renew this".

        Read-only. Nothing here can add, complete or change a deadline; that is done in the
        Records overlay, so say so rather than offering to. A calendar event is not a deadline —
        list_events is the calendar.
        TEXT;
    }

    public function inputSchema(): array
    {
        return $this->object([
            'status' => $this->string(
                'Which deadlines: "open" (the default), "completed", or "all".',
                Deadline::STATUSES,
            ),
            'within_days' => $this->integer(
                'Only open deadlines due within this many days from today, overdue ones included. '.
                'Omit for every open deadline however far off. Ignored for completed ones.'
            ),
            'search' => $this->string(
                'Case-insensitive substring, matched against the title, the kind and the notes.'
            ),
            'kind' => $this->string(
                'Exact kind, as spelled on the record. Free text rather than a fixed set — '.
                'commonly '.implode(', ', Deadline::KINDS).'.'
            ),
            'limit' => $this->limitProperty(self::DEFAULT_LIMIT),
        ]);
    }

    public function handle(array $input): array
    {
        $input = $this->validate($input, [
            'status' => ['nullable', Rule::in(Deadline::STATUSES)],
            'within_days' => ['nullable', 'integer', 'min:0'],
            'search' => ['nullable', 'string', 'max:255'],
            'kind' => ['nullable', 'string', 'max:40'],
            'limit' => ['nullable', 'integer'],
        ]);

        $limit = $this->limit($input, self::DEFAULT_LIMIT);
        $status = $input['status'] ?? 'open';
        $today = $this->calendar->today();

        // The same scopes and the same order as the Records overlay, so a tool
        // answer and the list on screen cannot disagree about what is next.
        $query = Deadline::with('document')
            ->status($status)
            ->searchText($input['search'] ?? null)
            ->applyFilters($input)
            ->inAgendaOrder();

        if (isset($input['within_days'])) {
            // A horizon on what is still to do. Completed rows are history and
            // have no horizon; overdue ones fall inside any horizon, because
            // they are the most pressing thing on the list.
            $horizon = $today->addDays((int) $input['within_days'])->toDateString();
            $query->where(fn ($q) => $q->whereNotNull('completed_at')->orWhere('due_on', '<=', $horizon));
        }

        $total = (clone $query)->count();

        // The rows first, as every list tool has them: the registry's limit
        // test reads the first key as the rows.
        return [
            'deadlines' => $query->limit($limit)->get()
                ->map(fn (Deadline $d) => $this->project($d, $today))
                ->all(),
            'total_matching' => $total,
            'today' => $today->toDateString(),
        ];
    }

    /** One row, fields projected explicitly and nulls left out. */
    private function project(Deadline $deadline, CarbonImmutable $today): array
    {
        $due = CarbonImmutable::createFromFormat('!Y-m-d', $deadline->due_on->toDateString(), $today->getTimezone());

        return array_filter([
            'id' => $deadline->id,
            'title' => $deadline->title,
            'kind' => $deadline->kind,
            'due_on' => $due->toDateString(),
            'days_until' => (int) round($today->diffInDays($due, false)),
            // The day it was done, on the owner's clock — an instant, unlike
            // `due_on`, so it is converted rather than read as it is stored.
            'completed_on' => $deadline->completed_at?->setTimezone($today->getTimezone())->toDateString(),
            'notes' => $deadline->notes,
            'document' => $deadline->document ? [
                'id' => $deadline->document->id,
                'title' => $deadline->document->title,
                'kind' => $deadline->document->kind,
            ] : null,
        ], fn ($v) => $v !== null);
    }
}
