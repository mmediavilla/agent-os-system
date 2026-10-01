<?php

namespace App\Services\System;

use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\Cache;

/**
 * Proof that something outside the web server is still running.
 *
 * Herd serves HTTP and nothing else, so the scheduler and the queue worker are
 * two Windows Task Scheduler entries — and the failure mode of either is
 * silence. A dead worker does not error: a queued run simply sits at `queued`
 * forever. A dead scheduler does not error either: the proactive check just
 * never fires, and "the app never talks to me unprompted" is indistinguishable
 * from "there was nothing to say".
 *
 * Neither has a status to ask for, so both are asked to *prove* it. The
 * per-minute tick stamps `scheduler` inline and queues a job that stamps
 * `queue`; a stamp older than the grace period means down. That makes one
 * scheduled entry cover both, and — the part that matters — it means the queue
 * check exercises the whole path a real job takes rather than counting rows in
 * a table, which says nothing about whether anything is draining them.
 *
 * `forever` rather than a TTL: the age *is* the signal, and a key that expired
 * would report "never seen" for a worker that died an hour ago, which reads
 * like a machine that was never set up rather than one that stopped.
 */
final class Heartbeat
{
    public const SCHEDULER = 'hud.heartbeat.scheduler';

    public const QUEUE = 'hud.heartbeat.queue';

    public static function beat(string $key): void
    {
        Cache::forever($key, CarbonImmutable::now()->toIso8601String());
    }

    public static function lastAt(string $key): ?CarbonImmutable
    {
        $stamp = Cache::get($key);

        if (! is_string($stamp)) {
            return null;
        }

        try {
            return CarbonImmutable::parse($stamp);
        } catch (\Throwable) {
            return null;
        }
    }
}
