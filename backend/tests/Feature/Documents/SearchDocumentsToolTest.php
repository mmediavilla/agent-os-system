<?php

namespace Tests\Feature\Documents;

use App\Agent\ToolRegistry;
use App\Agent\Tools\SearchDocuments;
use App\Models\Document;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Validation\ValidationException;
use Tests\TestCase;

/**
 * `search_documents` — the assistant's read over the filing cabinet.
 *
 * The rule the tests below are really about is the one in the description: the
 * assistant is handed a document's *metadata* and never its contents.
 */
class SearchDocumentsToolTest extends TestCase
{
    use RefreshDatabase;

    private function tool(): SearchDocuments
    {
        return app(SearchDocuments::class);
    }

    private function makeDocument(array $attrs = []): Document
    {
        return Document::create(array_merge([
            'title' => 'Passport',
            'kind' => 'passport',
        ], $attrs));
    }

    public function test_it_is_registered_and_reads(): void
    {
        $registry = app(ToolRegistry::class);

        $this->assertTrue($registry->has('search_documents'));
        $this->assertFalse($registry->isMutating('search_documents'));
        // A read, so the spoken assistant has it as well, with no wiring of
        // its own.
        $this->assertTrue($registry->readOnly()->has('search_documents'));
    }

    public function test_it_returns_the_record_and_never_the_contents(): void
    {
        $this->makeDocument([
            'title' => 'Travel insurance',
            'kind' => 'policy',
            'issued_on' => '2026-01-04',
            'expires_on' => '2027-01-03',
            'notes' => 'Allianz, policy 88213.',
        ]);

        $result = $this->tool()->handle([]);

        $this->assertSame(1, $result['total_matching']);
        $this->assertSame([
            'id' => Document::first()->id,
            'title' => 'Travel insurance',
            'kind' => 'policy',
            'issued_on' => '2026-01-04',
            'expires_on' => '2027-01-03',
            'notes' => 'Allianz, policy 88213.',
            'file_on_record' => false,
        ], $result['documents'][0]);
    }

    public function test_a_signed_url_is_never_handed_to_the_model(): void
    {
        // It is a live credential, and a tool result is re-sent with the
        // transcript on every later turn.
        $document = $this->makeDocument();
        $document->forceFill(['file_path' => 'documents/x.pdf', 'mime' => 'application/pdf'])->save();

        $row = $this->tool()->handle([])['documents'][0];

        $this->assertTrue($row['file_on_record']);
        $this->assertArrayNotHasKey('file_url', $row);
        $this->assertArrayNotHasKey('file_path', $row);
    }

    public function test_whether_there_is_a_file_is_always_said_either_way(): void
    {
        // Absent, the model would assume there is something to open.
        $this->makeDocument();

        $this->assertArrayHasKey('file_on_record', $this->tool()->handle([])['documents'][0]);
    }

    public function test_it_searches_the_title_the_kind_and_the_notes(): void
    {
        $this->makeDocument(['title' => 'Health cover', 'kind' => 'policy', 'notes' => 'Maxicare']);
        $this->makeDocument(['title' => 'Passport', 'kind' => 'passport']);

        $this->assertSame(1, $this->tool()->handle(['search' => 'maxicare'])['total_matching']);
        $this->assertSame(1, $this->tool()->handle(['search' => 'passport'])['total_matching']);
    }

    public function test_it_filters_by_kind(): void
    {
        $this->makeDocument(['title' => 'Health cover', 'kind' => 'policy']);
        $this->makeDocument();

        $result = $this->tool()->handle(['kind' => 'policy']);

        $this->assertSame(1, $result['total_matching']);
        $this->assertSame('Health cover', $result['documents'][0]['title']);
    }

    public function test_expiring_returns_dated_documents_soonest_first(): void
    {
        $this->makeDocument(['title' => 'Visa', 'kind' => 'visa', 'expires_on' => '2027-06-01']);
        $this->makeDocument(['title' => 'Health cover', 'kind' => 'policy', 'expires_on' => '2026-11-30']);
        $this->makeDocument(['title' => 'Gym receipt', 'kind' => 'receipt']);

        $result = $this->tool()->handle(['expiring' => true]);

        $this->assertSame(2, $result['total_matching']);
        $this->assertSame(['Health cover', 'Visa'], array_column($result['documents'], 'title'));
    }

    public function test_an_already_expired_document_still_comes_back(): void
    {
        // "Expiring" is the question "what has a date on it", and the answer to
        // "is my passport still valid" is the row that says it lapsed.
        $this->makeDocument(['expires_on' => '2020-01-01']);

        $this->assertSame(1, $this->tool()->handle(['expiring' => true])['total_matching']);
    }

    public function test_total_matching_counts_past_the_limit(): void
    {
        for ($i = 0; $i < 5; $i++) {
            $this->makeDocument(['title' => "Receipt {$i}", 'kind' => 'receipt']);
        }

        $result = $this->tool()->handle(['limit' => 2]);

        $this->assertCount(2, $result['documents']);
        $this->assertSame(5, $result['total_matching']);
    }

    public function test_bad_arguments_are_a_validation_error_the_model_can_correct(): void
    {
        $this->expectException(ValidationException::class);

        $this->tool()->handle(['search' => ['not', 'a', 'string']]);
    }

    public function test_the_description_says_it_reads_metadata_and_not_contents(): void
    {
        // The one claim a model must not be left to infer: it has the record,
        // not the document, and saying otherwise is how it invents a policy's
        // small print.
        $this->assertStringContainsString('never what is inside it', $this->tool()->description());
    }
}
