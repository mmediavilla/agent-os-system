<?php

namespace App\Agent\Mcp;

/**
 * The JSON-RPC 2.0 envelope, and nothing else.
 *
 * MCP is the tool layer plus this: a request names a method and carries params,
 * a response carries either `result` or `error`, and a message with no `id` is a
 * notification that is never answered. Keeping the framing in its own file is
 * what makes McpServer read as protocol logic rather than as array plumbing.
 */
final class JsonRpc
{
    public const VERSION = '2.0';

    /** Malformed JSON — the request body never parsed. */
    public const PARSE_ERROR = -32700;

    /** Parsed, but not a JSON-RPC request. */
    public const INVALID_REQUEST = -32600;

    /** A method this server does not implement. */
    public const METHOD_NOT_FOUND = -32601;

    /** The method exists; its params do not fit. */
    public const INVALID_PARAMS = -32602;

    /** Anything that got as far as the handler and then failed. */
    public const INTERNAL_ERROR = -32603;

    /**
     * @param  array<string, mixed>  $result
     * @return array<string, mixed>
     */
    public static function result(string|int|null $id, array $result): array
    {
        return [
            'jsonrpc' => self::VERSION,
            'id' => $id,
            'result' => $result,
        ];
    }

    /** @return array<string, mixed> */
    public static function error(string|int|null $id, int $code, string $message, mixed $data = null): array
    {
        $error = ['code' => $code, 'message' => $message];

        if ($data !== null) {
            $error['data'] = $data;
        }

        return [
            'jsonrpc' => self::VERSION,
            'id' => $id,
            'error' => $error,
        ];
    }
}
