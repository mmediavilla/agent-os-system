<?php

namespace App\Services\Diagnostics\Checks;

use App\Services\Diagnostics\Finding;
use App\Services\Diagnostics\Format;
use App\Services\System\SystemStats;

/**
 * This computer: CPU and memory from the last sample, and the disk now.
 *
 * **Nothing is sampled here.** The sample is taken on the queue worker, and
 * only while the core menu or Stats is open, so an old one is the ordinary
 * state of a machine nobody has been watching — not a fault. CPU and memory
 * are judged only when the sample is recent enough to say something about now;
 * otherwise the finding says how old it is and passes no judgement.
 */
class MachineChecks extends Check
{
    public function __construct(private readonly SystemStats $stats) {}

    public static function group(): string
    {
        return 'machine';
    }

    public static function title(): string
    {
        return 'This machine';
    }

    public function run(): array
    {
        $now = $this->stats->current();
        $age = $now['age_seconds'];
        $judged = $age !== null && $age <= (int) config('diagnostics.machine.judge_within_seconds');

        return [
            $this->sample($now['host'], $age),
            $this->cpu($now['cpu'], $judged),
            $this->memory($now['memory'], $judged),
            $this->disk($now['disk']),
        ];
    }

    private function sample(?string $host, ?int $age): Finding
    {
        $title = 'CPU and memory sample';
        $evidence = ['host: '.($host ?? 'unknown')];

        if ($age === null) {
            return $this->ok('sample', $title, 'No sample yet. One is taken on the worker while the core menu or Stats is open.', [...$evidence, 'sampled: never']);
        }

        return $this->ok('sample', $title, 'The last sample the worker took.', [...$evidence, 'sampled: '.Format::age($age).' ago']);
    }

    /**
     * @param  array{percent: float}|null  $cpu
     */
    private function cpu(?array $cpu, bool $judged): Finding
    {
        $title = 'CPU load';

        if ($cpu === null || ! $judged) {
            return $this->ok('cpu', $title, 'Not judged: there is no recent sample to judge.', ['cpu: '.($cpu === null ? 'unknown' : "{$cpu['percent']}%")]);
        }

        $evidence = ["cpu: {$cpu['percent']}%"];

        if ($cpu['percent'] >= (float) config('diagnostics.machine.cpu_warn_percent')) {
            return $this->warn('cpu', $title, 'The processor is nearly flat out, which slows everything this app does.', $evidence, manual: 'Open Task Manager and see what is using the processor.');
        }

        return $this->ok('cpu', $title, 'The processor has room.', $evidence);
    }

    /**
     * @param  array{used_bytes: int, total_bytes: int, percent: float}|null  $memory
     */
    private function memory(?array $memory, bool $judged): Finding
    {
        $title = 'Memory';

        if ($memory === null || ! $judged) {
            return $this->ok('memory', $title, 'Not judged: there is no recent sample to judge.', ['memory: '.($memory === null ? 'unknown' : "{$memory['percent']}%")]);
        }

        $evidence = ["memory: {$memory['percent']}%", 'used: '.Format::bytes($memory['used_bytes']).' of '.Format::bytes($memory['total_bytes'])];

        if ($memory['percent'] >= (float) config('diagnostics.machine.memory_warn_percent')) {
            return $this->warn('memory', $title, 'Memory is nearly full, so Windows will be paging and everything slows.', $evidence, manual: 'Open Task Manager and close what is using the memory.');
        }

        return $this->ok('memory', $title, 'Memory has room.', $evidence);
    }

    /**
     * @param  array{used_bytes: int, total_bytes: int, percent: float, path: string}|null  $disk
     */
    private function disk(?array $disk): Finding
    {
        $title = 'Disk space';

        if ($disk === null) {
            return $this->warn('disk', $title, 'The disk could not be measured.', [], manual: 'Check the disk the project is on in File Explorer.');
        }

        $free = $disk['total_bytes'] - $disk['used_bytes'];
        $evidence = ["used: {$disk['percent']}%", 'free: '.Format::bytes($free), "volume: {$disk['path']}"];
        $manual = 'Free some space on the disk the project is on.';

        return match (true) {
            $disk['percent'] >= (float) config('diagnostics.machine.disk_problem_percent') => $this->problem('disk', $title, 'The disk is all but full; SQLite and the uploads will start failing.', $evidence, manual: $manual),
            $disk['percent'] >= (float) config('diagnostics.machine.disk_warn_percent') => $this->warn('disk', $title, 'The disk is getting full.', $evidence, manual: $manual),
            default => $this->ok('disk', $title, 'The disk has room.', $evidence),
        };
    }
}
