<?php

namespace App\Agent;

use App\Agent\Contracts\LocalTool;
use App\Agent\Contracts\MutatingTool;
use App\Agent\Contracts\Tool;
use App\Agent\Support\ResultEncoder;
use Illuminate\Support\Arr;
use Illuminate\Validation\ValidationException;
use InvalidArgumentException;
use Throwable;

/**
 * The catalog of tools, in one fixed order.
 *
 * Order is load-bearing, not cosmetic. The tool definitions sit at the front of
 * every request and are the largest thing the prompt cache holds; reshuffling
 * them changes the cached prefix and pays the full input price again on every
 * turn. So tools are registered from an explicit list (see AgentServiceProvider)
 * that is treated as append-only — a new tool goes at the end.
 *
 * Bound as a singleton because it is built once per request from a static list
 * and read many times.
 */
class ToolRegistry
{
    /** @var array<string, Tool> keyed by name, in registration order */
    private array $tools = [];

    /** @param  iterable<Tool>  $tools */
    public function __construct(iterable $tools = [])
    {
        foreach ($tools as $tool) {
            $this->register($tool);
        }
    }

    /**
     * Names collide silently otherwise: the second registration would win and
     * the first tool would simply never be callable.
     */
    public function register(Tool $tool): void
    {
        if (isset($this->tools[$tool->name()])) {
            throw new InvalidArgumentException("Duplicate tool name: {$tool->name()}");
        }

        $this->tools[$tool->name()] = $tool;
    }

    /**
     * The same catalog with every writing tool removed.
     *
     * A filter rather than a second list, so the two cannot drift:
     * `MutatingTool` is already the marker that decides whether a call goes
     * through the confirmation gate, so a write tool added tomorrow is left out
     * of this registry by the same declaration that gates it in the other. A
     * hand-kept list of "the safe ones" would be the copy nothing tests.
     *
     * Registration order is preserved, which is what the append-only rule needs
     * — but this is a **second prompt-cache prefix**, because six definitions
     * are not eleven. That cost is paid per caller rather than per turn, and it
     * is the price of offering one caller a smaller surface.
     *
     * That caller is the voice path, which is read-only by decision (see
     * `VoiceTurnController`). A spoken "log four sets" is not answered by the
     * tool that would perform it, because that tool is not offered at all
     * rather than offered and then refused.
     */
    public function readOnly(): self
    {
        return new self(array_filter($this->tools, fn (Tool $tool) => ! $tool instanceof MutatingTool));
    }

    /**
     * The same catalog with every local-machine tool removed — see
     * {@see LocalTool}. An automation (15.3) runs on the queue worker with
     * nobody watching, so it is built on this rather than the full registry.
     */
    public function withoutLocalTools(): self
    {
        return new self(array_filter($this->tools, fn (Tool $tool) => ! $tool instanceof LocalTool));
    }

    /**
     * The same catalog cut down to the tools of the given groups, plus every
     * group no agent can own.
     *
     * A filter beside {@see readOnly()} and {@see withoutLocalTools()}, for the
     * reason written on the first: the group is declared on the tool, so this
     * cannot drift from the catalog. The unownable groups ride along here
     * rather than being passed in by each caller, because "core is always
     * loaded" is a rule about groups and belongs next to them — a caller that
     * forgot it would take the weather and the assistant's memory away along
     * with a switched-off agent.
     *
     * Registration order is preserved. Called only through `AgentScope`, at the
     * model-facing callers (the typed loop, voice, MCP) and never on the
     * singleton, because `AutomationRunner` calls tools directly and must keep
     * them all.
     *
     * @param  list<CapabilityGroup>  $groups
     */
    public function forGroups(array $groups): self
    {
        return new self(array_filter(
            $this->tools,
            fn (Tool $tool) => ! $tool->group()->ownable() || in_array($tool->group(), $groups, true),
        ));
    }

    /** @return array<string, Tool> */
    public function all(): array
    {
        return $this->tools;
    }

    public function has(string $name): bool
    {
        return isset($this->tools[$name]);
    }

    public function get(string $name): Tool
    {
        if (! $this->has($name)) {
            throw new InvalidArgumentException("Unknown tool: {$name}");
        }

        return $this->tools[$name];
    }

    /** Whether calling this tool writes, and so has to pass the confirmation gate. */
    public function isMutating(string $name): bool
    {
        return $this->get($name) instanceof MutatingTool;
    }

    /**
     * Every tool's wire definition — the Messages API's `tools` parameter, and
     * the same array MCP's `tools/list` returns.
     *
     * @return list<array<string, mixed>>
     */
    public function schemas(): array
    {
        return array_values(array_map(fn (Tool $t) => $t->schema(), $this->tools));
    }

    /**
     * Run a tool and encode its result for a `tool_result` block.
     *
     * Exceptions are deliberately not caught here — the caller needs to know a
     * call failed so it can set `is_error`, and swallowing that would hand the
     * model a result it cannot distinguish from success.
     */
    public function run(string $name, array $input): string
    {
        return ResultEncoder::encode($this->get($name)->handle($input));
    }

    /**
     * Run a tool and report failure as content rather than as an exception.
     *
     * Both drivers need exactly this and need it to read the same: a failed
     * call is not a transport error, it is a result the model is shown so it can
     * correct itself. Rendering that in two places would let the MCP host and
     * the custom loop disagree about what a validation failure looks like, and
     * the model's ability to recover depends on the text it gets back.
     *
     * A ValidationException is the model's own mistake and is handed back as the
     * field messages. Anything else is a bug in a tool — reported, so the retry
     * does not bury it, and then handed back too.
     *
     * @return array{text: string, is_error: bool}
     */
    public function attempt(string $name, array $input): array
    {
        try {
            return ['text' => $this->run($name, $input), 'is_error' => false];
        } catch (ValidationException $e) {
            return ['text' => implode(' ', Arr::flatten($e->errors())), 'is_error' => true];
        } catch (Throwable $e) {
            report($e);

            return ['text' => $e->getMessage(), 'is_error' => true];
        }
    }
}
