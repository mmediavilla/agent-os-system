<?php

namespace App\Services\Facts;

use App\Jobs\ExtractFacts;
use App\Models\Conversation;
use App\Models\ConversationMessage;
use App\Models\Fact;
use App\Services\AnthropicSwitch;
use App\Services\AssistantSettings;
use App\Services\ClaudeService;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\Cache;
use Illuminate\Validation\ValidationException;
use RuntimeException;

/**
 * Reads a finished conversation and puts up for review what it says about the
 * owner (15.2).
 *
 * **Finished means idle.** Nothing marks a conversation over, so one counts as
 * finished once nobody has written in it for {@see self::IDLE_MINUTES} and it
 * has messages past its watermark (`facts_extracted_through`). A thread picked
 * up again later is read from the watermark, so nothing is read twice.
 *
 * **It proposes, never saves.** Every row it writes is `proposed`, through
 * {@see FactWriter::propose()}, and reaches the prompt only once the owner keeps
 * it on the Facts screen. The same writer drops a proposal that repeats what is
 * on file or already waiting; a claim the owner has rejected is dropped here,
 * and the model is shown those refusals so it stops making them.
 *
 * **One paid call per conversation, on the chat model**, with thinking left on
 * and the answer held to a JSON schema (structured output) rather than a forced
 * tool call. The Anthropic switch stops it twice: the scheduler dispatches
 * nothing while it is off, and `ClaudeService::client()` refuses anyway.
 */
class FactExtractor
{
    /** How long a thread sits untouched before it counts as finished. */
    public const IDLE_MINUTES = 20;

    /**
     * At most this many threads are queued per tick. A normal minute has none
     * or one; the cap bounds what a bug in the due query could spend.
     */
    public const PER_TICK = 5;

    /** Proposals kept from one call — past this it is noise, not a person. */
    public const MAX_PROPOSALS = 10;

    /** Earlier messages sent along so a reply like "yes, black" has its question. */
    public const CONTEXT_MESSAGES = 6;

    /** The transcript sent is cut, oldest first, past this many characters. */
    public const MAX_CHARS = 40_000;

    /** Refusals shown to the model, newest first. */
    public const MAX_REJECTED = 100;

    /**
     * How long a queued extraction holds its thread. Long, because a failed
     * run leaves the watermark where it was and the claim is what spaces the
     * retries: an hour apart rather than once a minute.
     */
    public const CLAIM_SECONDS = 3600;

    public function __construct(
        private readonly ClaudeService $claude,
        private readonly FactWriter $writer,
    ) {}

    /**
     * Threads that have gone quiet with something unread in them.
     *
     * @return Collection<int, Conversation>
     */
    public static function due(?int $limit = null): Collection
    {
        return Conversation::query()
            ->where('last_message_at', '<=', now()->subMinutes(self::IDLE_MINUTES))
            ->whereExists(fn ($q) => $q->from('conversation_messages as m')
                ->whereColumn('m.conversation_id', 'conversations.id')
                ->whereRaw('m.id > coalesce(conversations.facts_extracted_through, 0)'))
            ->orderBy('last_message_at')
            ->when($limit, fn ($q) => $q->limit($limit))
            ->get();
    }

    /**
     * The scheduler's half: queue each due thread once. The claim is taken
     * with `Cache::add`, so a worker slower than the tick does not collect a
     * second job for the same thread.
     *
     * @return int how many were queued
     */
    public static function dispatchDue(): int
    {
        if (! AnthropicSwitch::enabled()) {
            return 0;
        }

        $queued = 0;

        foreach (self::due(self::PER_TICK) as $conversation) {
            if (Cache::add(self::claimKey($conversation->id), true, self::CLAIM_SECONDS)) {
                ExtractFacts::dispatch($conversation->id);
                $queued++;
            }
        }

        return $queued;
    }

    public static function claimKey(int $conversationId): string
    {
        return "facts:extract:{$conversationId}";
    }

