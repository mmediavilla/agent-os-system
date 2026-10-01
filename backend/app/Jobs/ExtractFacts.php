<?php

namespace App\Jobs;

use App\Models\Conversation;
use App\Services\AnthropicSwitch;
use App\Services\Facts\FactExtractor;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Support\Facades\Log;
use Throwable;

/**
 * One quiet conversation, read for facts. {@see FactExtractor} is the work;
 * this is the queue's handle on it.
 *
 * `tries = 1`, like the morning nudge: a retry re-pays for what is usually an
 * outage, and the watermark does not move on failure, so the claim's expiry
 * brings the thread round again within the hour.
 */
class ExtractFacts implements ShouldQueue
{
    use Queueable;

    public int $tries = 1;

    public function __construct(public readonly int $conversationId) {}

    public function handle(FactExtractor $extractor): void
    {
        // Switched off between the tick and the worker: nothing is read, the
        // watermark stays, and the claim runs out on its own.
        if (! AnthropicSwitch::enabled()) {
            return;
        }

        $conversation = Conversation::find($this->conversationId);

        if (! $conversation) {
            return;
        }

        try {
            $extractor->extract($conversation);
        } catch (Throwable $e) {
            // Logged, because a proposal that never arrives looks exactly like
            // a conversation with nothing in it.
            Log::warning('Fact extraction failed: '.$e->getMessage(), ['conversation_id' => $this->conversationId]);

            throw $e;
        }
    }
}
