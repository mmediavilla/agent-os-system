<?php

namespace App\Services\System;

use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\Cache;

/**
 * The core menu's System stats gauges: what this machine is doing.
 *
 * **Nothing here probes anything.** `current()` reads the last sample out of
 * the cache and reports how old it is; `refresh()` is what actually costs half
 * a second, and it runs on a queue worker. That split is the whole design, and
 * it comes from the premise of the screen rather than from a benchmark: a HUD
 * is left open, so anything it polls has to be free at the point of polling.
 *
 * The consequence is honest rather than hidden. Before the first sample lands
 * the gauges are null and `age_seconds` is null; if the queue worker is dead
 * they stay at the last reading and `age_seconds` climbs, which the client
 * shows. A stale number labelled stale is more use than a fresh number that
 * cost the request half a second — and the staleness is itself the worker
 * health signal that `/api/health` reports separately.
 *
 * Disk is the exception and never waits for a sample: `disk_free_space()` is a
 * stat() call, so it is computed inline on every request and is always current.
 * It is also what puts something on the panel on the very first load.
 */
class SystemStats
{
    public const SAMPLE_KEY = 'hud.system.sample';

    /**
     * Claimed before a sample is queued, and released when it lands.
     *
     * `Cache::add` is atomic, which is what makes this a guard rather than a
     * hint: a HUD polling every few seconds against a *dead* worker would
     * otherwise enqueue one job per poll and fill the `jobs` table with work
     * nothing will ever run.
     */
    public const CLAIM_KEY = 'hud.system.sampling';

    public function __construct(private readonly MachineProbe $probe) {}

    /**
     * @return array<string, mixed>
     */
    public function current(): array
    {
        $sample = Cache::get(self::SAMPLE_KEY);
        $sample = is_array($sample) ? $sample : null;

        $sampledAt = isset($sample['sampled_at']) ? CarbonImmutable::parse($sample['sampled_at']) : null;

        return [
            'host' => gethostname() ?: null,
            'platform' => PHP_OS_FAMILY,
            'sampled_at' => $sampledAt?->toIso8601String(),
            'age_seconds' => $sampledAt ? (int) max(0, CarbonImmutable::now()->diffInSeconds($sampledAt, true)) : null,
            'cpu' => $this->cpu($sample),
            'memory' => $this->memory($sample),
            'disk' => $this->disk(),
        ];
    }

    /** Whether the cached sample is old enough to be worth replacing. */
    public function stale(): bool
    {
        $sample = Cache::get(self::SAMPLE_KEY);

        if (! is_array($sample) || ! isset($sample['sampled_at'])) {
            return true;
        }

        return CarbonImmutable::parse($sample['sampled_at'])
            ->addSeconds((int) config('hud.system.sample_ttl', 10))
            ->isPast();
    }

    /** True if this caller now owns the right to queue a sample. */
    public function claim(): bool
    {
        return Cache::add(self::CLAIM_KEY, true, (int) config('hud.system.dispatch_ttl', 20));
    }

    public function refresh(): void
    {
        $reading = $this->probe->read();

        if ($reading !== null) {
            Cache::forever(self::SAMPLE_KEY, $reading + [
                'sampled_at' => CarbonImmutable::now()->toIso8601String(),
            ]);
        }

        // Released whether or not the probe worked. Holding the claim after a
        // failure would mean one bad sample suppresses every retry until the
        // TTL runs out, which is exactly when a retry is most wanted.
        Cache::forget(self::CLAIM_KEY);
    }

    /**
     * @param  array<string, mixed>|null  $sample
     * @return array{percent: float}|null
     */
    private function cpu(?array $sample): ?array
    {
        $percent = $sample['cpu_percent'] ?? null;

        return $percent === null ? null : ['percent' => round((float) $percent, 1)];
    }

    /**
     * @param  array<string, mixed>|null  $sample
     * @return array{used_bytes: int, total_bytes: int, percent: float}|null
     */
    private function memory(?array $sample): ?array
    {
        $used = $sample['memory_used_bytes'] ?? null;
        $total = $sample['memory_total_bytes'] ?? null;

        if ($used === null || ! $total) {
            return null;
        }

        return self::gauge((int) $used, (int) $total);
    }

    /**
     * @return array{used_bytes: int, total_bytes: int, percent: float, path: string}|null
     */
    private function disk(): ?array
    {
        $path = config('hud.system.disk_path') ?: base_path();

        $free = @disk_free_space($path);
        $total = @disk_total_space($path);

        if ($free === false || $total === false || ! $total) {
            return null;
        }

        return self::gauge((int) ($total - $free), (int) $total) + ['path' => $path];
    }

    /**
     * @return array{used_bytes: int, total_bytes: int, percent: float}
     */
    private static function gauge(int $used, int $total): array
    {
        return [
            'used_bytes' => $used,
            'total_bytes' => $total,
            'percent' => round($used / $total * 100, 1),
        ];
    }
}
