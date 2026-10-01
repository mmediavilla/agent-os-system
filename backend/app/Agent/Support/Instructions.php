<?php

namespace App\Agent\Support;

use App\Agent\Contracts\MutatingTool;
use App\Agent\ToolRegistry;
use App\Services\Agents\AgentScope;
use App\Services\AssistantInstructions;
use App\Services\Facts\FactsBlock;

/**
 * What the assistant is told about this toolset, in one place.
 *
 * There are two drivers — the MCP host and the custom loop — and they must say
 * the same thing about the same tools, or a claim like "kilograms everywhere"
 * gets fixed on one path and stays wrong on the other. MCP has a native slot for
 * it (`instructions` on `initialize`, prepended by the host to its own system
 * prompt); the loop has to build a system prompt of its own. So the shared half
 * is a constant and the loop wraps it.
 *
 * Nothing here describes an individual tool. That belongs in the tool's own
 * `description()`, which is what the model reads when it is choosing between
 * them; this is only for things true of the whole surface.
 *
 * **{@see self::PERSONA}, {@see self::SCOPE} and {@see self::SPOKEN} are
 * defaults.** The owner may reword each in Assistant → Instructions, and every
 * caller reads them through {@see AssistantInstructions}. {@see self::TOOLS} is
 * not among them: an MCP host is sent it verbatim, and it states facts about
 * the data (units, where the calendars come from) that a rewording could only
 * make false. The gate, the agents paragraph and the facts block are derived,
 * so there is nothing to reword.
 */
final class Instructions
{
    /**
     * The shared half: what the data is, which tool to reach for first, and what
     * the units are. Sent by both drivers, verbatim.
     */
    public const TOOLS = <<<'TEXT'
    ProjectMC is a single-user Life OS: a training log, the user's calendars, and the weather
    where they are. Its fitness data — every workout, set, exercise and piece of equipment —
    is reachable through these tools, and they are the only source of truth for it. Never
    answer a question about this training history from memory or from files on disk.

    Start any "how am I doing" question with get_fitness_stats. It returns volume, hard-set
    counts, estimated 1RMs, PRs and muscle-group balance already computed over the range
    asked for; re-deriving those from raw sets is slower, costs several more calls, and will
    disagree with what the app itself displays.

    Weights are kilograms, distances kilometres and lengths centimetres, everywhere, in both
    directions. RPE is 1-10.

    The user's calendars — Google, iCloud or any other — are read through the iCal addresses
    they have connected in this app's Settings. list_events is the only way to know what they
    have on, and it is read-only: adding, moving or deleting an event is done in the calendar's
    own app. An empty result means a free stretch only if no calendar is listed as unreachable.
    Event times are the user's local wall clock, already converted — quote them as they come,
    with no timezone, no offset and no conversion.

    get_weather is the forecast — now, hour by hour, and a week of days — for where the user
    is, or for any town they name. Never describe the weather, or say whether it is a good day
    to train outside, without calling it first.

    log_workout, update_workout, create_exercise, save_insight and save_facts write to the
    user's real database. update_workout replaces a session outright, so build its payload from a
    get_workout result rather than from memory — anything omitted is deleted.
    TEXT;

    /**
     * Who the assistant is when this app is the one doing the asking.
     *
     * It is a constant of its own rather than a paragraph inside
     * {@see self::systemPrompt()} because a persona is the one part of the
     * prompt the two drivers must *not* share, and keeping it beside
     * {@see self::TOOLS} is what makes that visible: `TOOLS` is sent verbatim by
     * both, this is sent by neither MCP nor anything else. A host arrives with a
     * voice of its own and prepends `instructions` to it, so putting a butler in
     * there would be this app telling Claude Code how to address its own user.
     *
     * The last line is doing real work. A model handed the word "butler" reaches
     * for the costume — "very good, sir", "at once, sir" — and a form of address
     * that arrives with a flourish every turn stops reading as courtesy and
     * starts reading as a bit. The composure is the point; the livery is not.
     */
    public const PERSONA = <<<'TEXT'
    You are a highly capable personal AI butler. Always address the user as "Sir". Be polite,
    respectful, composed, discreet, and efficient. Anticipate needs when useful, provide
    practical recommendations, and respectfully correct him when necessary. Be honest about
    your capabilities and never fabricate information or actions. Keep responses clear,
    concise, and professional. Avoid excessive formality, unnecessary apologies, or
    theatrical butler language.
    TEXT;

