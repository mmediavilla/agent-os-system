<?php

namespace Tests\Feature\Deadlines;

use App\Agent\ToolRegistry;
use App\Agent\Tools\ListDeadlines;
use App\Models\Deadline;
use App\Models\Document;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Validation\ValidationException;
use Tests\TestCase;

/**
 * `list_deadlines` — the assistant's read over what is due.
 *
 * What the tests below are really about is the arithmetic: the server counts
 * the days, on the owner's clock, so the model never has to.
 */
class ListDeadlinesToolTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        config(['agent.timezone' => 'Asia/Manila']);
    }

    private function tool(): ListDeadlines
    {
        return app(ListDeadlines::class);
    }

    private function makeDeadline(array $attrs = []): Deadline
    {
        return Deadline::create(array_merge([
            'title' => 'Renew visa',
            'due_on' => '2026-10-15',
            'kind' => 'renewal',
        ], $attrs));
    }

    public function test_it_is_registered_and_reads(): void
    {
        $registry = app(ToolRegistry::class);

        $this->assertTrue($registry->has('list_deadlines'));
        $this->assertFalse($registry->isMutating('list_deadlines'));
        // A read, so the spoken assistant has it too, with no wiring of its own.
        $this->assertTrue($registry->readOnly()->has('list_deadlines'));
    }

    public function test_it_counts_the_days_from_today_on_the_owners_clock(): void
    {
        // 20:00 UTC on the 26th is 04:00 on the 27th in Manila. Counted on the
        // server's clock, a deadline on the 27th would be "tomorrow".
        $this->travelTo('2026-09-26 20:00:00');

        $this->makeDeadline(['title' => 'Overdue', 'due_on' => '2026-09-24']);
        $this->makeDeadline(['title' => 'Today', 'due_on' => '2026-09-27']);
        $this->makeDeadline(['title' => 'Soon', 'due_on' => '2026-10-07']);

        $result = $this->tool()->handle([]);

        $this->assertSame('2026-09-27', $result['today']);
        $this->assertSame(
            ['Overdue' => -3, 'Today' => 0, 'Soon' => 10],
            array_column($result['deadlines'], 'days_until', 'title'),
        );
    }

    public function test_it_returns_the_record_and_names_the_document(): void
    {
        $this->travelTo('2026-10-01 01:00:00');
        $policy = Document::create(['title' => 'Travel insurance', 'kind' => 'policy', 'notes' => 'Allianz']);
        $this->makeDeadline([
            'title' => 'Renew travel insurance',
            'due_on' => '2026-10-11',
            'notes' => 'Compare quotes first.',
            'document_id' => $policy->id,
        ]);

        $row = $this->tool()->handle([])['deadlines'][0];

        $this->assertSame([
            'id' => Deadline::first()->id,
            'title' => 'Renew travel insurance',
            'kind' => 'renewal',
            'due_on' => '2026-10-11',
            'days_until' => 10,
            'notes' => 'Compare quotes first.',
            // The document's name and kind, never its notes or a signed URL —
            // search_documents has the record, and a live credential does not
            // belong in a transcript re-sent on every turn.
            'document' => ['id' => $policy->id, 'title' => 'Travel insurance', 'kind' => 'policy'],
        ], $row);
    }

    public function test_open_is_the_default_and_completed_rows_carry_the_day_they_were_done(): void
    {
        $this->makeDeadline(['title' => 'Still to do']);
        $done = $this->makeDeadline(['title' => 'Done']);

        // 17:00 UTC on the 26th is the 27th in Manila — the day it was done
        // where the owner was, not where the server is.
        $this->travelTo('2026-09-26 17:00:00');
        $done->forceFill(['completed_at' => now()])->save();

        $this->assertSame(['Still to do'], array_column($this->tool()->handle([])['deadlines'], 'title'));

        $completed = $this->tool()->handle(['status' => 'completed'])['deadlines'];
        $this->assertSame(['Done'], array_column($completed, 'title'));
        $this->assertSame('2026-09-27', $completed[0]['completed_on']);

        $this->assertCount(2, $this->tool()->handle(['status' => 'all'])['deadlines']);
    }

    public function test_within_days_is_a_horizon_that_always_includes_what_is_overdue(): void
    {
        $this->travelTo('2026-09-27 01:00:00');
        $this->makeDeadline(['title' => 'Overdue', 'due_on' => '2026-08-01']);
        $this->makeDeadline(['title' => 'Edge', 'due_on' => '2026-10-11']);
        $this->makeDeadline(['title' => 'Past the edge', 'due_on' => '2026-10-12']);

        $result = $this->tool()->handle(['within_days' => 14]);

        $this->assertSame(['Overdue', 'Edge'], array_column($result['deadlines'], 'title'));
        $this->assertSame(2, $result['total_matching']);
    }

    public function test_search_kind_and_limit_narrow_it(): void
    {
        $this->makeDeadline(['title' => 'Renew visa', 'due_on' => '2026-10-01']);
        $this->makeDeadline(['title' => 'Pay premium', 'kind' => 'payment', 'due_on' => '2026-10-02']);
        $this->makeDeadline(['title' => 'Renew licence', 'due_on' => '2026-10-03']);

        $this->assertSame(['Pay premium'], array_column($this->tool()->handle(['kind' => 'payment'])['deadlines'], 'title'));
        $this->assertSame(['Renew licence'], array_column($this->tool()->handle(['search' => 'licence'])['deadlines'], 'title'));

        $limited = $this->tool()->handle(['limit' => 1]);
        $this->assertSame(['Renew visa'], array_column($limited['deadlines'], 'title'));
        // The total says how many there were, so the model cannot mistake the
        // first page for the whole list.
        $this->assertSame(3, $limited['total_matching']);
    }

    public function test_a_bad_status_is_an_error_the_model_can_correct(): void
    {
        $this->expectException(ValidationException::class);

        $this->tool()->handle(['status' => 'overdue']);
    }

    public function test_the_schema_offers_exactly_the_statuses_it_accepts(): void
    {
        $schema = $this->tool()->schema();

        $this->assertSame(Deadline::STATUSES, $schema['input_schema']['properties']['status']['enum']);
    }
}
