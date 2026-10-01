<?php

namespace App\Console\Commands;

use App\Agent\Support\Instructions;
use App\Agent\ToolRegistry;
use App\Services\AssistantSettings;
use App\Services\ClaudeService;
use App\Services\Facts\FactsBlock;
use Illuminate\Console\Command;
use Throwable;

/**
 * The premise test: does knowing the owner change the answers?
 *
 * One question, asked twice with the loop's own system prompt — once as it is,
 * once with the facts block cut off the end — and both answers printed. If they
 * do not differ in ways worth having, the epic stops at 15.0.
 *
 * **Two paid calls on the chat model, and no tools**: the point is the prompt,
 * and a tool round trip would add noise to both answers alike. It goes through
 * `ClaudeService`, so the Anthropic switch stops it like any other paid call.
 */
class FactsProbe extends Command
{
    protected $signature = 'facts:probe {question : Something the facts on file ought to change the answer to}';

    protected $description = 'Ask one question with and without the facts block (two paid model calls)';

    public function handle(ClaudeService $claude, ToolRegistry $tools): int
    {
        $with = Instructions::systemPrompt($tools);
        $block = FactsBlock::render();

        if ($block === '') {
            $this->error('No facts on file, so both answers would be the same. Add some with facts:add first.');

            return self::FAILURE;
        }

        // Cut rather than rebuilt: the block is the prompt's last section by
        // construction, so the two prompts differ by exactly it and nothing else.
        $without = substr($with, 0, -strlen($block));
        $question = (string) $this->argument('question');
        $model = AssistantSettings::chatModel();
        $maxTokens = (int) config('services.anthropic.agent_max_tokens', 8192);

        foreach (['Without facts' => $without, 'With facts' => $with] as $label => $prompt) {
            try {
                $result = $claude->complete($prompt, $question, $model, $maxTokens);
            } catch (Throwable $e) {
                $this->error("{$label}: {$e->getMessage()}");

                return self::FAILURE;
            }

            $this->newLine();
            $this->line("<options=bold>── {$label} ──</> ({$result['usage']['input_tokens']} in, {$result['usage']['output_tokens']} out)");
            $this->newLine();
            $this->line($result['text']);
        }

        $this->newLine();
        $this->comment("{$model}, two calls. The block was ".strlen($block).' bytes.');

        return self::SUCCESS;
    }
}
