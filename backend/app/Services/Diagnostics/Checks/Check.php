<?php

namespace App\Services\Diagnostics\Checks;

use App\Services\Diagnostics\Finding;
use App\Services\Diagnostics\Severity;
use App\Services\Diagnostics\SoftFix;

/**
 * One group of checks — the database, the queue, the calendars — and the
 * findings it returns.
 *
 * **A group, not a check per class**, because the checks inside one share
 * their reading: the database's journal mode, busy timeout and file sizes are
 * one connection's answers, and the calendars are one finding per feed. The
 * finding is the unit the page and the report draw; the class is the unit that
 * reads something once.
 *
 * Every check is free and read-only, none calls a model, and none may depend on
 * a request — `php artisan diagnose` is the path that works when the HUD will
 * not load. A group that throws is caught by `Diagnoser` and reported as a
 * problem of its own, so one broken reading never costs the rest of the report.
 */
abstract class Check
{
    /** The prefix of every key this group writes, and what the page groups by. */
    abstract public static function group(): string;

    /** What the group is called on the page and in the `.md`. */
    abstract public static function title(): string;

    /**
     * @return list<Finding>
     */
    abstract public function run(): array;

    /**
     * @param  list<string>  $evidence
     */
    protected function ok(string $key, string $title, string $detail, array $evidence = []): Finding
    {
        return $this->finding($key, $title, Severity::Ok, $detail, $evidence);
    }

    /**
     * @param  list<string>  $evidence
     */
    protected function warn(string $key, string $title, string $detail, array $evidence = [], ?SoftFix $fix = null, ?string $manual = null): Finding
    {
        return $this->finding($key, $title, Severity::Warn, $detail, $evidence, $fix, $manual);
    }

    /**
     * @param  list<string>  $evidence
     */
    protected function problem(string $key, string $title, string $detail, array $evidence = [], ?SoftFix $fix = null, ?string $manual = null): Finding
    {
        return $this->finding($key, $title, Severity::Problem, $detail, $evidence, $fix, $manual);
    }

    /**
     * @param  list<string>  $evidence
     */
    private function finding(string $key, string $title, Severity $severity, string $detail, array $evidence, ?SoftFix $fix = null, ?string $manual = null): Finding
    {
        return new Finding(
            key: static::group().'.'.$key,
            group: static::group(),
            title: $title,
            severity: $severity,
            detail: $detail,
            evidence: array_values($evidence),
            fix: $fix,
            manual: $manual,
        );
    }
}
