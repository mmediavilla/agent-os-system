<?php

namespace App\Agent\Tools;

use App\Agent\CapabilityGroup;
use App\Agent\Contracts\MutatingTool;
use App\Models\Insight;

class SaveInsight extends BaseTool implements MutatingTool
{
    /** Life OS areas an insight can belong to. Only fitness has a screen so far. */
    public const DOMAINS = ['fitness', 'travel', 'budget', 'habits'];

    public function name(): string
    {
        return 'save_insight';
    }

    public function group(): CapabilityGroup
    {
        return CapabilityGroup::Fitness;
    }

    public function description(): string
    {
        return <<<'TEXT'
        Save an analysis so it appears on the user's Insights screen and survives this
        conversation.

        Chat answers are read once and lost. This is for the ones worth keeping — a programme
        review, a diagnosis of why a lift stalled, a plan for the next block. Offer it when an
        answer took real analysis to produce, rather than saving every reply.

        Write the response as the finished, standalone piece: the user will read it later with
        none of this conversation around it, so it has to carry its own numbers and context.
        TEXT;
    }

    public function inputSchema(): array
    {
        return $this->object([
            'domain' => $this->string('Which area of the Life OS this belongs to.', self::DOMAINS),
            'kind' => $this->string(
                'A short snake_case label for what sort of analysis this is, e.g. '.
                '"weekly_assessment", "plateau_review", "programme_plan". Reused across insights '.
                'of the same sort, so they can be listed together.'
            ),
            'title' => $this->string('One short line naming the insight, shown in the list.'),
            'response' => $this->string(
                'The insight itself, in full. Plain text — the screen renders no markdown. '.
                'Written to stand alone, without the conversation that produced it.'
            ),
        ], ['domain', 'kind', 'title', 'response']);
    }

    public function handle(array $input): array
    {
        $data = $this->validate($input, [
            'domain' => ['required', 'string', 'in:'.implode(',', self::DOMAINS)],
            'kind' => ['required', 'string', 'max:100'],
            'title' => ['required', 'string', 'max:255'],
            'response' => ['required', 'string'],
        ]);

        // No `usage` or `model`: those columns describe the single API call that
        // produced a weekly assessment, and an insight written mid-conversation
        // has no one call behind it to attribute. The agent's own accounting
        // lives with the conversation (Phase 3), not here.
        $insight = Insight::create($data);

        return [
            'id' => $insight->id,
            'domain' => $insight->domain,
            'title' => $insight->title,
            'saved' => true,
        ];
    }
}
