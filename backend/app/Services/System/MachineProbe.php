<?php

namespace App\Services\System;

use Illuminate\Support\Facades\Process;
use Throwable;

/**
 * What this computer is doing, as far as PHP can be told.
 *
 * On Windows there is no cheap answer. `sys_getloadavg()` does not exist,
 * `com_dotnet` is not in Herd's build, and `ffi.enable` is `preload`, which
 * makes FFI a CLI-only door — so the only route to CPU and memory is a
 * subprocess, and a cold `powershell.exe` measures around half a second. That
 * cost is why nothing calls this from a request: `SystemStats` serves the last
 * sample and queues the next one.
 *
 * One PowerShell invocation returns both numbers, because two would cost two
 * process starts and the start *is* the cost. `LoadPercentage` is averaged over
 * the processor packages — a single-socket machine has one, but averaging is
 * free and reporting only the first would be wrong on the machine that has two.
 *
 * Elsewhere it reads `/proc`, which costs nothing and is the reason the class
 * has a second branch at all: the suite runs on Linux in CI, and a probe that
 * could only be exercised on a developer's Windows box would be a probe nothing
 * tests. The parsing is split out as pure functions for the same reason — the
 * subprocess cannot be asserted on in CI, the string it returns can.
 *
 * Every failure returns null rather than throwing. A missing gauge is a panel
 * that says so; an exception is a 500 on a telemetry endpoint, which is a
 * strictly worse way to learn that CPU is unavailable.
 */
class MachineProbe
{
    /** One line, because each `powershell.exe` start costs more than the query. */
    private const WINDOWS_COMMAND = '$os = Get-CimInstance Win32_OperatingSystem; '
        .'$cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average; '
        .'[pscustomobject]@{ cpu = $cpu; free_kb = $os.FreePhysicalMemory; total_kb = $os.TotalVisibleMemorySize } '
        .'| ConvertTo-Json -Compress';

    /**
     * @return array{cpu_percent: float|null, memory_used_bytes: int|null, memory_total_bytes: int|null}|null
     */
    public function read(): ?array
    {
        try {
            return PHP_OS_FAMILY === 'Windows' ? $this->readWindows() : $this->readProc();
        } catch (Throwable) {
            return null;
        }
    }

    private function readWindows(): ?array
    {
        $result = Process::timeout((int) config('hud.system.probe_timeout', 15))
            ->run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', self::WINDOWS_COMMAND]);

        return $result->successful() ? self::parseWindows($result->output()) : null;
    }

    private function readProc(): ?array
    {
        $meminfo = @file_get_contents('/proc/meminfo');
        $memory = is_string($meminfo) ? self::parseMeminfo($meminfo) : null;

        return [
            'cpu_percent' => self::loadPercent(),
            'memory_used_bytes' => $memory['used'] ?? null,
            'memory_total_bytes' => $memory['total'] ?? null,
        ];
    }

    /**
     * The one-minute load average as a percentage of the cores available.
     *
     * Not the same quantity Windows reports — load counts runnable processes
     * and can exceed the core count — so it is clamped at 100 rather than shown
     * raw. A gauge that reads 340% is a gauge nobody trusts for the 30% case.
     */
    private static function loadPercent(): ?float
    {
        if (! function_exists('sys_getloadavg')) {
            return null;
        }

        $load = sys_getloadavg();
        $cores = self::cores();

        if ($load === false || $cores < 1) {
            return null;
        }

        return round(min(100, $load[0] / $cores * 100), 1);
    }

    private static function cores(): int
    {
        $cpuinfo = @file_get_contents('/proc/cpuinfo');

        return is_string($cpuinfo) ? max(1, substr_count($cpuinfo, 'processor')) : 1;
    }

    /**
     * @return array{cpu_percent: float|null, memory_used_bytes: int|null, memory_total_bytes: int|null}|null
     */
    public static function parseWindows(string $json): ?array
    {
        $data = json_decode(trim($json), true);

        if (! is_array($data)) {
            return null;
        }

        // Reported in kibibytes by WMI, and the two are subtracted rather than
        // `FreePhysicalMemory` being shown directly: "19.8 of 32 GB used" is the
        // reading, and deriving it here keeps one definition of "used".
        $free = isset($data['free_kb']) ? (int) $data['free_kb'] * 1024 : null;
        $total = isset($data['total_kb']) ? (int) $data['total_kb'] * 1024 : null;

        return [
            'cpu_percent' => isset($data['cpu']) ? (float) $data['cpu'] : null,
            'memory_used_bytes' => $free !== null && $total !== null ? max(0, $total - $free) : null,
            'memory_total_bytes' => $total,
        ];
    }

    /**
     * `MemAvailable`, not `MemFree`.
     *
     * `MemFree` on Linux excludes the page cache, which the kernel will hand
     * back the moment anything asks — so a healthy machine reads as 95% full.
     *
     * @return array{used: int, total: int}|null
     */
    public static function parseMeminfo(string $text): ?array
    {
        $read = function (string $field) use ($text): ?int {
            return preg_match('/^'.$field.':\s+(\d+) kB$/m', $text, $m) === 1
                ? (int) $m[1] * 1024
                : null;
        };

        $total = $read('MemTotal');
        $available = $read('MemAvailable');

        if ($total === null || $available === null) {
            return null;
        }

        return ['used' => max(0, $total - $available), 'total' => $total];
    }
}
