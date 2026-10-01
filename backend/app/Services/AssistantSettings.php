<?php

namespace App\Services;

use App\Agent\AgentRunner;
use App\Agent\Support\SnapshotStore;
use App\Models\Setting;

/**
 * The assistant settings that live on the server: which models answer, how hard
 * they think, and how far one message may go.
 *
 * **Rows, not `localStorage`, for `AnthropicSwitch`'s reason.** Every one of
 * these is read by something with no browser: the chat loop runs on the queue
 * worker, the 07:00 nudge on the scheduler, and a spoken turn in a request the
 * ElevenLabs agent made. The unread dot and "open on a new chat" stay in the
 * browser because nothing else reads them.
 *
 * **`.env` is the default, not a second switch** — the rule `FitnessSettings`
 * keeps. `ANTHROPIC_AGENT_MODEL` and the rest answer until someone saves a
 * choice in Assistant → Settings, and from then on the row answers. A stored
 * value outside its closed set (a hand-edited row, a model since retired) falls
 * back the same way rather than failing a paid call.
 *
 * **Changing the chat model mid-thread is safe.** A thinking block signed by one
 * model was replayed to the other, in both directions, in the middle of a tool
 * loop, and the API accepted it (checked live for 13.1). What a change does cost
 * is the cached prompt prefix, once: the cache is per model.
 */
final class AssistantSettings
{
    public const CHAT_MODEL = 'assistant.chat_model';

    public const INSIGHT_MODEL = 'assistant.insight_model';

    public const EFFORT = 'assistant.effort';

    public const THINKING_DISPLAY = 'assistant.thinking_display';

    public const MAX_ITERATIONS = 'assistant.max_iterations';

    public const SNAPSHOT_REPLAY = 'assistant.snapshot_replay';

    public const MODELS = ['claude-sonnet-5', 'claude-opus-5'];

    public const EFFORTS = ['low', 'medium', 'high'];

    public const THINKING_DISPLAYS = ['summarized', 'omitted'];

    public const ITERATIONS = [6, 12, 20];

    /**
     * Never 0: the frame attached to the message being sent is one of the
     * frames replayed, so zero would send the question without its picture.
     */
    public const REPLAYS = [1, 3, 5];

    /** The tool loop, typed or spoken. */
    public static function chatModel(): string
    {
        return (string) self::oneOf(self::CHAT_MODEL, self::MODELS, config('services.anthropic.agent_model', 'claude-sonnet-5'));
    }

    /** The two unprompted writers: the weekly assessment and the morning nudge. */
    public static function insightModel(): string
    {
        return (string) self::oneOf(self::INSIGHT_MODEL, self::MODELS, config('services.anthropic.model', 'claude-opus-5'));
    }

    public static function effort(): string
    {
        return (string) self::oneOf(self::EFFORT, self::EFFORTS, config('services.anthropic.effort', 'high'));
    }

    public static function thinkingDisplay(): string
    {
        $display = self::oneOf(self::THINKING_DISPLAY, self::THINKING_DISPLAYS, config('services.anthropic.thinking_display'));

        return is_string($display) && $display !== '' ? $display : 'summarized';
    }

    public static function maxIterations(): int
    {
        return max(1, (int) self::oneOf(self::MAX_ITERATIONS, self::ITERATIONS, config('agent.max_iterations', AgentRunner::MAX_ITERATIONS)));
    }

    public static function snapshotReplay(): int
    {
        return max(0, (int) self::oneOf(self::SNAPSHOT_REPLAY, self::REPLAYS, config('agent.snapshots.replay', SnapshotStore::REPLAY)));
    }

    /** A stored member of `$set`, or the `.env` default. */
    private static function oneOf(string $key, array $set, mixed $default): mixed
    {
        $stored = Setting::value($key);

        return in_array($stored, $set, true) ? $stored : $default;
    }

    /**
     * Partial update: only the groups and keys given are written.
     *
     * @param  array{models?: array, reasoning?: array, limits?: array}  $data  already validated
     */
    public static function update(array $data): void
    {
        $keys = [
            'models' => ['chat' => self::CHAT_MODEL, 'insight' => self::INSIGHT_MODEL],
            'reasoning' => ['effort' => self::EFFORT, 'thinking_display' => self::THINKING_DISPLAY],
            'limits' => ['max_iterations' => self::MAX_ITERATIONS, 'snapshot_replay' => self::SNAPSHOT_REPLAY],
        ];

        foreach ($keys as $group => $fields) {
            foreach ($fields as $field => $key) {
                if (array_key_exists($field, $data[$group] ?? [])) {
                    $value = $data[$group][$field];
                    Setting::put($key, $value);
                }
            }
        }
    }

    /**
     * @return array{models: array{chat: string, insight: string}, reasoning: array{effort: string, thinking_display: string}, limits: array{max_iterations: int, snapshot_replay: int}, voice: array{configured: bool, agent_configured: bool, local_actions: bool}}
     */
    public static function state(): array
    {
        return [
            'models' => [
                'chat' => self::chatModel(),
                'insight' => self::insightModel(),
            ],
            'reasoning' => [
                'effort' => self::effort(),
                'thinking_display' => self::thinkingDisplay(),
            ],
            'limits' => [
                'max_iterations' => self::maxIterations(),
                'snapshot_replay' => self::snapshotReplay(),
            ],
            // Read-only, and never the key: whether each half is set, which is
            // what decides whether Talk can work.
            'voice' => [
                'configured' => filled(config('agent.voice.key')),
                'agent_configured' => filled(config('agent.voice.agent_id')),
                'local_actions' => (bool) config('agent.local.enabled'),
            ],
        ];
    }
}
