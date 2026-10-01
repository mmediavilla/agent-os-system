<?php

namespace App\Agent\Support;

use App\Models\AgentAction;
use App\Models\AgentRun;
use App\Models\AgentRunEvent;
use App\Models\Conversation;
use App\Models\ConversationMessage;
use App\Support\SignedUrl;

/**
 * What a client is shown, as against what the API is sent.
 *
 * The two are not the same list, which is why this exists rather than the
 * controllers handing back `toArray()`. A stored turn is shaped for replay: it
 * carries thinking blocks whose only job is to be handed back to the model
 * unaltered, and `Model::$appends` has a habit of shipping columns nobody asked
 * for. A client wants the prose, the calls, and the results.
 *
 * Thinking blocks are dropped here and only here — never from storage, where
 * removing one would break the next request that follows a tool call. That used
 * to cost nothing at all, because the model ran with `thinking.display =
 * omitted` and the blocks held a signature and no text. They now hold a
 * summary, and they are still dropped: reasoning is worth watching *as it
 * happens* — which is what the run event stream is for — and worth nothing on
 * the fifth re-read of a thread, where it is merely the largest thing in it.
 */
final class TranscriptPresenter
{
    /** Block types that exist for the model's benefit and have nothing to render. */
    private const HIDDEN_BLOCKS = ['thinking', 'redacted_thinking'];

    /** @return array<string, mixed> */
    public static function conversation(Conversation $conversation): array
    {
        return [
            'id' => $conversation->id,
            'title' => $conversation->title,
            'last_message_at' => optional($conversation->last_message_at)->toIso8601String(),
            'created_at' => optional($conversation->created_at)->toIso8601String(),
        ];
    }

    /** @return array<string, mixed> */
    public static function message(ConversationMessage $message): array
    {
        $content = is_array($message->content) ? $message->content : [];

        $visible = array_values(array_map(
            self::forDisplay(...),
            array_filter(
                $content,
                fn ($block) => ! (is_array($block) && in_array($block['type'] ?? null, self::HIDDEN_BLOCKS, true)),
            ),
        ));

        return [
            'id' => $message->id,
            'role' => $message->role,
            // Kept as blocks rather than flattened to a string: a turn can hold
            // prose and a tool call at once, and a client that wants to show
            // "…checking your last four weeks" needs to see both.
            'content' => $visible,
            'text' => MessageCodec::text($content),
            'stop_reason' => $message->stop_reason,
            'created_at' => optional($message->created_at)->toIso8601String(),
        ];
    }

    /**
     * One block, as a client wants it rather than as the API wants it.
     *
     * Only camera snapshots differ, and in the opposite direction from
     * {@see MessageCodec::transcript()}: the model is handed the bytes, and a
     * browser is handed a URL it can put in an `<img>` and cache. Shipping the
     * base64 both ways would mean re-downloading every picture in a thread on
     * every re-read, and the HUD re-reads the thread at the end of every run.
     *
     * @return array<string, mixed>|mixed
     */
    private static function forDisplay(mixed $block): mixed
    {
        $id = SnapshotStore::referencedId($block);

        if ($id === null) {
            return $block;
        }

        return [
            'type' => 'image',
            'snapshot_id' => $id,
            'media_type' => $block['source']['media_type'] ?? 'image/jpeg',
            // Served by the API for the same reason equipment photos are: no
            // `storage:link` to get wrong on a fresh checkout. Signed, because
            // an `<img>` cannot send the bearer token.
            'url' => SignedUrl::picture('agent.snapshots.show', ['snapshot' => $id]),
        ];
    }

    /** @return array<string, mixed> */
    public static function action(AgentAction $action): array
    {
        return [
            'id' => $action->id,
            'tool' => $action->tool,
            'input' => $action->input,
            'requires_confirmation' => $action->requires_confirmation,
            'status' => $action->status,
            'result' => $action->result,
            'is_error' => $action->is_error,
            'decided_at' => optional($action->decided_at)->toIso8601String(),
            'created_at' => optional($action->created_at)->toIso8601String(),
        ];
    }

    /**
     * One queued run, as the client watching it sees it.
     *
     * `finished` is spelled out rather than left to be derived from `status`,
     * because the client's only real question is "do I keep watching?" and it
     * should not have to hold a copy of the terminal-status list to answer it.
     *
     * @return array<string, mixed>
     */
    public static function run(AgentRun $run): array
    {
        return [
            'id' => $run->id,
            'conversation_id' => $run->conversation_id,
            'trigger' => $run->trigger,
            'status' => $run->status,
            'finished' => $run->isFinished(),
            'error' => $run->error,
            // Where to follow it over SSE. Signed, because `EventSource` cannot
            // send the bearer token; a client whose URL has expired polls.
            'stream_url' => SignedUrl::stream($run->id),
            'created_at' => optional($run->created_at)->toIso8601String(),
        ];
    }

    /** @return array<string, mixed> */
    public static function event(AgentRunEvent $event): array
    {
        return [
            'seq' => (int) $event->seq,
            'type' => $event->type,
            'data' => $event->data ?? [],
        ];
    }

    /**
     * @param  iterable<AgentRunEvent>  $events
     * @return list<array<string, mixed>>
     */
    public static function events(iterable $events): array
    {
        return array_values(array_map(self::event(...), is_array($events) ? $events : iterator_to_array($events)));
    }

    /**
     * @param  iterable<ConversationMessage>  $messages
     * @return list<array<string, mixed>>
     */
    public static function messages(iterable $messages): array
    {
        $visible = array_filter(
            is_array($messages) ? $messages : iterator_to_array($messages),
            fn (ConversationMessage $m) => ! self::isAutomationPrompt($m),
        );

        return array_values(array_map(self::message(...), $visible));
    }

    /**
     * An automation's assembled first turn (15.3) — built from the agenda, the
     * weather and the week's training, never something the owner typed. Left
     * out of the transcript the same way a thinking block is: the owner reads
     * the greeting it produced, not the prompt that asked for it.
     */
    private static function isAutomationPrompt(ConversationMessage $message): bool
    {
        return is_array($message->meta) && array_key_exists('automation_id', $message->meta);
    }

    /**
     * @param  iterable<AgentAction>  $actions
     * @return list<array<string, mixed>>
     */
    public static function actions(iterable $actions): array
    {
        return array_values(array_map(self::action(...), is_array($actions) ? $actions : iterator_to_array($actions)));
    }
}
