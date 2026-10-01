<?php

namespace App\Agent\Streaming;

use App\Models\AgentAction;

/**
 * Nobody is watching.
 *
 * The default for every entry point into the loop, so that running it without
 * a run row — which is what every unit test and the MCP path do — costs
 * nothing and needs no conditionals inside `AgentRunner`.
 */
final class NullJournal implements RunJournal
{
    public function started(): void {}

    public function thinking(string $delta): void {}

    public function text(string $delta): void {}

    public function toolStarted(AgentAction $action): void {}

    public function toolFinished(AgentAction $action): void {}

    public function awaiting(array $actions): void {}

    public function finished(string $status, ?string $error = null): void {}
}
