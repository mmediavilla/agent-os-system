<?php

namespace App\Services;

use App\Agent\Support\Instructions;
use App\Http\Controllers\InsightController;
use App\Jobs\GenerateProactiveInsights;
use App\Models\Setting;
use InvalidArgumentException;

/**
 * The instructions Claude is given that the owner may reword: who the assistant
 * is, what it is for, how a spoken answer sounds, and the two unprompted
 * writers' briefs.
 *
 * **Blank is the default, never "no instructions"** — the agents' guardrail
 * rule. The code keeps each default (`Instructions::PERSONA` and the rest), a
 * rewording is a `settings` row, and clearing the field or saving the default
 * word for word deletes the row, so an instruction the owner never actually
 * changed follows the code when the code changes.
 *
 * **Rows, for `AssistantSettings`' reason**: the loop runs on the worker, the
 * nudge on the scheduler and a spoken turn in a request the ElevenLabs agent
 * made — none with a browser. Read on every prompt, uncached, like every other
 * setting, so a rewording lands on the next turn.
 *
 * **What is not here, and why.** `Instructions::TOOLS` is sent verbatim to MCP
 * hosts and states facts about the data — kilograms, where the calendars come
 * from — that a rewording could only make false. The gate paragraph, the agents
 * paragraph and the facts block are derived from the registry and the tables, so
 * there is nothing to reword. The formatting and camera paragraphs describe what
 * the chat window and the camera actually do. Fact extraction's prompt is held
 * to a JSON schema its parser depends on.
 */
final class AssistantInstructions
{
    public const PERSONA = 'persona';

    public const SCOPE = 'scope';

    public const SPOKEN = 'spoken';

    public const ASSESSMENT = 'assessment';

    public const NUDGE = 'nudge';

    /**
     * Long enough for a persona several paragraphs deep, short enough that a
     * paste of the wrong thing is refused rather than re-sent on every turn.
     */
    public const MAX_CHARS = 4000;

    private const PREFIX = 'assistant.instructions.';

    /**
     * Every rewordable instruction, in the order the screen shows them: the
     * three that shape a conversation, then the two that write unprompted.
     *
     * @return array<string, array{label: string, used_by: string, default: string}>
     */
    public static function catalog(): array
    {
        return [
            self::PERSONA => [
                'label' => 'Persona',
                'used_by' => 'Leads every typed and spoken turn: who the assistant is and how it addresses you. Never sent to MCP hosts, which bring their own.',
                'default' => Instructions::PERSONA,
            ],
            self::SCOPE => [
                'label' => 'Scope',
                'used_by' => 'Follows the persona on every typed and spoken turn: what the assistant is for, and when it reaches for a tool.',
                'default' => Instructions::SCOPE,
            ],
            self::SPOKEN => [
                'label' => 'Spoken answers',
                'used_by' => 'Added to a spoken turn only, just before the tools: how an answer that will be read out loud should sound.',
                'default' => Instructions::SPOKEN,
            ],
            self::ASSESSMENT => [
                'label' => 'Weekly assessment',
                'used_by' => 'The whole brief for Fitness → Home\'s weekly assessment, on the insight model. The last 21 days of workouts follow it.',
                'default' => InsightController::PROMPT,
            ],
            self::NUDGE => [
                'label' => 'Morning nudge',
                'used_by' => 'The whole brief for the unprompted note at the nudge time, on the insight model. It is handed only the triggers that fired, already checked against the data.',
                'default' => GenerateProactiveInsights::PROMPT,
            ],
        ];
    }

    /** @return list<string> */
    public static function keys(): array
    {
        return array_keys(self::catalog());
    }

    /**
     * What Claude is told: the owner's wording, or the default.
     *
     * A stored value that is not a non-blank string (a hand-edited row) falls
     * back rather than sending an empty section.
     */
    public static function get(string $key): string
    {
        $default = self::defaultFor($key);
        $stored = Setting::value(self::PREFIX.$key);

        return is_string($stored) && trim($stored) !== '' ? $stored : $default;
    }

    public static function reworded(string $key): bool
    {
        self::defaultFor($key);
        $stored = Setting::value(self::PREFIX.$key);

        return is_string($stored) && trim($stored) !== '';
    }

    /**
     * Store a rewording, or go back to the default.
     *
     * Blank, null, or the default itself (line endings and outer whitespace
     * aside, since a textarea hands back `\r\n` on some platforms) deletes the
     * row — the default is never copied into the table.
     */
    public static function reword(string $key, ?string $text): void
    {
        $default = self::defaultFor($key);
        $text = trim(str_replace("\r\n", "\n", (string) $text));

        // Against both shapes of the default: the source's, and the unwrapped
        // one the screen shows — saving what the field was handed is not a
        // rewording.
        if ($text === '' || $text === trim($default) || self::unwrap($text) === self::unwrap($default)) {
            Setting::query()->whereKey(self::PREFIX.$key)->delete();

            return;
        }

        Setting::put(self::PREFIX.$key, $text);
    }

    /**
     * @return array{data: list<array{key: string, label: string, used_by: string, text: string, default: string, reworded: bool}>, max_chars: int}
     */
    public static function state(): array
    {
        $data = [];

        foreach (self::catalog() as $key => $entry) {
            $reworded = self::reworded($key);
            $default = self::unwrap($entry['default']);

            $data[] = [
                'key' => $key,
                'label' => $entry['label'],
                'used_by' => $entry['used_by'],
                'text' => $reworded ? self::get($key) : $default,
                'default' => $default,
                'reworded' => $reworded,
            ];
        }

        return ['data' => $data, 'max_chars' => self::MAX_CHARS];
    }

    /**
     * A default as the screen shows it: the source's hard wraps at ~90
     * columns joined back into paragraphs, since a field narrower than that
     * breaks every line twice. Blank lines and indented lines (the assessment's
     * bullets) are kept.
     *
     * Display only. An unchanged default is still sent to Claude exactly as
     * the constant holds it — {@see self::get()} never unwraps — so the prompt
     * of a machine nobody has reworded does not move by a byte.
     */
    public static function unwrap(string $text): string
    {
        return trim((string) preg_replace('/(?<=\S)\n(?=[^\s-])/u', ' ', str_replace("\r\n", "\n", $text)));
    }

    private static function defaultFor(string $key): string
    {
        $entry = self::catalog()[$key] ?? throw new InvalidArgumentException("No instruction named [{$key}].");

        return $entry['default'];
    }
}
