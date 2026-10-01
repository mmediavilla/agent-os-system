<?php

namespace App\Http\Controllers;

use App\Services\AnthropicSwitch;
use App\Services\AssistantInstructions;
use App\Services\AssistantSettings;
use App\Services\Fitness\ProactiveTriggers;
use App\Services\FitnessSettings;
use App\Services\NewsSettings;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;

/**
 * The settings that live on the server rather than in a browser.
 *
 * They are here rather than beside the theme and the units because those are
 * *this browser's* preferences and these are the machine's: the proactive nudge
 * runs at 07:00 on a queue worker, and a setting it cannot see would let the app
 * go on doing what the screen said it had stopped.
 *
 * **The Anthropic switch is write-only, deliberately.** It has no read, because
 * `GET /api/health` already reports the switch and the shell already polls that
 * every fifteen seconds for the status pill. A second endpoint saying the same
 * thing would be a second poller, and two readings of one truth that disagree
 * for as long as their intervals are out of step — which is the specific
 * problem the shell solved by lifting the health poll into `App`.
 *
 * The response is the new state rather than 204, so the screen can draw the
 * answer immediately instead of waiting out the next poll.
 */
class SettingsController extends Controller
{
    /** POST /api/settings/anthropic */
    public function anthropic(Request $request): JsonResponse
    {
        $data = $request->validate([
            'enabled' => ['required', 'boolean'],
        ]);

        AnthropicSwitch::set((bool) $data['enabled']);

        return response()->json(AnthropicSwitch::state());
    }

    /**
     * GET /api/settings/fitness
     *
     * A read of its own, unlike the switch: nothing polls these, and Fitness →
     * Settings is the only screen that shows them.
     */
    public function fitness(): JsonResponse
    {
        return response()->json(FitnessSettings::state());
    }

    /** PATCH /api/settings/fitness — only what is sent is written; answers the whole state. */
    public function updateFitness(Request $request): JsonResponse
    {
        $data = $request->validate([
            'nudges' => ['required_without:calculations', 'array:enabled,time,triggers'],
            'nudges.enabled' => ['sometimes', 'boolean'],
            'nudges.time' => ['sometimes', 'string', 'regex:'.FitnessSettings::TIME_PATTERN],
            // Never `required`, which refuses an empty list: switching every
            // trigger off is a choice.
            'nudges.triggers' => ['sometimes', 'array'],
            'nudges.triggers.*' => ['string', 'distinct', Rule::in(ProactiveTriggers::KEYS)],
            'calculations' => ['required_without:nudges', 'array:e1rm_formula,week_start'],
            'calculations.e1rm_formula' => ['sometimes', 'string', Rule::in(FitnessSettings::E1RM_FORMULAS)],
            'calculations.week_start' => ['sometimes', 'string', Rule::in(FitnessSettings::WEEK_STARTS)],
        ], [
            'nudges.time.regex' => 'The time must be 24-hour HH:MM, like 07:00.',
        ]);

        FitnessSettings::updateNudges($data['nudges'] ?? []);
        FitnessSettings::updateCalculations($data['calculations'] ?? []);

        return response()->json(FitnessSettings::state());
    }

    /**
     * GET /api/settings/assistant
     *
     * Beside the switch rather than folded into it: the switch is on the
     * health poll already, and these are read only by Assistant → Settings.
     */
    public function assistant(): JsonResponse
    {
        return response()->json(AssistantSettings::state());
    }

    /**
     * PATCH /api/settings/assistant — any of models, reasoning and limits, each
     * partial; answers the whole state. `voice` is read-only, so it is ignored.
     */
    public function updateAssistant(Request $request): JsonResponse
    {
        $data = $request->validate([
            'models' => ['required_without_all:reasoning,limits', 'array:chat,insight'],
            'models.chat' => ['sometimes', 'string', Rule::in(AssistantSettings::MODELS)],
            'models.insight' => ['sometimes', 'string', Rule::in(AssistantSettings::MODELS)],
            'reasoning' => ['required_without_all:models,limits', 'array:effort,thinking_display'],
            'reasoning.effort' => ['sometimes', 'string', Rule::in(AssistantSettings::EFFORTS)],
            'reasoning.thinking_display' => ['sometimes', 'string', Rule::in(AssistantSettings::THINKING_DISPLAYS)],
            'limits' => ['required_without_all:models,reasoning', 'array:max_iterations,snapshot_replay'],
            // Strict, so "12" and 12.0 are refused rather than stored
            // as something `in_array(..., true)` will never match again.
            'limits.max_iterations' => ['sometimes', 'integer:strict', Rule::in(AssistantSettings::ITERATIONS)],
            'limits.snapshot_replay' => ['sometimes', 'integer:strict', Rule::in(AssistantSettings::REPLAYS)],
        ]);

        AssistantSettings::update($data);

        return response()->json(AssistantSettings::state());
    }

    /** GET /api/settings/instructions — read by Assistant → Instructions on arrival. */
    public function instructions(): JsonResponse
    {
        return response()->json(AssistantInstructions::state());
    }

    /**
     * PATCH /api/settings/instructions — any of the instructions by key, each a
     * rewording or null; answers the whole state.
     *
     * Blank and null both mean the default (a blank arrives as null anyway,
     * through ConvertEmptyStringsToNull), so neither is a 422. An unknown key is,
     * because it would otherwise be a write that silently did nothing.
     */
    public function updateInstructions(Request $request): JsonResponse
    {
        $keys = AssistantInstructions::keys();
        $max = AssistantInstructions::MAX_CHARS;

        $unknown = array_diff(array_keys($request->all()), $keys);
        if ($unknown !== [] || array_intersect(array_keys($request->all()), $keys) === []) {
            throw ValidationException::withMessages([
                'instructions' => 'Send at least one of '.implode(', ', $keys).', and nothing else.',
            ]);
        }

        $data = $request->validate(
            array_fill_keys($keys, ['sometimes', 'nullable', 'string', 'max:'.$max]),
            array_fill_keys(array_map(fn ($key) => "{$key}.max", $keys), "An instruction is at most {$max} characters."),
        );

        foreach ($data as $key => $text) {
            AssistantInstructions::reword($key, $text);
        }

        return response()->json(AssistantInstructions::state());
    }

    /** GET /api/settings/news — read by News → Interests on the HUD (19.4). */
    public function news(): JsonResponse
    {
        return response()->json(NewsSettings::state());
    }

    /**
     * PATCH /api/settings/news — the whole list, replaced; answers the state.
     *
     * An over-long entry or list is a 422, never cut, so what is saved is what
     * was typed. `present` rather than `required`, because an empty list is a
     * real answer: no interests.
     */
    public function updateNews(Request $request): JsonResponse
    {
        $data = $request->validate([
            'interests' => ['present', 'array', 'max:'.NewsSettings::max()],
            // Nullable because a blank line arrives as null (ConvertEmptyStringsToNull);
            // it is dropped when the list is cleaned, never a 422.
            'interests.*' => ['nullable', 'string', 'max:'.NewsSettings::MAX_CHARS],
        ], [
            'interests.max' => 'At most '.NewsSettings::max().' interests are kept.',
            'interests.*.max' => 'Each interest is a topic of at most '.NewsSettings::MAX_CHARS.' characters.',
        ]);

        NewsSettings::setInterests($data['interests']);

        return response()->json(NewsSettings::state());
    }
}
