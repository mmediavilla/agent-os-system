<?php

namespace App\Services\Diagnostics\Checks;

use App\Models\Setting;
use App\Services\AnthropicCredit;
use App\Services\AnthropicSwitch;
use App\Services\AssistantSettings;
use App\Services\Diagnostics\Finding;
use App\Services\Voice\VoiceCredits;
use Carbon\CarbonImmutable;

/**
 * The assistant is configured, and what it is set to is still valid.
 *
 * Configured, never reachable — the health endpoint's rule. Checking would be a
 * paid call, and a diagnosis has to work exactly when the key is missing or the
 * switch is off.
 */
class AssistantChecks extends Check
{
    public static function group(): string
    {
        return 'assistant';
    }

    public static function title(): string
    {
        return 'Assistant';
    }

    public function run(): array
    {
        return [
            $this->key(),
            $this->switch(),
            $this->credit(),
            $this->voice(),
            $this->voiceCredits(),
            $this->settings(),
        ];
    }

    private function key(): Finding
    {
        $title = 'Anthropic API key';

        if (AnthropicSwitch::configured()) {
            return $this->ok('key', $title, 'A key is set. Whether Anthropic accepts it is not checked, because checking costs a call.', ['ANTHROPIC_API_KEY: set']);
        }

        return $this->problem(
            'key',
            $title,
            'No key is set, so the chat, the nudge, fact extraction and voice all fail.',
            ['ANTHROPIC_API_KEY: not set'],
            manual: 'Set ANTHROPIC_API_KEY in backend/.env, then run php artisan config:clear.',
        );
    }

    /** Off is a decision, not a fault — `AnthropicSwitch`'s rule, which `ok` keeps. */
    private function switch(): Finding
    {
        $on = AnthropicSwitch::enabled();

        return $this->ok(
            'switch',
            'Anthropic switch',
            $on ? 'Switched on.' : 'Switched off in Assistant → Settings, so nothing spends money. That is a choice, not a fault.',
            ['switch: '.($on ? 'on' : 'off')],
        );
    }

    /**
     * Whether Anthropic last refused to bill. Not a balance — there is no API
     * for one — but the one thing a refused call proves, and it clears itself
     * on the next call that goes through ({@see AnthropicCredit}).
     */
    private function credit(): Finding
    {
        $title = 'Anthropic credit';
        $credit = AnthropicCredit::state();

        if (! $credit['exhausted']) {
            return $this->ok('credit', $title, 'No call has been refused for credit since the last one that went through. The balance itself cannot be read.', ['credit: no refusal']);
        }

        $since = CarbonImmutable::parse($credit['since'])->diffForHumans();

        return $this->problem(
            'credit',
            $title,
            "Anthropic has been refusing calls for lack of credit since {$since}, so the chat, the nudge, fact extraction and voice all fail.",
            ['credit: exhausted', 'since: '.$credit['since'], 'last refused: '.$credit['last_refused_at']],
            manual: 'Top up at console.anthropic.com/settings/billing. This clears on the next call that goes through.',
        );
    }

    /**
     * What is left of the ElevenLabs plan. A free read, cached ten minutes, so
     * it keeps the rule that no check spends anything.
     */
    private function voiceCredits(): Finding
    {
        $title = 'Voice credits';
        $credits = app(VoiceCredits::class)->read();

        if ($credits['state'] === 'unconfigured') {
            return $this->ok('voice_credits', $title, 'Voice is not set up, so there is no plan to read.', ['voice credits: not set up']);
        }

        if ($credits['state'] !== 'available') {
            return $this->warn('voice_credits', $title, (string) $credits['message'], ['voice credits: unavailable'], manual: 'Check the ElevenLabs key\'s permissions in their dashboard.');
        }

        $evidence = [
            'voice credits: '.number_format((int) $credits['remaining']).' of '.number_format((int) $credits['limit']).' left',
            'resets: '.($credits['resets_at'] ?? 'unknown'),
        ];

        if ($credits['remaining'] === 0) {
            return $this->problem('voice_credits', $title, 'The ElevenLabs plan is used up, so a call is cut as soon as it starts.', $evidence, manual: 'Top up in the ElevenLabs dashboard, or wait for the plan to reset.');
        }

        $ratio = $credits['limit'] > 0 ? $credits['remaining'] / $credits['limit'] : 0;

        if ($ratio < (float) config('agent.voice.credits_warn_ratio', 0.1)) {
            return $this->warn('voice_credits', $title, sprintf('Only %d%% of the ElevenLabs plan is left.', (int) floor($ratio * 100)), $evidence, manual: 'Top up in the ElevenLabs dashboard, or talk less until the plan resets.');
        }

        return $this->ok('voice_credits', $title, 'The ElevenLabs plan has credit left.', $evidence);
    }

    /**
     * Blank is supported — Talk says what to set. Half set is the fault: a key
     * with no agent, or an agent with no key, fails on the press.
     */
    private function voice(): Finding
    {
        $key = filled(config('agent.voice.key'));
        $agent = filled(config('agent.voice.agent_id'));
        $evidence = ['ELEVENLABS_API_KEY: '.($key ? 'set' : 'not set'), 'ELEVENLABS_AGENT_ID: '.($agent ? 'set' : 'not set')];
        $title = 'Voice';

        return match (true) {
            $key && $agent => $this->ok('voice', $title, 'Voice is set up.', $evidence),
            ! $key && ! $agent => $this->ok('voice', $title, 'Voice is not set up, which is supported: Talk says what to set.', $evidence),
            default => $this->warn('voice', $title, 'Voice is half set up, so pressing Talk fails.', $evidence, manual: 'Set both ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID in backend/.env (or neither), then run php artisan config:clear.'),
        };
    }

    /**
     * A stored choice outside its closed set is silently ignored for the `.env`
     * default. That is the safe way to fail, and also an invisible one.
     */
    private function settings(): Finding
    {
        $sets = [
            AssistantSettings::CHAT_MODEL => AssistantSettings::MODELS,
            AssistantSettings::INSIGHT_MODEL => AssistantSettings::MODELS,
            AssistantSettings::EFFORT => AssistantSettings::EFFORTS,
            AssistantSettings::THINKING_DISPLAY => AssistantSettings::THINKING_DISPLAYS,
            AssistantSettings::MAX_ITERATIONS => AssistantSettings::ITERATIONS,
            AssistantSettings::SNAPSHOT_REPLAY => AssistantSettings::REPLAYS,
        ];

        $ignored = [];

        foreach ($sets as $key => $set) {
            $stored = Setting::value($key);

            if ($stored !== null && ! in_array($stored, $set, true)) {
                $ignored[] = "{$key}: ".json_encode($stored).' (ignored)';
            }
        }

        $evidence = ['chat model: '.AssistantSettings::chatModel(), 'insight model: '.AssistantSettings::insightModel(), 'effort: '.AssistantSettings::effort()];

        if ($ignored !== []) {
            return $this->warn(
                'settings',
                'Assistant settings',
                'A saved setting is no longer a valid choice, so its default is used instead.',
                [...$ignored, ...$evidence],
                manual: 'Open Assistant → Settings and choose again.',
            );
        }

        return $this->ok('settings', 'Assistant settings', 'Every saved setting is a valid choice.', $evidence);
    }
}
