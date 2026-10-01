<?php

namespace App\Services\Diagnostics\Fixes;

use App\Services\Diagnostics\SoftFix;

/**
 * The code behind one `SoftFix` — the whole of what Troubleshoot may do, one
 * class per key.
 *
 * **Runs inside the Herd request, never on the queue worker**: restarting the
 * worker from a job on the worker would kill the job doing it, and the worker
 * is S4U in session 0 with no desktop, while Herd serves this request from the
 * interactive one. Nothing here queues anything but a heartbeat.
 *
 * A fix says what it did in one sentence (`run()`'s return), and **throws to
 * fail** — `Troubleshooter` turns the exception into a `failed` outcome and goes
 * on to the next, so one broken fix never costs the rest.
 */
abstract class Fix
{
    abstract public static function fix(): SoftFix;

    /** Null when the fix can run here; otherwise why it cannot, as a sentence. */
    public function unavailable(): ?string
    {
        return null;
    }

    /** Do it, and say what was done. Throws on failure. */
    abstract public function run(): string;
}
