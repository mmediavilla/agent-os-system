<?php

namespace Tests\Feature\Deadlines;

use App\Models\Deadline;
use App\Models\Document;
use App\Services\Owner;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * Dates somebody must act on: what may be written, the order they come back
 * in, completion as a timestamp, and the link to a document that outlives it.
 */
class DeadlineApiTest extends TestCase
{
    use RefreshDatabase;

    private function makeDeadline(array $attrs = []): Deadline
    {
        return Deadline::create(array_merge([
            'title' => 'Renew visa',
            'due_on' => '2026-10-15',
            'kind' => 'renewal',
        ], $attrs));
    }

    // ── Writing a row ────────────────────────────────────────────────────────

    public function test_a_deadline_is_created_with_its_date_and_notes(): void
    {
        $this->postJson('/api/deadlines', [
            'title' => 'File the annual return',
            'due_on' => '2027-04-15',
            'kind' => 'filing',
            'notes' => 'BIR 1700.',
        ])
            ->assertCreated()
            ->assertJsonPath('title', 'File the annual return')
            // A bare date, never an instant with a `Z` the browser would read
            // as UTC and draw a day out.
            ->assertJsonPath('due_on', '2027-04-15')
            ->assertJsonPath('completed_at', null)
            ->assertJsonPath('document', null);

        $this->assertSame(Owner::id(), Deadline::first()->user_id);
    }

    public function test_a_title_a_date_and_a_kind_are_required(): void
    {
        $this->postJson('/api/deadlines', [])
            ->assertStatus(422)
            ->assertJsonValidationErrors(['title', 'due_on', 'kind']);
    }

    public function test_the_date_must_be_a_bare_date(): void
    {
        // An instant would be parsed on this UTC server and could land a day
        // out of the one the owner meant.
        $this->postJson('/api/deadlines', ['title' => 'x', 'kind' => 'other', 'due_on' => '2026-10-15T00:00:00+08:00'])
            ->assertStatus(422)
            ->assertJsonValidationErrors(['due_on']);
    }

    public function test_kind_is_free_text_rather_than_a_closed_set(): void
    {
        $this->postJson('/api/deadlines', ['title' => 'Vet', 'due_on' => '2026-11-01', 'kind' => 'booster'])
            ->assertCreated()
            ->assertJsonPath('kind', 'booster');
    }

    public function test_a_patch_writes_only_what_is_sent(): void
    {
        $deadline = $this->makeDeadline(['notes' => 'Bring photos.']);

        $this->patchJson("/api/deadlines/{$deadline->id}", ['due_on' => '2026-10-20'])
            ->assertOk()
            ->assertJsonPath('due_on', '2026-10-20')
            ->assertJsonPath('title', 'Renew visa')
            ->assertJsonPath('notes', 'Bring photos.');
    }

    public function test_a_patch_cannot_complete_a_deadline(): void
    {
        // Completion is its own route. An edit that could tick a row off would
        // do it the first time a form sent back everything it had loaded.
        $deadline = $this->makeDeadline();

        $this->patchJson("/api/deadlines/{$deadline->id}", ['completed_at' => '2026-09-27 10:00:00'])
            ->assertOk()
            ->assertJsonPath('completed_at', null);
    }

    public function test_a_deadline_is_deleted(): void
    {
        $deadline = $this->makeDeadline();

        $this->deleteJson("/api/deadlines/{$deadline->id}")->assertNoContent();

        $this->assertDatabaseMissing('deadlines', ['id' => $deadline->id]);
    }

    // ── The document it is about ─────────────────────────────────────────────

    public function test_a_deadline_may_point_at_a_document_and_names_it(): void
    {
        $policy = Document::create(['title' => 'Travel insurance', 'kind' => 'policy']);

        $this->postJson('/api/deadlines', [
            'title' => 'Renew travel insurance',
            'due_on' => '2027-01-03',
            'kind' => 'renewal',
            'document_id' => $policy->id,
        ])
            ->assertCreated()
            ->assertJsonPath('document.id', $policy->id)
            ->assertJsonPath('document.title', 'Travel insurance');
    }

    public function test_a_document_that_does_not_exist_is_refused(): void
    {
        $this->postJson('/api/deadlines', ['title' => 'x', 'due_on' => '2026-10-01', 'kind' => 'other', 'document_id' => 999])
            ->assertStatus(422)
            ->assertJsonValidationErrors(['document_id']);
    }

    public function test_the_link_can_be_cleared(): void
    {
        $policy = Document::create(['title' => 'Policy', 'kind' => 'policy']);
        $deadline = $this->makeDeadline(['document_id' => $policy->id]);

        $this->patchJson("/api/deadlines/{$deadline->id}", ['document_id' => null])
            ->assertOk()
            ->assertJsonPath('document_id', null)
            ->assertJsonPath('document', null);
    }

    public function test_deleting_the_document_leaves_the_deadline_standing(): void
    {
        // Losing the renewal date because the file went is the worse failure.
        $policy = Document::create(['title' => 'Policy', 'kind' => 'policy']);
        $deadline = $this->makeDeadline(['document_id' => $policy->id]);

        $this->deleteJson("/api/documents/{$policy->id}")->assertNoContent();

        $this->assertDatabaseHas('deadlines', ['id' => $deadline->id, 'document_id' => null]);
    }

