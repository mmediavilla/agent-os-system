<?php

namespace Tests\Unit\Diagnostics;

use App\Services\Diagnostics\Finding;
use App\Services\Diagnostics\MarkdownReport;
use App\Services\Diagnostics\Report;
use App\Services\Diagnostics\Severity;
use App\Services\Diagnostics\SoftFix;
use Carbon\CarbonImmutable;
use InvalidArgumentException;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

/**
 * One structure, two renderings: the `.md` and the page's JSON must name the
 * same findings in the same order, or the file handed to someone and the screen
 * disagree about what was found.
 */
class MarkdownReportTest extends TestCase
{
    #[Test]
    public function the_md_and_the_json_name_the_same_findings_in_the_same_order(): void
    {
        $report = $this->report();

        preg_match_all('/`([a-z_]+\.[a-z0-9_]+)`$/m', MarkdownReport::render($report), $matches);

        $this->assertSame(
            array_column(array_map(fn (Finding $f) => $f->toArray(), $report->findings), 'key'),
            $matches[1],
        );
    }

    #[Test]
    public function attention_is_worst_first_and_says_what_to_do(): void
    {
        $md = MarkdownReport::render($this->report());

        $problem = strpos($md, '### Problem: Queue worker heartbeat');
        $warning = strpos($md, '### Warning: Failed jobs');

        $this->assertNotFalse($problem);
        $this->assertLessThan($warning, $problem);
        $this->assertStringContainsString('**Soft fix:** '.SoftFix::RestartQueueWorker->label(), $md);
        $this->assertStringContainsString('**Needs you:** Delete the log.', $md);
        $this->assertStringContainsString('**1 problem, 1 warning · 3 checks**', $md);
    }

    #[Test]
    public function a_clean_report_says_so(): void
    {
        $report = new Report('diagnose', 'ui', CarbonImmutable::now(), [
            new Finding('database.reachable', 'database', 'Database reachable', Severity::Ok, 'Answered.', ['latency: 1 ms']),
        ]);

        $this->assertStringContainsString('Nothing. Every check passed.', MarkdownReport::render($report));
        $this->assertSame('Nothing wrong · 1 checks', $report->verdict());
    }

    #[Test]
    public function a_finding_offers_one_way_forward_and_a_pass_offers_none(): void
    {
        $this->expectException(InvalidArgumentException::class);

        new Finding('queue.heartbeat', 'queue', 'x', Severity::Problem, 'x', [], SoftFix::RestartQueueWorker, 'do it yourself');
    }

    #[Test]
    public function a_stored_finding_survives_the_round_trip_and_an_unknown_fix_is_dropped(): void
    {
        $finding = new Finding('queue.heartbeat', 'queue', 'Heartbeat', Severity::Problem, 'Dead.', ['age: 4m'], SoftFix::RestartQueueWorker);

        $this->assertEquals($finding, Finding::fromArray($finding->toArray()));

        $renamed = ['fix' => ['key' => 'reboot_the_universe', 'label' => '?']] + $finding->toArray();
        $this->assertNull(Finding::fromArray($renamed)->fix);
    }

    private function report(): Report
    {
        return new Report('diagnose', 'cli', CarbonImmutable::parse('2026-09-28T06:30:00Z'), [
            new Finding('queue.heartbeat', 'queue', 'Queue worker heartbeat', Severity::Problem, 'Dead.', ['last beat: 12m ago'], SoftFix::RestartQueueWorker),
            new Finding('queue.failed_jobs', 'queue', 'Failed jobs', Severity::Warn, 'Two failed.', ['failed: 2'], manual: 'Delete the log.'),
            new Finding('storage.log', 'storage', 'Application log', Severity::Ok, 'Fine.', ['laravel.log: 1 MB']),
        ]);
    }
}
