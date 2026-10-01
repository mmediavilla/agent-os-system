<?php

namespace Tests\Feature\Documents;

use App\Models\Document;
use App\Services\Owner;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * The filing cabinet's rows: what may be written, what comes back, and the
 * pagination rule the catalogs already follow.
 */
class DocumentApiTest extends TestCase
{
    use RefreshDatabase;

    private function makeDocument(array $attrs = []): Document
    {
        return Document::create(array_merge([
            'title' => 'Passport',
            'kind' => 'passport',
        ], $attrs));
    }

    // ── Writing a row ────────────────────────────────────────────────────────

    public function test_a_document_is_created_with_its_dates_and_notes(): void
    {
        $this->postJson('/api/documents', [
            'title' => 'Travel insurance',
            'kind' => 'policy',
            'issued_on' => '2026-01-04',
            'expires_on' => '2027-01-03',
            'notes' => 'Allianz, policy 88213.',
        ])
            ->assertCreated()
            ->assertJsonPath('title', 'Travel insurance')
            ->assertJsonPath('issued_on', '2026-01-04')
            ->assertJsonPath('expires_on', '2027-01-03')
            // Nothing uploaded yet, which is a state and not an error.
            ->assertJsonPath('file_url', null);

        $this->assertDatabaseHas('documents', ['title' => 'Travel insurance', 'kind' => 'policy']);
    }

    public function test_a_new_document_belongs_to_the_owner_without_being_told_to(): void
    {
        $this->postJson('/api/documents', ['title' => 'Lease', 'kind' => 'contract'])->assertCreated();

        $this->assertSame(Owner::id(), Document::first()->user_id);
    }

    public function test_the_dates_and_the_notes_are_optional(): void
    {
        // A receipt has no expiry, and a passport found in a drawer may have
        // neither date to hand.
        $this->postJson('/api/documents', ['title' => 'Gym receipt', 'kind' => 'receipt'])
            ->assertCreated()
            ->assertJsonPath('issued_on', null)
            ->assertJsonPath('expires_on', null);
    }

    public function test_a_title_and_a_kind_are_required(): void
    {
        $this->postJson('/api/documents', [])
            ->assertStatus(422)
            ->assertJsonValidationErrors(['title', 'kind']);
    }

    public function test_kind_is_free_text_rather_than_a_closed_set(): void
    {
        // The suggested vocabulary is the form's, not a constraint — whatever
        // this year brings has to be fileable without a migration.
        $this->postJson('/api/documents', ['title' => 'BIR 2316', 'kind' => 'tax slip'])
            ->assertCreated()
            ->assertJsonPath('kind', 'tax slip');
    }

    public function test_a_date_that_is_not_a_date_is_refused(): void
    {
        $this->postJson('/api/documents', ['title' => 'Visa', 'kind' => 'visa', 'expires_on' => 'soon'])
            ->assertStatus(422)
            ->assertJsonValidationErrors('expires_on');
    }

    // ── Changing one ─────────────────────────────────────────────────────────

    public function test_a_patch_may_send_one_field(): void
    {
        $document = $this->makeDocument(['notes' => 'In the safe.']);

        $this->patchJson("/api/documents/{$document->id}", ['title' => 'Passport (renewed)'])
            ->assertOk()
            ->assertJsonPath('title', 'Passport (renewed)')
            // Untouched rather than cleared: a partial write is partial.
            ->assertJsonPath('notes', 'In the safe.');
    }

    public function test_a_field_that_is_sent_is_still_fully_validated(): void
    {
        $document = $this->makeDocument();

        $this->patchJson("/api/documents/{$document->id}", ['title' => ''])
            ->assertStatus(422)
            ->assertJsonValidationErrors('title');
    }

    public function test_the_file_columns_cannot_be_written_as_fields(): void
    {
        $document = $this->makeDocument();

        // They belong to DocumentStore. A row pointed at a path nothing checked
        // would be streamed back later under a type nobody verified.
        $this->patchJson("/api/documents/{$document->id}", [
            'file_path' => 'documents/anything.pdf',
            'mime' => 'application/pdf',
        ])->assertOk();

        $this->assertNull($document->fresh()->file_path);
    }

