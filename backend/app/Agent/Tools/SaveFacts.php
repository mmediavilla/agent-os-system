<?php

namespace App\Agent\Tools;

use App\Agent\CapabilityGroup;
use App\Agent\Contracts\MutatingTool;
use App\Models\Fact;
use App\Services\Facts\FactWriter;
use Illuminate\Support\Facades\DB;

/**
 * Put what the user has just said about themselves on file.
 *
 * **An array, so one message is one approval card.** "Remember I don't eat
 * pork and I take my coffee black" is two facts, and two cards for one sentence
 * would teach the owner to wave them through. The whole list is validated
 * before anything is written, and written in one transaction, so a bad third
 * item leaves the first two unsaved rather than half the sentence on file.
 *
 * **For what the user asks to be remembered, not everything they mention.** The
 * description says so; the extraction job (15.2) is what reads a whole
 * conversation for passing remarks, and it proposes rather than saves.
 *
 * Typed chat and MCP only: voice stays read-only, so a spoken fact reaches the
 * store through extraction. `conversation_id` is left null — a tool is handed
 * its arguments and nothing about the thread it was called from.
 */
class SaveFacts extends BaseTool implements MutatingTool
{
    /** More than a sentence's worth is a list the user did not ask to have saved. */
    public const MAX_FACTS = 10;

    public function __construct(private readonly FactWriter $writer) {}

    public function name(): string
    {
        return 'save_facts';
    }

    public function group(): CapabilityGroup
    {
        return CapabilityGroup::Core;
    }

    public function description(): string
    {
        return <<<'TEXT'
        Put lasting facts about the user on file, so they are in front of you in every later
        conversation, typed or spoken.

        Call it when the user asks you to remember something, or plainly states a lasting
        preference, habit or circumstance of theirs ("I don't eat pork", "I train at 6am on
        weekdays"). Not for passing remarks, moods or one-off plans — those are picked up
        separately and put to the user for review. Several facts from one message go in one
        call.

        Each fact is one subject (category and key) and one short claim about it. Saving a new
        claim for a subject already on file replaces the old one, which is kept as history;
        the result says what was replaced.
        TEXT;
    }

    public function inputSchema(): array
    {
        return $this->object([
            'facts' => $this->array(
                'The facts to save, at most '.self::MAX_FACTS.'.',
                $this->object([
                    'category' => $this->string(
                        'A broad area, lower case, reused across facts: e.g. "food", "work", '.
                        '"health", "family", "hobby", "training", "home".'
                    ),
                    'key' => $this->string(
                        'What the fact is about within that area, a word or two: e.g. "coffee", '.
                        '"pork", "employer", "wake time". The same key as an existing fact replaces it.'
                    ),
                    'value' => $this->string(
                        'The claim itself, one short sentence in plain words, e.g. "Black, no sugar." '.
                        'At most '.FactWriter::MAX_VALUE.' characters.'
                    ),
                    'confidence' => $this->string(
                        '"stated" when the user said it outright; "inferred" when it is your reading '.
                        'of what they said.',
                        Fact::CONFIDENCES,
                    ),
                ], ['category', 'key', 'value', 'confidence']),
            ),
        ], ['facts']);
    }

    public function handle(array $input): array
    {
        $data = $this->validate($input, [
            'facts' => ['required', 'array', 'min:1', 'max:'.self::MAX_FACTS],
            'facts.*' => ['required', 'array'],
            'facts.*.category' => ['required', 'string', 'max:60'],
            'facts.*.key' => ['required', 'string', 'max:120'],
            'facts.*.value' => ['required', 'string', 'max:'.FactWriter::MAX_VALUE],
            'facts.*.confidence' => ['required', 'in:'.implode(',', Fact::CONFIDENCES)],
        ]);

        $saved = DB::transaction(fn () => array_map(function (array $item) {
            $before = Fact::active()
                ->where('category', mb_strtolower(trim($item['category'])))
                ->where('key', mb_strtolower(trim($item['key'])))
                ->first();

            $fact = $this->writer->remember(
                $item['category'],
                $item['key'],
                $item['value'],
                $item['confidence'],
                'chat',
            );

            $unchanged = $before?->is($fact) ?? false;

            return [
                'id' => $fact->id,
                'category' => $fact->category,
                'key' => $fact->key,
                'value' => $fact->value,
                'outcome' => $unchanged ? 'already_on_file' : ($before ? 'replaced' : 'saved'),
                'replaced' => $unchanged ? null : $before?->value,
            ];
        }, $data['facts']));

        return ['facts' => $saved];
    }
}
