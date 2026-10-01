<?php

namespace App\Agent\Contracts;

use App\Agent\CapabilityGroup;

/**
 * One capability the assistant can invoke.
 *
 * The same object serves both drivers: `schema()` is literally the array the
 * Messages API takes in its `tools` parameter and the array MCP's `tools/list`
 * returns, so exposing the tool layer over MCP (Phase 2) adds JSON-RPC framing
 * and nothing else.
 *
 * Schemas are hand-written rather than derived from the writers' Laravel rules.
 * The rules carry no descriptions, and a parameter description is the single
 * highest-leverage part of a tool definition — it is what the model reads to
 * decide whether this tool answers the question in front of it. The two are kept
 * honest by a test asserting each schema's `required` is a subset of its
 * `properties` and agrees with the writer it feeds.
 */
interface Tool
{
    /** snake_case, unique across the registry, stable — the model calls this by name. */
    public function name(): string;

    /**
     * The kind of work this tool does — what an agent owns, and what switching
     * that agent off takes away. {@see CapabilityGroup}
     */
    public function group(): CapabilityGroup;

    /** What the tool answers and when to reach for it. Written for the model, not for a developer. */
    public function description(): string;

    /** @return array<string, mixed> a JSON Schema object describing the arguments */
    public function inputSchema(): array;

    /**
     * The wire definition: `{name, description, input_schema}`.
     *
     * @return array<string, mixed>
     */
    public function schema(): array;

    /**
     * Run the tool.
     *
     * `$input` arrives straight from the model and is untrusted — an
     * implementation validates it itself. Throwing is the correct way to reject
     * bad input: the caller turns an exception into a `tool_result` marked
     * `is_error`, which is how the model sees its mistake and self-corrects.
     *
     * @param  array<string, mixed>  $input
     * @return array<string, mixed> JSON-encodable; the caller handles encoding and size
     */
    public function handle(array $input): array;
}
