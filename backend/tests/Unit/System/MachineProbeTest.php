<?php

namespace Tests\Unit\System;

use App\Services\System\MachineProbe;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

/**
 * The two parsers, which are the only part of the probe CI can reach.
 *
 * The subprocess itself is Windows-only and the suite runs on Linux, so what is
 * asserted here is the half that is a pure function of a string — which is also
 * the half that breaks quietly, because a shape change upstream produces nulls
 * rather than an error.
 */
class MachineProbeTest extends TestCase
{
    #[Test]
    public function it_reads_a_powershell_sample(): void
    {
        $reading = MachineProbe::parseWindows('{"cpu":18,"free_kb":6741008,"total_kb":16698928}');

        $this->assertSame(18.0, $reading['cpu_percent']);
        $this->assertSame(16698928 * 1024, $reading['memory_total_bytes']);
        // Used, not free: "19.8 of 32 GB" is the reading, and the subtraction
        // happens once, here.
        $this->assertSame((16698928 - 6741008) * 1024, $reading['memory_used_bytes']);
    }

    #[Test]
    public function it_survives_a_sample_with_nothing_in_it(): void
    {
        $this->assertNull(MachineProbe::parseWindows('not json'));

        $partial = MachineProbe::parseWindows('{"cpu":null}');
        $this->assertNull($partial['cpu_percent']);
        $this->assertNull($partial['memory_total_bytes']);
        $this->assertNull($partial['memory_used_bytes']);
    }

    #[Test]
    public function it_reads_meminfo_by_available_rather_than_free(): void
    {
        // MemFree excludes the page cache, which the kernel hands back on
        // demand — reading it would put a healthy machine at 95% full.
        $memory = MachineProbe::parseMeminfo(<<<'PROC'
        MemTotal:       16384000 kB
        MemFree:          512000 kB
        MemAvailable:    8192000 kB
        Buffers:          200000 kB
        PROC);

        $this->assertSame(16384000 * 1024, $memory['total']);
        $this->assertSame((16384000 - 8192000) * 1024, $memory['used']);
    }

    #[Test]
    public function it_returns_null_when_meminfo_is_not_what_it_expected(): void
    {
        $this->assertNull(MachineProbe::parseMeminfo("MemTotal: 16384000 kB\n"));
        $this->assertNull(MachineProbe::parseMeminfo(''));
    }
}
