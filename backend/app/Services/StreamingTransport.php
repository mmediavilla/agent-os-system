<?php

namespace App\Services;

use GuzzleHttp\Client as GuzzleClient;
use GuzzleHttp\Psr7\Utils;
use Psr\Http\Client\ClientInterface;
use Psr\Http\Message\RequestInterface;
use Psr\Http\Message\ResponseInterface;

/**
 * A PSR-18 client that hands back a response still attached to its socket.
 *
 * The reason this exists at all is four layers deep, and every one of them is
 * doing what it should:
 *
 * - The Anthropic API streams a turn as it is generated.
 * - The SDK reads that lazily — `Util::streamIterator` pulls a buffer at a time
 *   and yields events as they parse.
 * - The SDK asks its PSR-18 transporter for the response.
 * - **Guzzle's PSR-18 `sendRequest()` downloads the whole body first.** It sets
 *   its own per-request options and does not carry `stream` from the client's
 *   construction, so there is no way to ask for a live body through that
 *   interface.
 * - **And PHP buffers 8KB behind that**, so even a live body is not a live
 *   read — see `unbuffered()`.
 *
 * The result is a stream that is correct and useless: every delta of a
 * twenty-second answer arrives in the same millisecond, at the end, which looks
 * exactly like streaming having never been implemented. `send()` rather than
 * `sendRequest()`, with `stream` set, is the first half of the fix; the other
 * three options here are the ones Guzzle's own PSR-18 entry point sets,
 * repeated because that is the contract being stood in for.
 *
 * Used only for streamed turns. The weekly insight is one non-streamed call a
 * week and has nothing to gain from a different HTTP transport.
 */
final class StreamingTransport implements ClientInterface
{
    public function __construct(private readonly GuzzleClient $guzzle) {}

    public function sendRequest(RequestInterface $request): ResponseInterface
    {
        $response = $this->guzzle->send($request, [
            'stream' => true,
            // PSR-18's contract, which Guzzle's own sendRequest() sets and this
            // is replacing: never throw on a status code, never follow a
            // redirect silently, and do not go through the async pool.
            'synchronous' => true,
            'allow_redirects' => false,
            'http_errors' => false,
        ]);

        return $this->unbuffered($response);
    }

    /**
     * Take PHP's own read buffer out of the way of the socket.
     *
     * A live body is still not a live *read*: PHP's stream layer fills an 8KB
     * buffer before `fread` returns, so a caller asking for 8192 bytes waits
     * for 8192 bytes to exist — several seconds of an answer at a time. The SDK
     * reads in exactly that size, so this is the difference between events
     * arriving as they are generated and arriving in half a dozen lumps.
     *
     * Detaching and re-wrapping is how the underlying resource is reached at
     * all; PSR-7 has no notion of buffering, and Guzzle's stream does not
     * expose the handle any other way. A response whose body is not a plain
     * resource is returned untouched.
     */
    private function unbuffered(ResponseInterface $response): ResponseInterface
    {
        $resource = $response->getBody()->detach();

        if (! is_resource($resource)) {
            return $response;
        }

        stream_set_read_buffer($resource, 0);
        stream_set_chunk_size($resource, 1024);

        return $response->withBody(Utils::streamFor($resource));
    }
}
