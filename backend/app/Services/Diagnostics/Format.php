<?php

namespace App\Services\Diagnostics;

/** How a number reads in evidence: one spelling of a size and of an age. */
final class Format
{
    public static function bytes(int $bytes): string
    {
        $units = ['B', 'KB', 'MB', 'GB', 'TB'];
        $value = (float) $bytes;
        $unit = 0;

        while ($value >= 1024 && $unit < count($units) - 1) {
            $value /= 1024;
            $unit++;
        }

        return $unit === 0 ? "{$bytes} B" : number_format($value, 1).' '.$units[$unit];
    }

    public static function age(int $seconds): string
    {
        return match (true) {
            $seconds < 60 => "{$seconds}s",
            $seconds < 3600 => intdiv($seconds, 60).'m',
            $seconds < 86400 => intdiv($seconds, 3600).'h '.intdiv($seconds % 3600, 60).'m',
            default => intdiv($seconds, 86400).'d '.intdiv($seconds % 86400, 3600).'h',
        };
    }
}
