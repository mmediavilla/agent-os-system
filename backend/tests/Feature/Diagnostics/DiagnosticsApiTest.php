<?php

namespace Tests\Feature\Diagnostics;

use App\Http\Controllers\DiagnosticsController;
use App\Models\DiagnosticReport;
use App\Services\Diagnostics\Diagnoser;
use App\Services\Diagnostics\Report;
use App\Services\Diagnostics\ReportStore;
use App\Services\Owner;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Process;
use Illuminate\Support\Facades\Storage;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

class DiagnosticsApiTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        Storage::fake();
        Http::fake(['*' => Http::response('ok', 200)]);
        Process::fake();
    }

    #[Test]
    public function a_checkout_that_has_never_diagnosed_reads_not_yet_run(): void
    {
        $this->getJson('/api/diagnostics')
            ->assertOk()
            // Null, never an empty report — which would read as a clean bill.
            ->assertJsonPath('latest', null)
            ->assertJsonPath('reports', [])
            ->assertJsonPath('groups.0', ['key' => 'database', 'title' => 'Database']);
    }

    #[Test]
    public function a_run_stores_the_report_and_its_file_and_answers_with_the_page(): void
    {
        $response = $this->postJson('/api/diagnostics/run')->assertCreated();

        $report = DiagnosticReport::sole();

        $response
            ->assertJsonPath('latest.id', $report->id)
            ->assertJsonPath('latest.kind', 'diagnose')
            ->assertJsonPath('latest.source', 'ui')
            ->assertJsonPath('latest.findings.0.key', 'database.reachable')
            ->assertJsonCount(1, 'reports')
            ->assertJsonStructure(['latest' => ['verdict', 'counts' => ['problems', 'warnings', 'passed', 'total'], 'file_url', 'findings' => [['key', 'group', 'title', 'severity', 'detail', 'evidence', 'fix', 'manual']]]]);

        $this->assertSame(Owner::id(), $report->user_id);
        Storage::assertExists($report->path);
        $this->assertSame($report->markdown, Storage::get($report->path));
        $this->assertSame(count($response->json('latest.findings')), $response->json('latest.counts.total'));
        $this->assertFalse(Cache::has(DiagnosticsController::CLAIM_KEY), 'The claim outlived the run.');
    }

    #[Test]
    public function a_second_press_while_one_runs_is_refused_with_a_sentence(): void
    {
        Cache::add(DiagnosticsController::CLAIM_KEY, true, 60);

        $this->postJson('/api/diagnostics/run')
            ->assertStatus(409)
            ->assertJsonPath('message', fn (string $m) => str_contains($m, 'already running'));

        $this->assertSame(0, DiagnosticReport::count());
    }

    #[Test]
    public function the_newest_report_is_shown_whatever_wrote_it(): void
    {
        ReportStore::save(app(Diagnoser::class)->run(Report::SOURCE_UI));
        $this->travel(1)->minutes();
        $cli = ReportStore::save(app(Diagnoser::class)->run(Report::SOURCE_CLI));

        $this->getJson('/api/diagnostics')
            ->assertJsonPath('latest.id', $cli->id)
            ->assertJsonPath('latest.source', 'cli')
            ->assertJsonCount(2, 'reports')
            ->assertJsonMissingPath('reports.0.findings');
    }

    #[Test]
    public function only_the_newest_twenty_are_kept_and_their_files_go_with_them(): void
    {
        config(['diagnostics.retention' => 3]);

        $first = ReportStore::save(app(Diagnoser::class)->run(Report::SOURCE_CLI));

        foreach (range(1, 3) as $i) {
            $this->travel(1)->minutes();
            ReportStore::save(app(Diagnoser::class)->run(Report::SOURCE_CLI));
        }

        $this->assertSame(3, DiagnosticReport::count());
        $this->assertNull(DiagnosticReport::find($first->id));
        Storage::assertMissing($first->path);
        $this->assertCount(3, Storage::files(ReportStore::DIRECTORY));
    }

    #[Test]
    public function the_md_downloads_through_its_signed_url_and_not_without_it(): void
    {
        $url = $this->postJson('/api/diagnostics/run')->json('latest.file_url');
        $report = DiagnosticReport::sole();

        $response = $this->get($url)->assertOk();
        $this->assertStringStartsWith('text/markdown', $response->headers->get('Content-Type'));
        $this->assertStringContainsString('attachment', $response->headers->get('Content-Disposition'));
        $this->assertStringContainsString('immutable', $response->headers->get('Cache-Control'));
        $this->assertSame($report->markdown, $response->streamedContent());

        $this->get("/api/diagnostics/{$report->id}/file")->assertForbidden();
    }

    #[Test]
    public function diagnose_prints_the_report_saves_it_and_exits_on_a_problem(): void
    {
        // `:memory:` is never in WAL, so this suite always has a problem to report.
        $this->assertSame(1, Artisan::call('diagnose'));
        $printed = Artisan::output();
        $this->assertStringContainsString('## All checks', $printed);
        $this->assertStringContainsString('`database.journal_mode`', $printed);
        $this->assertSame('cli', DiagnosticReport::sole()->source);

        $this->assertSame(1, Artisan::call('diagnose', ['--no-save' => true, '--json' => true]));
        $this->assertSame('database.reachable', json_decode(Artisan::output(), true)['findings'][0]['key']);
        $this->assertSame(1, DiagnosticReport::count());
    }
}