    public function test_deleting_the_deadline_leaves_the_document_alone(): void
    {
        $policy = Document::create(['title' => 'Policy', 'kind' => 'policy']);
        $deadline = $this->makeDeadline(['document_id' => $policy->id]);

        $this->deleteJson("/api/deadlines/{$deadline->id}")->assertNoContent();

        $this->assertDatabaseHas('documents', ['id' => $policy->id]);
    }

    // ── Completion ───────────────────────────────────────────────────────────

    public function test_completing_stamps_the_time_and_keeps_the_row(): void
    {
        $this->travelTo('2026-09-27 02:00:00');
        $deadline = $this->makeDeadline();

        $this->postJson("/api/deadlines/{$deadline->id}/complete")
            ->assertOk()
            ->assertJsonPath('completed_at', '2026-09-27T02:00:00.000000Z');

        $this->assertDatabaseHas('deadlines', ['id' => $deadline->id]);
    }

    public function test_completing_twice_keeps_the_first_date(): void
    {
        $this->travelTo('2026-09-27 02:00:00');
        $deadline = $this->makeDeadline();
        $this->postJson("/api/deadlines/{$deadline->id}/complete")->assertOk();

        $this->travelTo('2026-09-29 02:00:00');

        $this->postJson("/api/deadlines/{$deadline->id}/complete")
            ->assertOk()
            ->assertJsonPath('completed_at', '2026-09-27T02:00:00.000000Z');
    }

    public function test_a_completed_deadline_can_be_opened_again(): void
    {
        $deadline = $this->makeDeadline();
        $this->postJson("/api/deadlines/{$deadline->id}/complete")->assertOk();

        $this->deleteJson("/api/deadlines/{$deadline->id}/complete")
            ->assertOk()
            ->assertJsonPath('completed_at', null);
    }

    // ── Reading the list ─────────────────────────────────────────────────────

    public function test_open_deadlines_come_first_soonest_due_then_completed_most_recent_first(): void
    {
        $later = $this->makeDeadline(['title' => 'Later', 'due_on' => '2026-12-01']);
        $overdue = $this->makeDeadline(['title' => 'Overdue', 'due_on' => '2026-09-01']);
        $soon = $this->makeDeadline(['title' => 'Soon', 'due_on' => '2026-10-01']);

        $this->travelTo('2026-09-10 00:00:00');
        $doneFirst = $this->makeDeadline(['title' => 'Done first', 'due_on' => '2026-09-05']);
        $this->postJson("/api/deadlines/{$doneFirst->id}/complete");

        $this->travelTo('2026-09-20 00:00:00');
        $doneLast = $this->makeDeadline(['title' => 'Done last', 'due_on' => '2026-08-01']);
        $this->postJson("/api/deadlines/{$doneLast->id}/complete");

        $this->getJson('/api/deadlines')
            ->assertOk()
            ->assertJsonPath('data.*.title', ['Overdue', 'Soon', 'Later', 'Done last', 'Done first'])
            ->assertJsonPath('meta.total', 5);
    }

    public function test_every_row_comes_back_unless_a_status_is_named(): void
    {
        // The catalog rule applied to a status: a default that hid completed
        // rows would silently shorten the one screen that shows them.
        $this->makeDeadline(['title' => 'Open']);
        $done = $this->makeDeadline(['title' => 'Done']);
        $this->postJson("/api/deadlines/{$done->id}/complete");

        $this->getJson('/api/deadlines')->assertJsonCount(2, 'data');
        $this->getJson('/api/deadlines?status=open')->assertJsonPath('data.*.title', ['Open']);
        $this->getJson('/api/deadlines?status=completed')->assertJsonPath('data.*.title', ['Done']);
        $this->getJson('/api/deadlines?status=all')->assertJsonCount(2, 'data');
    }

    public function test_an_unknown_status_is_refused(): void
    {
        $this->getJson('/api/deadlines?status=overdue')
            ->assertStatus(422)
            ->assertJsonValidationErrors(['status']);
    }

    public function test_search_and_kind_narrow_the_list(): void
    {
        $this->makeDeadline(['title' => 'Renew visa', 'kind' => 'renewal']);
        $this->makeDeadline(['title' => 'Pay premium', 'kind' => 'payment', 'notes' => 'Allianz']);

        $this->getJson('/api/deadlines?search=allianz')->assertJsonPath('data.*.title', ['Pay premium']);
        $this->getJson('/api/deadlines?kind=renewal')->assertJsonPath('data.*.title', ['Renew visa']);
    }

    public function test_pagination_is_opt_in(): void
    {
        foreach (range(1, 3) as $i) {
            $this->makeDeadline(['title' => "D{$i}", 'due_on' => "2026-10-0{$i}"]);
        }

        $this->getJson('/api/deadlines')
            ->assertJsonCount(3, 'data')
            ->assertJsonPath('meta.per_page', null);

        $this->getJson('/api/deadlines?per_page=2&page=2')
            ->assertJsonPath('data.*.title', ['D3'])
            ->assertJsonPath('meta.last_page', 2);
    }
}