    /**
     * What the assistant is for, when this app is the one asking: everything,
     * with the tools for what only the tools can know.
     *
     * Without it the assistant took the toolset as the job description. Asked
     * about the weather before `get_weather` existed, it offered "your training
     * log, calendar events, or exercise records instead" — reading a list of
     * tools as a list of permitted subjects. The tools say where the user's own
     * data is; they were never meant to say what may be talked about.
     *
     * Loop-only, like {@see self::PERSONA}: an MCP host has a scope of its own,
     * and this app telling Claude Code what it may answer would be overreach in
     * the other direction.
     */
    public const SCOPE = <<<'TEXT'
    You are the user's general assistant, not only their training log. Answer anything that
    does not depend on their own data straight from your own knowledge — general questions,
    explanations, advice, arithmetic, drafting, planning — without apologising for it. Reach
    for a tool when the answer depends on something only a tool can see: their training,
    their calendars, the weather, or the news. For live information no tool here reaches —
    prices, scores, anything else recent — say plainly that you cannot look it up, then give
    what you know, marked as possibly out of date. Never present the tools' subjects as the
    only things you can help with.
    TEXT;

    /**
     * What is true of a turn that is going to be spoken out loud.
     *
     * Sent by the voice path and by nothing else, so it is a constant of its
     * own for the same reason {@see self::PERSONA} is: it is not shared, and a
     * paragraph buried inside {@see self::systemPrompt()} would be invisible to
     * the test that keeps the sharing straight.
     *
     * Two things it has to say, and neither is derivable from the tools. **The
     * answer is heard, not read** — so the formatting advice above it, which
     * assumes a chat window, is exactly wrong here: markdown arrives as spoken
     * punctuation, and a list read aloud is a list nobody can follow. And **a
     * spoken answer has no scrollback**: three sentences someone can hold in
     * their head beats a paragraph they will ask to have repeated.
     */
    public const SPOKEN = <<<'TEXT'
    This answer is going to be read out loud, so write it to be heard rather than read.
    Two or three short sentences of plain prose, no markdown of any kind, no lists and no
    headings. Round long numbers to something sayable, spell out what a figure means rather
    than reciting a table of them, and if the honest answer is long, give the headline and
    offer the detail rather than reading all of it.
    TEXT;

