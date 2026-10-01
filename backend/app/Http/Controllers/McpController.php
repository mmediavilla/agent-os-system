<?php

namespace App\Http\Controllers;

use App\Agent\Mcp\JsonRpc;
use App\Agent\Mcp\McpServer;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;

/**
 * The MCP endpoint: one POST, streamable HTTP transport.
 *
 * Streamable HTTP rather than stdio because stdio means the host spawning a PHP
 * process and talking to it over pipes, and the app it would have to boot is
 * already running under Herd. An HTTP endpoint is the same server the Expo app
 * talks to, reachable by any host on the machine, with no second copy of the
 * application lifecycle to keep working on Windows.
 *
 * The transport allows a server to answer with an SSE stream instead of JSON.
 * This one never does: nothing here is long-running and the server keeps no
 * session, so a plain JSON reply is the whole of its half of the protocol. A GET
 * to this route therefore 405s, which is exactly how a host is told there is no
 * server-initiated stream to open.
 */
class McpController extends Controller
{
    public function __invoke(Request $request, McpServer $server): JsonResponse|Response
    {
        $message = json_decode($request->getContent(), true);

        if (json_last_error() !== JSON_ERROR_NONE) {
            return response()->json(
                JsonRpc::error(null, JsonRpc::PARSE_ERROR, 'Request body is not valid JSON.'),
                400
            );
        }

        // JSON-RPC batching was removed from MCP in the 2025-06-18 revision, and
        // supporting it would mean deciding what a partial failure means across
        // several tool calls. Saying so beats a confusing "not an object".
        if (! is_array($message) || array_is_list($message)) {
            return response()->json(
                JsonRpc::error(null, JsonRpc::INVALID_REQUEST, 'Expected a single JSON-RPC request object. Batched requests are not supported.'),
                400
            );
        }

        $reply = $server->handle($message);

        // A notification gets no body at all. 202 is the transport's way of
        // saying "received, nothing to answer" — an empty 200 with a JSON
        // content type would leave the host parsing nothing.
        if ($reply === null) {
            return response()->noContent(202);
        }

        // Errors ride back inside the envelope with HTTP 200: the request was
        // delivered and answered, and a host that reads status codes before
        // bodies would otherwise report a transport failure for what is really
        // "no such method".
        return response()->json($reply);
    }
}