    /**
     * Read what is new in one thread and propose what it says about the owner.
     *
     * The watermark moves only after the call has been answered and parsed. A
     * failure leaves it where it was, and the next idle check covers the same
     * ground.
     *
     * @return list<Fact> the proposals written
     */
    public function extract(Conversation $conversation): array
    {
        $new = $conversation->messages()
            ->where('id', '>', (int) $conversation->facts_extracted_through)
            ->get();

        if ($new->isEmpty()) {
            return [];
        }

        $through = (int) $new->last()->id;
        $unread = self::render($new);

        // Nothing the owner said — a thread of tool results, or a frame with no
        // words — is marked read without a call.
        if (! $new->contains(fn (ConversationMessage $m) => $m->role === ConversationMessage::USER && self::said($m) !== '')) {
            $this->markRead($conversation, $through);

            return [];
        }

        $earlier = $conversation->messages()
            ->where('id', '<=', (int) $conversation->facts_extracted_through)
            ->reorder('id', 'desc')
            ->limit(self::CONTEXT_MESSAGES)
            ->get()
            ->reverse();

        $result = $this->claude->complete(
            self::SYSTEM,
            $this->userMessage(self::render($earlier), $unread),
            AssistantSettings::chatModel(),
            (int) config('services.anthropic.agent_max_tokens', 8192),
            schema: self::schema(),
        );

        $proposed = $this->propose(self::parse($result['text']), $conversation->id);
        $this->markRead($conversation, $through);

        return $proposed;
    }

    private function markRead(Conversation $conversation, int $through): void
    {
        $conversation->forceFill(['facts_extracted_through' => $through])->saveQuietly();
        Cache::forget(self::claimKey($conversation->id));
    }

    /**
     * @param  list<array{category: string, key: string, value: string, confidence: string}>  $items
     * @return list<Fact>
     */
    private function propose(array $items, int $conversationId): array
    {
        $refused = Fact::query()
            ->where('status', Fact::REJECTED)
            ->get(['category', 'key', 'value'])
            ->map(fn (Fact $f) => self::signature($f->category, $f->key, $f->value))
            ->flip();

        $proposed = [];

        foreach (array_slice($items, 0, self::MAX_PROPOSALS) as $item) {
            if ($refused->has(self::signature($item['category'], $item['key'], $item['value']))) {
                continue;
            }

            try {
                $fact = $this->writer->propose(
                    $item['category'],
                    $item['key'],
                    $item['value'],
                    $item['confidence'],
                    'extracted',
                    $conversationId,
                );
            } catch (ValidationException) {
                // One malformed row (a value past 300 characters, say) costs
                // that row, not the rest of the call's proposals.
                continue;
            }

            if ($fact) {
                $proposed[] = $fact;
            }
        }

        return $proposed;
    }

    /** The comparison `FactWriter` makes: category and key trimmed and lower, the value case-blind. */
    private static function signature(string $category, string $key, string $value): string
    {
        $value = trim((string) preg_replace('/\s+/u', ' ', $value));

        return mb_strtolower(trim($category))."\0".mb_strtolower(trim($key))."\0".mb_strtolower($value);
    }

    /**
     * The model's answer as rows. The schema makes it JSON; anything that still
     * is not is an exception, so the watermark stays put.
     *
     * @return list<array{category: string, key: string, value: string, confidence: string}>
     */
    private static function parse(string $text): array
    {
        $data = json_decode($text, true);

        if (! is_array($data) || ! is_array($data['facts'] ?? null)) {
            throw new RuntimeException('Fact extraction did not answer in the expected shape.');
        }

        return array_values(array_filter($data['facts'], fn ($f) => is_array($f)
            && is_string($f['category'] ?? null)
            && is_string($f['key'] ?? null)
            && is_string($f['value'] ?? null)
            && in_array($f['confidence'] ?? null, Fact::CONFIDENCES, true)));
    }

