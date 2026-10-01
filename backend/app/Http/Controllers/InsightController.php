<?php

namespace App\Http\Controllers;

use App\Agent\Support\WorkoutTranscript;
use App\Models\Insight;
use App\Models\Workout;
use App\Services\AnthropicSwitch;
use App\Services\AssistantInstructions;
use App\Services\ClaudeService;
use App\Services\Exceptions\AnthropicDisabled;
use App\Services\Exceptions\AnthropicOutOfCredit;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Throwable;

class InsightController extends Controller
{
    /**
     * The weekly assessment's system prompt — the default. Assistant →
     * Instructions may reword it ({@see AssistantInstructions}), so read it
     * through there, never from here.
     */
    public const PROMPT = <<<'PROMPT'
    You are a personal fitness coach reviewing a user's training log. Be specific,
    concise, and grounded in the actual data — reference real exercises and numbers.
    Avoid generic advice. Format your response as:

      - "What's working" (1–2 bullets)
      - "What to adjust" (1–2 bullets)
      - "This week's focus" (1 specific, actionable suggestion)

    Keep the whole response under 200 words. Plain text only — no markdown
    headers, no emojis. Address the user as "you".
    PROMPT;

    public function __construct(private readonly ClaudeService $claude) {}

    /**
     * GET /api/insights
     *
     * `kind` narrows to one kind of insight. It was added for the HUD's nudges
     * panel, which Phase 11 dropped with the rails; nudges are shown on
     * Fitness → Home now, beside the weekly assessments.
     *
     * `limit` is clamped rather than trusted, for the same reason the agent's
     * tools clamp theirs: it arrives from a client and the ceiling is the
     * server's to decide.
     */
    public function index(Request $request): JsonResponse
    {
        $limit = (int) $request->query('limit', 50);
        $query = Insight::query()
            ->orderByDesc('created_at')
            ->limit(max(1, min(50, $limit)));

        if ($domain = $request->query('domain')) {
            $query->where('domain', $domain);
        }

        if ($kind = $request->query('kind')) {
            $query->where('kind', $kind);
        }

        return response()->json(['data' => $query->get()]);
    }

    /**
     * POST /api/insights/fitness
     */
    public function fitness(): JsonResponse
    {
        // Before the log is even read. Both refusals below can be true at once
        // on a quiet month, and "no workouts in the last 21 days" is the wrong
        // one to show someone who switched the API off ten seconds ago —
        // logging a session would not fix it.
        if (! AnthropicSwitch::enabled()) {
            return response()->json(['message' => AnthropicDisabled::MESSAGE], 503);
        }

        $workouts = Workout::query()
            ->with(['sets' => fn ($q) => $q->orderBy('exercise_title')->orderBy('set_index')])
            ->where('started_at', '>=', now()->subDays(21))
            ->orderBy('started_at')
            ->get();

        if ($workouts->isEmpty()) {
            return response()->json([
                'message' => 'No workouts in the last 21 days. Log some sessions and try again.',
            ], 422);
        }

        $userMessage = 'Here are my workouts from the last 21 days (today is '
            .now()->toDateString()."):\n\n"
            .WorkoutTranscript::render($workouts)
            ."\n\nGive me a weekly assessment.";

        try {
            $result = $this->claude->complete(AssistantInstructions::get(AssistantInstructions::ASSESSMENT), $userMessage);
        } catch (AnthropicDisabled|AnthropicOutOfCredit $e) {
            // 503, and the message is not prefixed: this is not a call that
            // failed, it is a call that was never made, and "Claude call
            // failed: the Anthropic API is switched off" reads as a fault
            // rather than as the switch doing its job. An empty account is the
            // same kind of sentence: nothing about this request was wrong.
            return response()->json(['message' => $e->getMessage()], 503);
        } catch (Throwable $e) {
            return response()->json([
                'message' => 'Claude call failed: '.$e->getMessage(),
            ], 502);
        }

        $insight = Insight::create([
            'domain' => 'fitness',
            'kind' => 'weekly_assessment',
            'title' => 'Weekly fitness assessment',
            'response' => $result['text'],
            'input_summary' => [
                'workout_count' => $workouts->count(),
                'date_range_start' => $workouts->first()->started_at->toDateString(),
                'date_range_end' => $workouts->last()->started_at->toDateString(),
            ],
            'usage' => $result['usage'],
            'model' => $result['model'],
        ]);

        return response()->json($insight, 201);
    }
}
