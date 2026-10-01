<?php

namespace App\Services;

use App\Models\Setting;
use App\Services\Exceptions\AnthropicDisabled;

/**
 * The one switch that decides whether this app is allowed to spend money at
 * Anthropic.
 *
 * Three things in this app make paid calls — the weekly assessment, the chat
 * loop, and the proactive nudge that runs at 07:00 whether or not anyone is
 * awake — and until now the only way to stop any of them was to delete the API
 * key out of `.env`, which also takes the assistant's *configuration* down with
 * it and reads on the HUD as a broken machine rather than a deliberate quiet.
 *
 * **Off means off for the whole machine, not for this browser.** That is why
 * the state is a row rather than a `localStorage` flag beside the theme: the
 * scheduler has no browser, and a kill switch the scheduler cannot see is
 * decoration.
 *
 * **The gate is in `ClaudeService::client()`, and that is on purpose.** Every
 * paid call in the app — both the ones that exist and the ones that do not yet
 * — goes through that one method to get a client, so a path cannot be added
 * that quietly misses the switch. The entry points check it *as well*, but only
 * to fail early and cheaply: refusing a message before storing a turn and
 * queueing a doomed run is a better answer than a run that fails a second
 * later.
 *
 * **`/api/mcp` is deliberately not gated.** Those tools spend nothing of ours —
 * the host on the other end is paying for its own model, and this app is the
 * database it is reading. Switching our API usage off and finding that Claude
 * Code had stopped working would be a surprising reading of the words on the
 * toggle.
 *
 * The default is **on**, and it lives here rather than in `.env`: a second
 * layer of switch would make "why is the assistant quiet?" a question with two
 * answers in two places, which is exactly the confusion the toggle exists to
 * remove.
 */
final class AnthropicSwitch
{
    public const KEY = 'anthropic.enabled';

    /** What a fresh checkout does before anyone has an opinion. */
    public const DEFAULT = true;

    public static function enabled(): bool
    {
        return Setting::bool(self::KEY, self::DEFAULT);
    }

    /** @return bool the state after the write, so a caller can answer with it */
    public static function set(bool $enabled): bool
    {
        Setting::put(self::KEY, $enabled);

        return $enabled;
    }

    /** Whether there is a key to call with, which is a separate question. */
    public static function configured(): bool
    {
        return filled(config('services.anthropic.key'));
    }

    /**
     * Refuse here rather than at the API, before anything is spent or stored.
     *
     * @throws AnthropicDisabled
     */
    public static function guard(): void
    {
        if (! self::enabled()) {
            throw new AnthropicDisabled;
        }
    }

    /**
     * The switch as the HUD and the Settings screen read it.
     *
     * `off` is its own state beside `up` and `down` for the same reason
     * `unknown` is one on the heartbeats: a machine someone switched off and a
     * machine that is broken need different things done about them, and a
     * single boolean cannot say which this is. It is reported by
     * `GET /api/health` — the shell already polls that for the status pill, and
     * a settings endpoint of its own would be a second poller reading the same
     * truth fifteen seconds out of step with the first.
     *
     * `credit` rides along rather than becoming a fifth state: an empty account
     * is neither `down` (the key is fine) nor `off` (nobody chose it), and the
     * HUD names it on its own — {@see AnthropicCredit}.
     *
     * @return array{state: string, enabled: bool, configured: bool, model: string|null, credit: array{exhausted: bool, since: string|null, last_refused_at: string|null}}
     */
    public static function state(): array
    {
        $enabled = self::enabled();
        $configured = self::configured();

        return [
            'state' => match (true) {
                ! $enabled => 'off',
                ! $configured => 'down',
                default => 'up',
            },
            'enabled' => $enabled,
            'configured' => $configured,
            'model' => AssistantSettings::chatModel(),
            'credit' => AnthropicCredit::state(),
        ];
    }
}
