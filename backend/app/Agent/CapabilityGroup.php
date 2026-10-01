<?php

namespace App\Agent;

use App\Agent\Contracts\Tool;

/**
 * The kinds of work a tool does, as a closed set.
 *
 * Every tool names one ({@see Tool::group()}), and an agent (Phase 17.1) will be
 * a row that owns some of them: switch it off and its groups' tools are not
 * offered at all, the way voice is read-only by not being handed the writes.
 * The set is closed because a group is a promise that PHP classes exist to back
 * it — an agent cannot own a capability nobody wrote, which is
 * `Automation::CONTEXT`'s rule.
 *
 * The declaration lives on each tool rather than in a map here, for
 * `MutatingTool`'s reason: a new tool cannot be added without saying which
 * group it joins, and a hand-kept list elsewhere is the copy nothing tests.
 *
 * The values are what agent rows will store, so they are append-only once 17.1
 * ships — renaming one strands every row that names it.
 */
enum CapabilityGroup: string
{
    /** The training log: workouts, the catalog, the stats, the weekly assessment. */
    case Fitness = 'fitness';

    /** The owner's calendars, read through their iCal addresses. */
    case Calendar = 'calendar';

    /** Filed documents — metadata only; the assistant never reads the bytes. */
    case Documents = 'documents';

    /**
     * Dates somebody must act on. Its own group rather than one `records` group
     * with documents: an agent that only chases dates is plausible, and a group
     * is cheaper to split before rows store it than after.
     */
    case Deadlines = 'deadlines';

    /** Opening things on this machine — already behind `LOCAL_ACTIONS_ENABLED` as well. */
    case Machine = 'machine';

    /**
     * What every answer leans on, and so what no agent may own: the weather,
     * and `save_facts`, which behind a toggle would silently break the
     * assistant's memory. Both already have switches of their own, and two
     * switches give "why is it quiet?" two answers.
     *
     * Re-checked when the news arrived as a third domain (19.1): `get_weather`
     * stays here. The training log and every morning greeting lean on it and
     * the news does not, so no one domain has a better claim to own it.
     */
    case Core = 'core';

    /**
     * The news: outlets' feeds, searches and the owner's interests (Phase 19).
     * After `core` only because the values are append-only.
     */
    case News = 'news';

    /** Whether an agent may own this group — and so whether switching one off can take it away. */
    public function ownable(): bool
    {
        return $this !== self::Core;
    }

    /**
     * What the group is called in a sentence — the prompt's off-sentence today,
     * and the Agents tab's checkboxes in 17.2, so the two cannot disagree.
     */
    public function label(): string
    {
        return match ($this) {
            self::Fitness => 'the training log',
            self::Calendar => 'the calendars',
            self::Documents => 'filed documents',
            self::Deadlines => 'deadlines',
            self::Machine => 'opening things on this machine',
            self::Core => 'the weather and the assistant\'s memory',
            self::News => 'the news',
        };
    }

    /**
     * The default rule for doing this kind of work, or null where none is needed.
     *
     * On the group, because what the model may do is what the tools let it do:
     * any agent that owns `documents` — seeded or made in Assistant → Agents —
     * starts out held to documents' rule, and its default follows its groups.
     * The owner may reword an agent's guardrail (`Agent::rewordGuardrail()`),
     * but a blank one comes back here rather than meaning none: a hat is not
     * expertise, and "never an advisor" must not vanish with a cleared field.
     *
     * One sentence per group, never one shared across several, so no group's
     * rule depends on which others it happens to be owned with. `machine` has
     * none — it is off by default and cannot open anything off its allow-list —
     * and `core` cannot be owned.
     */
    public function guardrail(): ?string
    {
        return match ($this) {
            self::Fitness => 'Judge training only from what the tools return, never from memory. You are not a physician: pain, injury, illness or medication is for a professional, and you say so.',
            self::Calendar => 'Say what the calendars hold, never what you expect them to: a day on a calendar that could not be read is unknown, not free. Events are made and moved in the calendar\'s own app, so never promise to change one.',
            self::Documents => 'An organiser, never an advisor: say what a filed record says, and when the answer needs the document itself, say it has to be opened. Legal, tax, insurance or immigration judgement about one is for a professional, and you say so.',
            self::Deadlines => 'A tracker, never an advisor: say what falls due when from the dates on file, never from what such a date usually is. Whether a tax, legal or immigration date, fee or penalty applies to the user is for a professional, and you say so.',
            self::News => 'Name the source for every item. Separate what was reported from speculation, and say when a story is more than a day old.',
            self::Machine, self::Core => null,
        };
    }

    /** @return list<self> every group an agent may own, in declaration order */
    public static function ownables(): array
    {
        return array_values(array_filter(self::cases(), fn (self $group) => $group->ownable()));
    }
}
