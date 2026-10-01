<?php

namespace App\Http\Controllers;

use App\Agent\Support\TranscriptPresenter;
use App\Models\AgentRun;
use App\Models\AgentRunEvent;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Collection;
use Symfony\Component\HttpFoundation\StreamedResponse;

/**
 * Watching a queued run, twice over.
 *
 * `show` hands back the tail of the event log; `stream` relays the same log as
 * it grows. They are deliberately the same data behind two transports, because
 * the client is two clients: a browser has `EventSource` and a phone does not
 * — React Native cannot read a streaming fetch body at all, which is the reason
 * the design is "202 plus a run id" rather than a streamed POST response. A
 * polling client is not a degraded mode here, it is the one that has to keep
 * working, so it reads the identical rows through the identical index.
 *
 * Neither endpoint is the source of truth for what the run did. Every event is
 * a duplicate of something already written to `conversation_messages` or
 * `agent_actions`, so a client that misses the whole stream and re-reads the
 * conversation is not missing anything — which is what makes it safe for this
 * to be best-effort, time-limited and interruptible.
 *
 * Both are outside `throttle:agent`. That ceiling exists because a client stuck
 * retrying a *tool-calling* endpoint spends money; these two spend one indexed
 * query, and a browser reconnecting a dropped stream every second and a half
 * would eat the allowance that protects the endpoint that matters.
 */
class AgentRunController extends Controller
{
    /** How long a terminal run is waited on for its closing event before giving up. */
    private const GRACE_SECONDS = 2.0;

    /**
     * GET /api/agent/runs/{run}
     *
     * `after` is the last `seq` already seen, so a poller asks for what it has
     * not got rather than for a window of time — which means a slow client
     * catches up rather than skipping the middle of an answer.
     */
    public function show(Request $request, AgentRun $run): JsonResponse
    {
        $after = max(0, (int) $request->query('after', '0'));

        return response()->json([
            'run' => TranscriptPresenter::run($run),
            'events' => TranscriptPresenter::events($this->eventsAfter($run, $after)),
        ]);
    }

    /**
     * GET /api/agent/runs/{run}/stream
     *
     * Server-sent events. The response is capped at `agent.stream.max_seconds`
     * and closed cleanly; `EventSource` reconnects on its own with
     * `Last-Event-ID`, which is the `seq` of the last event it saw, so the cap
     * costs a resumed query rather than a gap.
     */
    public function stream(Request $request, AgentRun $run): StreamedResponse
    {
        $after = max(0, (int) ($request->header('Last-Event-ID') ?? $request->query('after', '0')));

        $pollMs = max(50, (int) config('agent.stream.poll_ms', 250));
        $deadline = microtime(true) + max(5, (int) config('agent.stream.max_seconds', 110));
        $retryMs = max(250, (int) config('agent.stream.retry_ms', 1500));

        $response = new StreamedResponse(function () use ($run, $after, $pollMs, $deadline, $retryMs) {
            // The cap above is the stream's real limit, and PHP's must sit past
            // it. Herd's is 30s and on Windows it counts wall-clock time, sleeps
            // included, so without this every stream was killed at 30s with a
            // fatal and "headers already sent" in the log. EventSource
            // reconnected, so it looked like it worked. It is set here, where
            // the loop starts, because set_time_limit restarts the count.
            set_time_limit((int) ceil($deadline - microtime(true)) + 15);

            $this->unbuffer();

            echo 'retry: '.$retryMs."\n\n";
            $this->push();

            $seq = $after;

            // When the run row first looked terminal. The *event* is what ends
            // the stream — the row is written a moment before it, so breaking
            // on the row alone races the closing event and loses it — but a
            // worker that died leaves a terminal row and no event at all, so
            // this is the bound on how long that is waited for.
            $terminalSince = null;

            while (true) {
                $events = $this->eventsAfter($run, $seq);

                foreach ($events as $event) {
                    $seq = (int) $event->seq;
                    $this->send($event);
                }

                $this->push();

                if ($events->contains(fn (AgentRunEvent $e) => $e->type === AgentRunEvent::FINISHED)) {
                    return;
                }

                if (connection_aborted() !== 0 || microtime(true) >= $deadline) {
                    return;
                }

                $status = AgentRun::query()->whereKey($run->getKey())->value('status');

                if ($status === null || in_array($status, AgentRun::TERMINAL, true)) {
                    $terminalSince ??= microtime(true);

                    if (microtime(true) - $terminalSince > self::GRACE_SECONDS) {
                        return;
                    }
                } else {
                    $terminalSince = null;
                }

                usleep($pollMs * 1000);
            }
        });

        $response->headers->set('Content-Type', 'text/event-stream');
        $response->headers->set('Cache-Control', 'no-cache, no-transform');
        $response->headers->set('Connection', 'keep-alive');
        // nginx — which is what Herd runs — buffers a proxied response by
        // default, and a buffered SSE stream arrives all at once at the end,
        // which looks exactly like streaming not working.
        $response->headers->set('X-Accel-Buffering', 'no');

        return $response;
    }

    // ── plumbing ─────────────────────────────────────────────────────────────

    /**
     * @return Collection<int, AgentRunEvent>
     */
    private function eventsAfter(AgentRun $run, int $after)
    {
        return AgentRunEvent::query()
            ->where('agent_run_id', $run->getKey())
            ->where('seq', '>', $after)
            ->orderBy('seq')
            // A ceiling rather than a page: a client this far behind is
            // catching up, and the next pass through the loop hands it the
            // rest a few milliseconds later.
            ->limit(500)
            ->get();
    }

    private function send(AgentRunEvent $event): void
    {
        // `id` is the resume token EventSource sends back as Last-Event-ID, and
        // `event` names the type so a client can attach a listener per kind
        // rather than switching inside one handler.
        echo 'id: '.$event->seq."\n";
        echo 'event: '.$event->type."\n";
        echo 'data: '.json_encode(TranscriptPresenter::event($event))."\n\n";
    }

    /**
     * Get out of the way of every buffer between here and the socket.
     *
     * Without this the first flush does nothing: PHP's own output buffering
     * holds the bytes, and a compression handler further out holds them
     * regardless of how often `flush()` is called — which produces a response
     * that is correct, complete, and arrives all at once two minutes later.
     *
     * Skipped entirely when there is no socket. Under the test runner the only
     * output buffer in the stack is the one capturing this response for
     * assertion, and tearing it down to reach a client that is not there both
     * fails and loses the bytes the test wanted to read.
     */
    private function unbuffer(): void
    {
        if (! $this->live()) {
            return;
        }

        while (ob_get_level() > 0) {
            ob_end_flush();
        }

        if (function_exists('apache_setenv')) {
            @apache_setenv('no-gzip', '1');
        }

        @ini_set('zlib.output_compression', '0');
        @ini_set('output_buffering', '0');
        @ini_set('implicit_flush', '1');
    }

    private function push(): void
    {
        if (! $this->live()) {
            return;
        }

        if (ob_get_level() > 0) {
            @ob_flush();
        }

        @flush();
    }

    /** Whether there is a client at the other end, or a test collecting bytes. */
    private function live(): bool
    {
        return ! app()->runningUnitTests();
    }
}
