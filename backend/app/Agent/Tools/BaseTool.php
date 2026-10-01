<?php

namespace App\Agent\Tools;

use App\Agent\CapabilityGroup;
use App\Agent\Contracts\Tool;
use Illuminate\Support\Facades\Validator;

/**
 * Shared plumbing for every tool: the wire schema, the JSON Schema builders, and
 * the two limits that stop one tool call from swamping a context window.
 */
abstract class BaseTool implements Tool
{
    /**
     * Ceiling on any `limit` argument, applied server-side.
     *
     * The model is told the cap in the parameter description, but it is enforced
     * here regardless — a schema is a hint to a language model, never a
     * constraint, and "limit": 10000 has to cost nothing.
     */
    public const MAX_LIMIT = 50;

    /**
     * Restated rather than inherited silently from the contract, so that every
     * tool has to answer it: there is no default group, because a default is
     * how a new tool would end up owned by nobody — or by everybody.
     */
    abstract public function group(): CapabilityGroup;

    final public function schema(): array
    {
        return [
            'name' => $this->name(),
            'description' => $this->description(),
            'input_schema' => $this->inputSchema(),
        ];
    }

    /**
     * A JSON Schema object.
     *
     * `additionalProperties: false` is set on every one: an argument the tool
     * does not know about is always a misunderstanding, and it is cheaper for
     * the model to be told so than to have the value silently dropped.
     *
     * @param  array<string, array>  $properties
     * @param  list<string>  $required
     */
    protected function object(array $properties, array $required = []): array
    {
        return [
            'type' => 'object',
            'properties' => $properties,
            'required' => $required,
            'additionalProperties' => false,
        ];
    }

    /** @param  list<string>|null  $enum */
    protected function string(string $description, ?array $enum = null): array
    {
        return array_filter([
            'type' => 'string',
            'description' => $description,
            'enum' => $enum,
        ], fn ($v) => $v !== null);
    }

    protected function number(string $description): array
    {
        return ['type' => 'number', 'description' => $description];
    }

    protected function integer(string $description): array
    {
        return ['type' => 'integer', 'description' => $description];
    }

    protected function boolean(string $description): array
    {
        return ['type' => 'boolean', 'description' => $description];
    }

    protected function array(string $description, array $items): array
    {
        return ['type' => 'array', 'description' => $description, 'items' => $items];
    }

    /** The `limit` property, described with the cap the server will apply anyway. */
    protected function limitProperty(int $default): array
    {
        return $this->integer("How many rows to return. Default {$default}, maximum ".self::MAX_LIMIT.'.');
    }

    /** Read `limit` out of the input, clamped into [1, MAX_LIMIT]. */
    protected function limit(array $input, int $default): int
    {
        $requested = isset($input['limit']) ? (int) $input['limit'] : $default;

        return max(1, min($requested, self::MAX_LIMIT));
    }

    /**
     * Validate model-supplied arguments.
     *
     * Throws `ValidationException`, which the runner renders into a
     * `tool_result` marked `is_error` — the model then sees exactly which field
     * it got wrong and retries, instead of the request 500ing.
     */
    protected function validate(array $input, array $rules): array
    {
        return Validator::make($input, $rules)->validate();
    }
}