    /**
     * Messages as plain lines: what each side said, and "[photo]" for a frame.
     * Tool calls, tool results and thinking are left out — they are the
     * assistant's working, not what anyone said. Cut oldest first past
     * {@see self::MAX_CHARS}.
     *
     * @param  iterable<ConversationMessage>  $messages
     */
    public static function render(iterable $messages): string
    {
        $lines = [];

        foreach ($messages as $message) {
            $said = self::said($message, photos: true);

            if ($said !== '') {
                $who = $message->role === ConversationMessage::USER ? 'User' : 'Assistant';
                $lines[] = "{$who}: {$said}";
            }
        }

        $text = implode("\n\n", $lines);

        if (mb_strlen($text) > self::MAX_CHARS) {
            $text = "[the start of this part is left out]\n\n".mb_substr($text, -self::MAX_CHARS);
        }

        return $text;
    }

    /**
     * One message's words, with a frame as "[photo]" when `$photos` — a frame
     * alone is not something the owner said, so it does not earn a call.
     */
    private static function said(ConversationMessage $message, bool $photos = false): string
    {
        $parts = [];

        foreach ($message->content ?? [] as $block) {
            $type = $block['type'] ?? null;

            if ($type === 'text' && trim((string) ($block['text'] ?? '')) !== '') {
                $parts[] = trim((string) $block['text']);
            } elseif ($type === 'image' && $photos) {
                $parts[] = '[photo]';
            }
        }

        return implode(' ', $parts);
    }

    private function userMessage(string $earlier, string $unread): string
    {
        $onFile = Fact::active()->orderBy('category')->orderBy('key')->get()
            ->map(fn (Fact $f) => "- {$f->category} / {$f->key}: {$f->value}")
            ->implode("\n");

        $refused = Fact::query()->where('status', Fact::REJECTED)
            ->latest('decided_at')->limit(self::MAX_REJECTED)->get()
            ->map(fn (Fact $f) => "- {$f->category} / {$f->key}: {$f->value}")
            ->implode("\n");

        $sections = ['Today is '.now(config('agent.timezone'))->toDateString().'.'];
        $sections[] = "Already on file:\n".($onFile !== '' ? $onFile : '(nothing yet)');

        if ($refused !== '') {
            $sections[] = "The user has refused these. Never propose them again, however they are worded:\n".$refused;
        }

        if ($earlier !== '') {
            $sections[] = "<earlier>\nAlready read. For context only — propose nothing from it.\n\n{$earlier}\n</earlier>";
        }

        $sections[] = "<conversation>\n{$unread}\n</conversation>";

        return implode("\n\n", $sections);
    }

    /** @return array<string, mixed> */
    private static function schema(): array
    {
        return [
            'type' => 'object',
            'properties' => [
                'facts' => [
                    'type' => 'array',
                    'items' => [
                        'type' => 'object',
                        'properties' => [
                            'category' => ['type' => 'string'],
                            'key' => ['type' => 'string'],
                            'value' => ['type' => 'string'],
                            'confidence' => ['type' => 'string', 'enum' => Fact::CONFIDENCES],
                        ],
                        'required' => ['category', 'key', 'value', 'confidence'],
                        'additionalProperties' => false,
                    ],
                ],
            ],
            'required' => ['facts'],
            'additionalProperties' => false,
        ];
    }

    public const SYSTEM = <<<'TEXT'
    You read a conversation between a user and their personal assistant, and pick out
    lasting facts about the user worth remembering in every later conversation. The user
    reviews each one before it is kept, so propose only what they would be glad to see on
    file.

    A lasting fact is a preference, habit, circumstance, relationship, goal or constraint
    that will still be true next month: "doesn't eat pork", "trains at 6am on weekdays",
    "works as a nurse", "sister is called Ana". Not moods, one-off plans, what they asked
    about, what the assistant said, or anything true only today. Most conversations
    contain none — an empty list is the usual answer, and the right one when in doubt.

    Take facts only from what the user said inside <conversation>. Mark one "stated" when
    they said it outright, "inferred" when it is your reading of what they said.

    Each fact is one subject and one short claim. category is a broad area, lower case,
    reusing the categories already on file where one fits ("food", "work", "health",
    "family", "hobby", "training", "home"). key is what the fact is about, a word or two;
    use the key already on file when the fact is about the same thing. value is the claim,
    one short sentence in plain words, at most 300 characters.

    Do not repeat what is already on file. If the user has changed something on file,
    propose the new value under the same category and key.
    TEXT;
}
