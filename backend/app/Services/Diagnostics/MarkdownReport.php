<?php

namespace App\Services\Diagnostics;

/**
 * The `.md` rendering of a `Report` — the copy handed to someone.
 *
 * **One structure, two renderings.** The Stats page draws the same findings
 * from their JSON, natively, so the screen needs no markdown parser and cannot
 * disagree with the file. Every finding's key appears in *All checks*, in
 * report order; `MarkdownReportTest` holds the two to that.
 */
final class MarkdownReport
{
    private const SOURCES = [
        Report::SOURCE_UI => 'the Stats page',
        Report::SOURCE_CLI => 'php artisan diagnose',
    ];

    private const OUTCOMES = [
        FixOutcome::DONE => 'Done',
        FixOutcome::FAILED => 'Failed',
        FixOutcome::SKIPPED => 'Skipped',
    ];

    public static function render(Report $report): string
    {
        $groups = Diagnoser::groups();
        $zone = (string) config('agent.timezone', 'UTC');
        $when = $report->ranAt->setTimezone($zone)->format('Y-m-d H:i');
        $troubleshoot = $report->kind === Report::KIND_TROUBLESHOOT;
        $kind = $troubleshoot ? 'Troubleshoot' : 'Diagnosis';
        $source = $troubleshoot && $report->source === Report::SOURCE_CLI
            ? 'php artisan troubleshoot'
            : (self::SOURCES[$report->source] ?? $report->source);

        $lines = [
            "# ProjectMC — {$kind}",
            '',
            "**{$report->verdict()}** · {$when} ({$zone}) · from {$source}",
            '',
        ];

        if ($troubleshoot) {
            $lines[] = '## What Troubleshoot did';
            $lines[] = '';

            if ($report->outcomes === []) {
                $lines[] = 'Nothing: no fix was confirmed.';
            }

            foreach ($report->outcomes as $outcome) {
                $lines[] = '- **'.self::OUTCOMES[$outcome->status].'** · '.$outcome->fix->label().' '.self::line($outcome->detail)." `{$outcome->fix->value}`";
            }

            $lines[] = '';
            $lines[] = 'Everything below is the state after these ran.';
            $lines[] = '';
        }

        $lines[] = '## Needs attention';
        $lines[] = '';

        $attention = $report->attention();

        if ($attention === []) {
            $lines[] = 'Nothing. Every check passed.';
            $lines[] = '';
        }

        foreach ($attention as $finding) {
            $lines[] = "### {$finding->severity->label()}: {$finding->title}";
            $lines[] = '';
            $lines[] = self::line($finding->detail);
            $lines[] = '';

            foreach ($finding->evidence as $item) {
                $lines[] = '- '.self::line($item);
            }

            if ($finding->evidence !== []) {
                $lines[] = '';
            }

            if ($finding->fix !== null) {
                $lines[] = "**Soft fix:** {$finding->fix->label()}";
                $lines[] = '';
            }

            if ($finding->manual !== null) {
                $lines[] = '**Needs you:** '.self::line($finding->manual);
                $lines[] = '';
            }
        }

        $lines[] = '## All checks';
        $lines[] = '';

        $group = null;

        foreach ($report->findings as $finding) {
            if ($finding->group !== $group) {
                if ($group !== null) {
                    $lines[] = '';
                }

                $group = $finding->group;
                $lines[] = '### '.($groups[$group] ?? $group);
                $lines[] = '';
            }

            $evidence = $finding->evidence === [] ? '' : ' — '.self::line(implode('; ', $finding->evidence));
            $lines[] = "- **{$finding->severity->label()}** · {$finding->title}{$evidence} `{$finding->key}`";
        }

        $lines[] = '';
        $lines[] = '---';
        $lines[] = '';
        $lines[] = 'A soft fix is one of the closed set Troubleshoot may apply. A *Needs you* step changes code, configuration or the machine itself, so nothing in the app runs it for you.';
        $lines[] = '';

        return implode("\n", $lines);
    }

    /** One line of prose: no stray newlines to break a list item. */
    private static function line(string $text): string
    {
        return trim(preg_replace('/\s*\R\s*/', ' ', $text) ?? $text);
    }
}
