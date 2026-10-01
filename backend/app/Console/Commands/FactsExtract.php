<?php

namespace App\Console\Commands;

use App\Models\Conversation;
use App\Services\Facts\FactExtractor;
use Illuminate\Console\Command;
use Throwable;

/**
 * Read a conversation for facts now, without waiting for it to go quiet.
 *
 * One paid call when there is something unread; none when there is not. With
 * no argument it reads the most recent thread. It runs here, not on the queue,
 * so the proposals are printed — and it still goes through `ClaudeService`, so
 * the Anthropic switch stops it.
 */
class FactsExtract extends Command
{
    protected $signature = 'facts:extract {conversation? : A conversation id; the most recent one when left out}';

    protected $description = 'Read a conversation for facts about the owner now (one paid call)';

    public function handle(FactExtractor $extractor): int
    {
        $id = $this->argument('conversation');
        $conversation = $id !== null
            ? Conversation::find((int) $id)
            : Conversation::query()->orderByDesc('last_message_at')->orderByDesc('id')->first();

        if (! $conversation) {
            $this->error($id !== null ? "No conversation {$id}." : 'No conversations yet.');

            return self::FAILURE;
        }

        $from = $conversation->facts_extracted_through;

        try {
            $proposed = $extractor->extract($conversation);
        } catch (Throwable $e) {
            $this->error($e->getMessage());

            return self::FAILURE;
        }

        $this->line("Conversation {$conversation->id}, \"{$conversation->title}\", read from message ".($from ?? 'the start').'.');

        if ($proposed === []) {
            $this->line('Nothing new to propose.');

            return self::SUCCESS;
        }

        foreach ($proposed as $fact) {
            $this->line("Proposed: {$fact->category} / {$fact->key}: {$fact->value} ({$fact->confidence})");
        }

        $this->comment(count($proposed).' to review in Facts.');

        return self::SUCCESS;
    }
}
