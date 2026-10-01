<?php

namespace App\Http\Controllers;

use App\Jobs\RunAutomation;
use App\Models\Automation;
use App\Services\FitnessSettings;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;

/**
 * The Automations overlay (15.4) and the HUD's own trigger.
 *
 * Rows are cheap CRUD, like Facts' — no filters, no pagination, a page long for
 * a long time. `run` and `due` are the two that can queue a paid model call, so
 * they carry `throttle:agent` in routes/api.php while the rest do not.
 */
class AutomationController extends Controller
{
    /** GET /api/automations */
    public function index(): JsonResponse
    {
        return response()->json([
            'data' => Automation::query()->orderBy('time')->get()->map($this->present(...))->all(),
        ]);
    }

    /** POST /api/automations { name, time, intent, context, enabled? } */
    public function store(Request $request): JsonResponse
    {
        $data = $request->validate([
            'name' => ['required', 'string', 'max:120'],
            'time' => ['required', 'string', 'regex:'.FitnessSettings::TIME_PATTERN],
            'intent' => ['required', 'string', 'max:2000'],
            'context' => ['required', 'array'],
            'context.*' => [Rule::in(Automation::CONTEXT)],
            'enabled' => ['sometimes', 'boolean'],
        ], [
            'time.regex' => 'The time must be 24-hour HH:MM, like 06:30.',
        ]);

        $automation = Automation::create($data + ['enabled' => $data['enabled'] ?? false]);

        return response()->json($this->present($automation), 201);
    }

    /** PATCH /api/automations/{automation} — any of the writable fields, each fully validated. */
    public function update(Request $request, Automation $automation): JsonResponse
    {
        $data = $request->validate([
            'name' => ['sometimes', 'required', 'string', 'max:120'],
            'time' => ['sometimes', 'required', 'string', 'regex:'.FitnessSettings::TIME_PATTERN],
            'intent' => ['sometimes', 'required', 'string', 'max:2000'],
            'context' => ['sometimes', 'required', 'array'],
            'context.*' => [Rule::in(Automation::CONTEXT)],
            'enabled' => ['sometimes', 'required', 'boolean'],
        ], [
            'time.regex' => 'The time must be 24-hour HH:MM, like 06:30.',
        ]);

        $automation->update($data);

        return response()->json($this->present($automation));
    }

    /** DELETE /api/automations/{automation} */
    public function destroy(Automation $automation): JsonResponse
    {
        $automation->delete();

        return response()->json(null, 204);
    }

    /**
     * POST /api/automations/{automation}/run — now, ignoring the once-a-day
     * guard, for trying out an intent without waiting for its hour.
     */
    public function run(Automation $automation): JsonResponse
    {
        RunAutomation::dispatch($automation->id);

        return response()->json(['dispatched' => true], 202);
    }

    /**
     * POST /api/automations/due — the HUD's call on load and on the tab
     * becoming visible again.
     *
     * Each enabled row past its time, not already run today, is claimed with a
     * conditional update before it is dispatched — the same shape as
     * `AgentAction::decide()` — so two tabs open at once cannot both fire the
     * same greeting.
     */
    public function due(): JsonResponse
    {
        $zone = config('agent.timezone');
        $today = now($zone)->toDateString();
        $time = now($zone)->format('H:i');

        $due = Automation::query()
            ->where('enabled', true)
            ->where('time', '<=', $time)
            ->where(fn ($q) => $q->whereNull('last_run_on')->orWhere('last_run_on', '<', $today))
            ->get();

        $claimed = [];

        foreach ($due as $automation) {
            $updated = Automation::query()
                ->whereKey($automation->id)
                ->where(fn ($q) => $q->whereNull('last_run_on')->orWhere('last_run_on', '<', $today))
                ->update(['last_run_on' => $today, 'updated_at' => now()]);

            if ($updated === 1) {
                RunAutomation::dispatch($automation->id);
                $claimed[] = $automation->id;
            }
        }

        return response()->json(['claimed' => $claimed]);
    }

    /** @return array<string, mixed> */
    private function present(Automation $automation): array
    {
        return [
            'id' => $automation->id,
            'name' => $automation->name,
            'time' => $automation->time,
            'intent' => $automation->intent,
            'context' => $automation->context,
            'enabled' => $automation->enabled,
            'last_run_on' => optional($automation->last_run_on)->toDateString(),
            'last_run_at' => optional($automation->last_run_at)->toIso8601String(),
            'last_outcome' => $automation->last_outcome,
            'last_error' => $automation->last_error,
            'last_conversation_id' => $automation->last_conversation_id,
        ];
    }
}
