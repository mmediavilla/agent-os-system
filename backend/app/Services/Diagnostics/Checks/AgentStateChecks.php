<?php

namespace App\Services\Diagnostics\Checks;

use App\Models\AgentAction;
use App\Models\AgentRun;
use App\Models\Automation;
use App\Services\Diagnostics\Finding;
use App\Services\Diagnostics\SoftFix;
use Illuminate\Support\Str;

/**
 * Conversations stuck in a state nothing will move them out of.
 *
 * A voice run a fatal left `running` locks its thread for good (`RunDispatcher`
 * releases one only when that thread is next used); a write parked on an
 * approval card refuses every new message in its thread; an automation that
 * failed says so only in its own overlay.
 */
class AgentStateChecks extends Check
{
    public static function group(): string
    {
        return 'agent';
    }

    public static function title(): string
    {
        return 'Conversations';
    }

    public function run(): array
    {
        return [
            $this->strandedVoice(),
            $this->pendingActions(),
            $this->automations(),
        ];
    }

    private function strandedVoice(): Finding
    {
        $title = 'Spoken turns left running';

        $stranded = AgentRun::query()
            ->where('trigger', AgentRun::TRIGGER_VOICE)
            ->where('status', AgentRun::RUNNING)
            ->where('started_at', '<', now()->subSeconds(AgentRun::VOICE_MAX_SECONDS + 30))
            ->get(['id', 'conversation_id']);

        if ($stranded->isEmpty()) {
            return $this->ok('voice_runs', $title, 'No spoken turn has outlived its request.', ['stranded: 0']);
        }

        return $this->problem(
            'voice_runs',
            $title,
            'A spoken turn\'s request died without finishing it, and its thread refuses every new question until it is released.',
            ["stranded: {$stranded->count()}", 'threads: '.$stranded->pluck('conversation_id')->unique()->implode(', ')],
            fix: SoftFix::ReleaseStuckRuns,
        );
    }

    /** Not a soft fix: whether the write happens is the owner's decision. */
    private function pendingActions(): Finding
    {
        $hours = (int) config('diagnostics.agent.pending_action_hours');
        $title = 'Writes waiting for approval';

        $pending = AgentAction::query()
            ->where('status', AgentAction::PENDING)
            ->where('created_at', '<', now()->subHours($hours))
            ->get(['conversation_id', 'tool']);

        if ($pending->isEmpty()) {
            return $this->ok('pending_actions', $title, "Nothing has waited for a decision longer than {$hours} hours.", ['waiting: 0']);
        }

        return $this->warn(
            'pending_actions',
            $title,
            "A write has waited on its approval card for over {$hours} hours; its thread refuses new messages until it is decided.",
            ["waiting: {$pending->count()}", 'tools: '.$pending->pluck('tool')->unique()->implode(', '), 'threads: '.$pending->pluck('conversation_id')->unique()->implode(', ')],
            manual: 'Open the thread in the Assistant and approve or decline the card.',
        );
    }

    private function automations(): Finding
    {
        $title = 'Automations';

        $failed = Automation::query()
            ->where('enabled', true)
            ->where('last_outcome', Automation::FAILED)
            ->orderBy('time')
            ->get(['name', 'last_error']);

        if ($failed->isEmpty()) {
            return $this->ok('automations', $title, 'No switched-on automation failed its last run.', ['failed: 0']);
        }

        return $this->warn(
            'automations',
            $title,
            $failed->count() === 1 ? 'An automation failed its last run.' : "{$failed->count()} automations failed their last run.",
            $failed->map(fn (Automation $a) => "{$a->name}: ".Str::limit((string) $a->last_error, 160))->all(),
            manual: 'Open Automations, read the error on the card, and press Run now once it is fixed.',
        );
    }
}
