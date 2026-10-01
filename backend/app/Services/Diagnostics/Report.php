<?php

namespace App\Services\Diagnostics;

use Carbon\CarbonImmutable;

/**
 * One diagnose run: when, and every finding in check order.
 *
 * This is the one structure both renderings are drawn from — `MarkdownReport`
 * for the `.md`, and the Stats page from its JSON — so the file and the screen
 * cannot disagree about what was found.
 *
 * A troubleshoot run is the same structure: the findings are the state after
 * its fixes, and `outcomes` says what each one did.
 */
final class Report
{
    public const KIND_DIAGNOSE = 'diagnose';

    public const KIND_TROUBLESHOOT = 'troubleshoot';

    public const KINDS = [self::KIND_DIAGNOSE, self::KIND_TROUBLESHOOT];

    public const SOURCE_UI = 'ui';

    public const SOURCE_CLI = 'cli';

    /**
     * No `assistant` source: the assistant is what a diagnosis is most often
     * about, so it is never the one that runs it (CLAUDE.md, *Diagnostics*).
     */
    public const SOURCES = [self::SOURCE_UI, self::SOURCE_CLI];

    /**
     * @param  list<Finding>  $findings  every check, in order — after the fixes, on a troubleshoot
     * @param  list<FixOutcome>  $outcomes  what Troubleshoot did; empty on a diagnosis
     */
    public function __construct(
        public readonly string $kind,
        public readonly string $source,
        public readonly CarbonImmutable $ranAt,
        public readonly array $findings,
        public readonly array $outcomes = [],
    ) {}

    public function count(Severity $severity): int
    {
        return count(array_filter($this->findings, fn (Finding $f) => $f->severity === $severity));
    }

    /**
     * What needs attention, worst first, in check order within a severity.
     *
     * @return list<Finding>
     */
    public function attention(): array
    {
        $order = array_flip(array_map(fn (Finding $f) => $f->key, $this->findings));
        $flagged = array_values(array_filter($this->findings, fn (Finding $f) => $f->severity !== Severity::Ok));

        usort($flagged, fn (Finding $a, Finding $b) => [$b->severity->rank(), $order[$a->key]] <=> [$a->severity->rank(), $order[$b->key]]);

        return $flagged;
    }

    /** "2 problems, 1 warning · 31 checks" — the verdict line, once. */
    public function verdict(): string
    {
        $problems = $this->count(Severity::Problem);
        $warnings = $this->count(Severity::Warn);

        $parts = [];
        if ($problems > 0) {
            $parts[] = $problems.' '.($problems === 1 ? 'problem' : 'problems');
        }
        if ($warnings > 0) {
            $parts[] = $warnings.' '.($warnings === 1 ? 'warning' : 'warnings');
        }

        $head = $parts === [] ? 'Nothing wrong' : implode(', ', $parts);

        return $head.' · '.count($this->findings).' checks';
    }
}