    public function test_a_document_is_deleted(): void
    {
        $document = $this->makeDocument();

        $this->deleteJson("/api/documents/{$document->id}")->assertNoContent();

        $this->assertDatabaseCount('documents', 0);
    }

    // ── Reading the list ─────────────────────────────────────────────────────

    public function test_the_index_is_ordered_by_kind_then_title(): void
    {
        $this->makeDocument(['title' => 'Visa', 'kind' => 'visa']);
        $this->makeDocument(['title' => 'Renters', 'kind' => 'policy']);
        $this->makeDocument(['title' => 'Health', 'kind' => 'policy']);

        $this->getJson('/api/documents')
            ->assertOk()
            ->assertJsonPath('data.0.title', 'Health')
            ->assertJsonPath('data.1.title', 'Renters')
            ->assertJsonPath('data.2.title', 'Visa');
    }

    public function test_the_whole_set_comes_back_when_no_page_size_is_named(): void
    {
        for ($i = 0; $i < 30; $i++) {
            $this->makeDocument(['title' => "Receipt {$i}", 'kind' => 'receipt']);
        }

        $this->getJson('/api/documents')
            ->assertOk()
            ->assertJsonCount(30, 'data')
            // `meta` is reported either way; there is no page size to name.
            ->assertJsonPath('meta.per_page', null)
            ->assertJsonPath('meta.total', 30);
    }

    public function test_a_page_is_served_when_one_is_asked_for(): void
    {
        for ($i = 0; $i < 30; $i++) {
            $this->makeDocument(['title' => "Receipt {$i}", 'kind' => 'receipt']);
        }

        $this->getJson('/api/documents?per_page=10&page=2')
            ->assertOk()
            ->assertJsonCount(10, 'data')
            ->assertJsonPath('meta.page', 2)
            ->assertJsonPath('meta.last_page', 3);
    }

    public function test_search_looks_in_the_title_the_kind_and_the_notes(): void
    {
        $this->makeDocument(['title' => 'Health cover', 'kind' => 'policy', 'notes' => 'Maxicare']);
        $this->makeDocument(['title' => 'Passport', 'kind' => 'passport']);

        // The notes are where "the Maxicare one" lives, which is how a person
        // looks for a document whose title they cannot remember.
        $this->getJson('/api/documents?search=maxicare')
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.title', 'Health cover');

        $this->getJson('/api/documents?search=pass')
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.title', 'Passport');
    }

    public function test_search_treats_a_wildcard_as_a_character(): void
    {
        $this->makeDocument(['title' => '100% bonus letter', 'kind' => 'other']);
        $this->makeDocument(['title' => 'Passport', 'kind' => 'passport']);

        $this->getJson('/api/documents?search=100%25')
            ->assertOk()
            ->assertJsonCount(1, 'data');
    }

    public function test_a_search_and_a_filter_narrow_together(): void
    {
        // The search is one grouped condition, so its ORs cannot escape the
        // filter that ran before it and hand back the whole table.
        $this->makeDocument(['title' => 'Health cover', 'kind' => 'policy']);
        $this->makeDocument(['title' => 'Health declaration', 'kind' => 'form']);

        $this->getJson('/api/documents?kind=policy&search=health')
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.kind', 'policy');
    }

    public function test_the_list_filters_by_kind(): void
    {
        $this->makeDocument(['title' => 'Health cover', 'kind' => 'policy']);
        $this->makeDocument(['title' => 'Passport', 'kind' => 'passport']);

        $this->getJson('/api/documents?kind=policy')
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.kind', 'policy');
    }

    public function test_a_blank_filter_is_no_filter(): void
    {
        $this->makeDocument();

        $this->getJson('/api/documents?kind=&search=')
            ->assertOk()
            ->assertJsonCount(1, 'data');
    }

    public function test_the_disk_path_never_leaves_the_server(): void
    {
        $this->makeDocument();

        $this->getJson('/api/documents')
            ->assertOk()
            ->assertJsonMissingPath('data.0.file_path');
    }
}