    /**
     * The loop's system prompt.
     *
     * Three things the MCP host supplies for itself and the custom loop has to
     * say out loud:
     *
     * - **Who is speaking.** A host has a persona already; this one now brings
     *   its own — {@see self::PERSONA}, and it leads, because everything under
     *   it is a rule about how to do the job rather than about who is doing it.
     *   {@see self::SCOPE} follows it: what the job is, before how to do it.
     * - **Today's date.** Every range in this data is relative ("last week",
     *   "since I started cutting") and a model with no clock resolves them
     *   against its training cutoff, silently and wrongly.
     * - **The confirmation gate.** A gated call does not land when the tool is
     *   chosen — it is proposed, and the user approves or declines it. A model
     *   that does not know that reports "logged it" for something still sitting
     *   in a queue, and treats a decline as a tool failure to be retried.
     *
     * The gated tools are read off the registry rather than written out here.
     * They used to be a hardcoded list of four, which was true right up until
     * there were five: a prompt that enumerates tools is a second copy of the
     * registry, and the copy is the one nothing tests. Naming them at all is
     * still worth it — "some of these" is vaguer than the model needs to be.
     *
     * **Which is why a registry with no writes in it changes that paragraph
     * rather than emptying it.** The voice path is handed
     * {@see ToolRegistry::readOnly()}, and the gate sentence built from an empty
     * list reads "  are proposed to the user" — grammar aside, it would be
     * describing a mechanism this caller does not have. The honest version is
     * the opposite statement: nothing here writes, so say so rather than
     * offering to do it later or reporting it done.
     *
     * `$addendum` is anything true of this caller and of no other — today, only
     * {@see self::SPOKEN}. It goes last, immediately before {@see self::TOOLS},
     * because everything above it is a standing rule and this is a fact about
     * the turn being taken right now.
     *
     * **What the assistant knows about the owner comes after all of it**
     * ({@see FactsBlock}), behind `TOOLS`: it is the one part that can change
     * between two turns of the same conversation, and MCP never sees it, because
     * a host is sent `TOOLS` alone and never this method.
     *
     * `$agents` is {@see AgentScope::instructions()} (17.1): the agents that are
     * on and their terms, and which are off and what that took away. It sits
     * **straight after the gate paragraph**, because both are standing rules
     * about what this caller may do, and both are derived rather than written
     * out — the gate from the registry, this from the rows that cut it. Passed
     * in rather than read here so that it comes from the same load as the
     * registry beside it.
     */
    public static function systemPrompt(ToolRegistry $tools, string $addendum = '', string $agents = ''): string
    {
        // On the user's clock, not the server's. `app.timezone` is UTC and the
        // owner of this machine is eight hours ahead of it, so `now()` here
        // spends the first eight hours of every morning insisting it is
        // yesterday — which a model then resolves "tomorrow" against when it
        // reads the calendar.
        $today = now()->timezone(config('agent.timezone'))->toDateString();

        $gated = collect($tools->all())
            ->filter(fn ($tool) => $tool instanceof MutatingTool)
            ->keys()
            ->join(', ', ' and ');

        $gate = $gated === ''
            ? <<<'TEXT'
            Every tool you have here reads; not one of them writes. So if you are asked to log,
            change, add or delete anything, say plainly that it has to be typed into the app —
            do not say it is done, do not offer to do it in a moment, and do not try to call a
            writing tool, because you have not been given one.
            TEXT
            : <<<TEXT
            Some of these tools do not take effect when you call them. {$gated} are proposed to the
            user, who approves or declines each one before anything happens. So do not report a
            change as done until you see its result, and if a call comes back saying the user
            declined it, that is an answer and not a failure — acknowledge it and move on rather
            than trying again with the same arguments.
            TEXT;

        // The owner's wording when there is one, else the constants below —
        // read per prompt, so a rewording lands on the next turn without a
        // worker restart.
        $persona = AssistantInstructions::get(AssistantInstructions::PERSONA);
        $scope = AssistantInstructions::get(AssistantInstructions::SCOPE);

        // Blank unless this caller has something of its own to say, and the
        // blank line goes with it — an empty addendum must not leave a gap that
        // reads as a missing paragraph.
        $extra = $addendum === '' ? '' : "\n{$addendum}\n";

        // The same rule for the agents paragraph: absent, it leaves exactly the
        // one blank line that was always there.
        $roster = $agents === '' ? '' : "\n{$agents}\n";

        return <<<TEXT
        {$persona}

        {$scope}

        Write in plain prose. The chat window renders bold and inline code and nothing else, so
        headers, tables, links and block quotes arrive as their own punctuation. Short numbered
        or dashed lists are fine — they are read as the lines they are.

        Today is {$today}. Resolve every relative date against it.

        {$gate}
        {$roster}
        A turn may carry a photograph taken with the camera on this machine. Answer from what
        is actually in it: a picture of a loaded barbell is not a record that the set was
        performed, so do not write anything to the database off a photograph unless you are
        asked to. If a turn says a snapshot "is no longer being sent", an older picture has
        been dropped from this conversation to keep it affordable — ask for a fresh one rather
        than guessing what it showed.
        {$extra}
        TEXT.self::TOOLS.FactsBlock::render();
    }
}
