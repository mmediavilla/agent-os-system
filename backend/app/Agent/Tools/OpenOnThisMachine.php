<?php

namespace App\Agent\Tools;

use App\Agent\CapabilityGroup;
use App\Agent\Contracts\LocalTool;
use App\Agent\Contracts\MutatingTool;
use Illuminate\Support\Facades\Process;
use RuntimeException;

/**
 * Open a folder, file, application or page on the machine ProjectMC runs on.
 *
 * This is the whole of Phase 6's answer to "can the assistant reach my
 * computer". The desktop shell the plan sketched was rejected once MCP had
 * already delivered local-machine access; what a browser could never do is
 * *this* — and it turns out the browser does not have to, because the server
 * half of this app is on the same machine as the user.
 *
 * **It is a `MutatingTool` for two independent reasons, and either alone would
 * be enough.** The obvious one is that launching a program is not a read and
 * has to be approved. The second is a Windows accident that happens to line up
 * exactly with the first: `AgentRunner::decide()` runs an approved call inside
 * the *decision HTTP request*, which Herd serves from the interactive desktop
 * session, while the queue worker that runs everything else is registered S4U
 * and has no desktop at all. A window opened from the worker would start,
 * appear nowhere, and never be closed. So the confirmation gate is not only
 * what makes this safe — it is what makes it visible.
 *
 * The model cannot name a path. It picks a key out of a list the user wrote in
 * `config('agent.local.targets')`, and the tool is not registered at all when
 * that list is empty (see `AgentServiceProvider`), so a checkout that has not
 * opted in does not advertise a tool it would refuse to run. That is the same
 * shape as the MCP token: absent configuration closes the door rather than
 * leaving it open.
 */
class OpenOnThisMachine extends BaseTool implements LocalTool, MutatingTool
{
    /** Long enough for a cold `start` on a slow disk; short enough not to hold the request. */
    private const TIMEOUT_SECONDS = 15;

    public function name(): string
    {
        return 'open_on_this_machine';
    }

    public function group(): CapabilityGroup
    {
        return CapabilityGroup::Machine;
    }

    public function description(): string
    {
        $targets = collect(self::targets())
            ->map(fn (array $t, string $key) => "- {$key}: {$t['label']}")
            ->implode("\n");

        return <<<TEXT
        Open something on the user's own computer — a folder, a file, an application or a web
        page — and bring it up in front of them.

        This reaches the one machine ProjectMC is running on and nowhere else. It opens a window
        and returns; it reads nothing back, so it cannot answer a question about what is inside
        whatever it opened.

        Only these can be opened:

        {$targets}

        There is no way to name a path of your own. If the user asks for something that is not on
        that list, tell them it is not one of the places they have allowed rather than opening the
        nearest thing to it.
        TEXT;
    }

    public function inputSchema(): array
    {
        return $this->object([
            'target' => $this->string(
                'Which of the allowed places to open. Must be one of the keys listed in this '.
                "tool's description.",
                array_keys(self::targets()),
            ),
        ], ['target']);
    }

    public function handle(array $input): array
    {
        $targets = self::targets();

        // Validated against the live list rather than against whatever the
        // schema advertised: config can change between a call being proposed and
        // the user approving it, and a key that has since been removed must be
        // refused rather than opened.
        $data = $this->validate($input, [
            'target' => ['required', 'string', 'in:'.implode(',', array_keys($targets))],
        ]);

        $target = $targets[$data['target']];

        $result = Process::timeout(self::TIMEOUT_SECONDS)->run(self::commandFor($target['open']));

        if ($result->failed()) {
            // Thrown, not returned: the runner renders this into a `tool_result`
            // marked `is_error`, which is how the model gets to say "that did not
            // open" instead of reporting success it never saw.
            throw new RuntimeException(
                "Could not open {$data['target']}: ".trim($result->errorOutput() ?: $result->output())
            );
        }

        return [
            'target' => $data['target'],
            'label' => $target['label'],
            'opened' => true,
        ];
    }

    /**
     * The shell's own "open this the way a double-click would" command.
     *
     * On Windows that is `start`, which is a `cmd` builtin rather than a program
     * — hence the `cmd /c`. The empty argument after it is not a typo and not
     * padding: `start "C:\some\path"` reads a single quoted argument as the
     * *window title*, opens a console named after the path, and does nothing
     * else. Passing an empty title first is the documented way to say that the
     * next argument is the thing to open.
     *
     * `start` also detaches, so `cmd` exits immediately and the launched window
     * outlives this request. Waiting on the program itself would hold a PHP-FPM
     * child open for as long as the user left the app running.
     *
     * The OS family is a parameter with the real one as its default, purely so
     * that all three branches can be asserted from a test on any machine — the
     * empty-title argument above is exactly the sort of detail that is wrong
     * once and then never looked at again.
     *
     * @return list<string>
     */
    public static function commandFor(string $open, string $family = PHP_OS_FAMILY): array
    {
        return match ($family) {
            'Windows' => ['cmd', '/c', 'start', '', $open],
            'Darwin' => ['open', $open],
            default => ['xdg-open', $open],
        };
    }

    /**
     * The allowed places, as the user wrote them.
     *
     * Static because `AgentServiceProvider` has to ask the same question before
     * it decides whether to register the tool at all.
     *
     * @return array<string, array{label: string, open: string}>
     */
    public static function targets(): array
    {
        if (! config('agent.local.enabled', false)) {
            return [];
        }

        return collect(config('agent.local.targets', []))
            ->filter(fn ($t) => is_array($t) && is_string($t['open'] ?? null) && $t['open'] !== '')
            ->map(fn (array $t) => ['label' => (string) ($t['label'] ?? ''), 'open' => $t['open']])
            ->all();
    }
}
