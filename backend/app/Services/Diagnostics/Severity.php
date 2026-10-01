<?php

namespace App\Services\Diagnostics;

/**
 * How bad a finding is. Three, and only three.
 *
 * `ok` is a real answer rather than an absence: a passing check still carries
 * its evidence, because the Stats page's *All checks* list is where the numbers
 * the old cards held now live (the owner's draft C). There is no `unknown` — a check
 * that could not run is a `problem`, since not being able to look is itself
 * something to fix.
 */
enum Severity: string
{
    case Ok = 'ok';
    case Warn = 'warn';
    case Problem = 'problem';

    public function rank(): int
    {
        return match ($this) {
            self::Ok => 0,
            self::Warn => 1,
            self::Problem => 2,
        };
    }

    public function label(): string
    {
        return match ($this) {
            self::Ok => 'OK',
            self::Warn => 'Warning',
            self::Problem => 'Problem',
        };
    }
}
