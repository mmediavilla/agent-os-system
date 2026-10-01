<?php

namespace App\Services\Automations;

use App\Agent\Streaming\RunDispatcher;
use App\Agent\ToolRegistry;
use App\Models\AgentRun;
use App\Models\Automation;
use App\Models\Conversation;
use App\Models\ConversationMessage;
use App\Services\AnthropicSwitch;
use App\Services\NewsSettings;
use Throwable;

/**
 * Turns one due automation into a conversation, and records what happened.
 *
 * **The prompt is assembled, never stored.** The intent plus whichever context
 * pieces the row names — today's agenda, the current weather, the week's
 * training — are fetched now, through the same tools the model itself would
 * call, and joined into one plain-text first turn. Facts need no fetch: they
 * are already in the system prompt on every turn.
 *
 * **That turn is a real `user` message**, stamped `meta.automation_id` so
 * `TranscriptPresenter` can leave it out of the transcript the owner reads —
 * it is scaffolding, not something anyone typed — while `MessageCodec` still
 * sends it to the model exactly as any other turn. From there it is an
 * ordinary queued run: {@see RunDispatcher::queue()}, the same job, the same
 * confirmation gate for anything the model proposes.
 *
 * **The switch is checked first**, and being off is recorded as `skipped`,
 * never `failed` — a decision is not a fault. Anything else that goes wrong
 * while assembling or storing the turn is `failed`, with the exception's
 * message kept so the Automations overlay can show why.
 */
class AutomationRunner
{
    /**
     * How far ahead a greeting looks for deadlines. Two weeks is long enough to
     * act on a renewal and short enough that a date a year off is not read out
     * every morning — a greeting that recites the whole list is one the owner
     * stops listening to. Overdue ones are always included.
     */
    public const DEADLINE_HORIZON_DAYS = 14;

    public function __construct(private readonly ToolRegistry $tools) {}

    public function run(Automation $automation): void
    {
        if (! AnthropicSwitch::enabled()) {
            $automation->forceFill([
                'last_run_at' => now(),
                'last_outcome' => Automation::SKIPPED,
                'last_error' => null,
            ])->save();

            return;
        }

        try {
            // Assembled before anything is created, so a failed fetch leaves no
            // orphan conversation behind — only the outcome below.
            $text = $this->assemble($automation);

            $conversation = Conversation::create(['title' => $automation->name]);

            $message = $conversation->messages()->create([
                'role' => ConversationMessage::USER,
                'content' => [['type' => 'text', 'text' => $text]],
                'meta' => ['automation_id' => $automation->id],
            ]);

            $conversation->forceFill(['last_message_at' => $message->created_at])->save();

            RunDispatcher::queue($conversation, AgentRun::TRIGGER_AUTOMATION);

            $automation->forceFill([
                'last_run_at' => now(),
                'last_outcome' => Automation::OK,
                'last_error' => null,
                'last_conversation_id' => $conversation->id,
            ])->save();
        } catch (Throwable $e) {
            $automation->forceFill([
                'last_run_at' => now(),
                'last_outcome' => Automation::FAILED,
                'last_error' => $e->getMessage(),
            ])->save();

            throw $e;
        }
    }

    /**
     * The intent, plus a fetch per context piece the row asked for — the same
     * tools the model has, called directly rather than through a turn, so the
     * greeting starts from numbers that are already true rather than a promise
     * to go look them up.
     */
    private function assemble(Automation $automation): string
    {
        $context = is_array($automation->context) ? $automation->context : [];
        $zone = config('agent.timezone');

        $sections = [trim($automation->intent)];

        // Named outright rather than left for the model to infer from the
        // system prompt's date alone — a first load at 15:00 needs to write an
        // afternoon greeting, not "good morning", and only the current time
        // says which.
        $sections[] = 'The current time is '.now($zone)->format('l, H:i').'.';

        if (in_array('agenda', $context, true)) {
            $today = now($zone)->toDateString();
            $sections[] = "Today's agenda:\n".$this->tools->attempt('list_events', ['from' => $today, 'to' => $today])['text'];
        }

        if (in_array('weather', $context, true)) {
            $sections[] = "The weather:\n".$this->tools->attempt('get_weather', [])['text'];
        }

        if (in_array('training', $context, true)) {
            $sections[] = "This week's training:\n".$this->tools->attempt('get_fitness_stats', ['range' => '4w'])['text'];
        }

        if (in_array('deadlines', $context, true)) {
            $sections[] = 'What is due in the next '.self::DEADLINE_HORIZON_DAYS." days, and anything overdue:\n"
                .$this->tools->attempt('list_deadlines', ['within_days' => self::DEADLINE_HORIZON_DAYS])['text'];
        }

        // Through `get_news` itself, so what the greeting hands over is marked
        // seen like any briefing, and a "what's the news?" later that morning
        // flags those stories as already told. Interests only when there are
        // any: without them `get_news` answers with a sentence pointing the
        // owner at a setting, which is not a greeting.
        if (in_array('news', $context, true)) {
            $sections[] = "The local news:\n".$this->tools->attempt('get_news', ['beat' => 'local'])['text'];

            if (NewsSettings::interests() !== []) {
                $sections[] = "News on the user's interests:\n".$this->tools->attempt('get_news', ['beat' => 'interests'])['text'];
            }
        }

        return implode("\n\n", $sections);
    }
}
