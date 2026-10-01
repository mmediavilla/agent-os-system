<?php

namespace Tests\Feature\Documents;

use App\Models\Document;
use App\Services\Documents\DocumentStore;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Facades\URL;
use Illuminate\Testing\TestResponse;
use Tests\TestCase;

/**
 * The half of a document that is bytes: what is accepted, where it goes, and
 * how a browser that cannot send a token gets it back.
 */
class DocumentFileTest extends TestCase
{
    use RefreshDatabase;

    /** The smallest thing that is honestly a PDF: the header is what is read. */
    private const PDF = "%PDF-1.7\n1 0 obj\n<< >>\nendobj\ntrailer\n<< >>\n%%EOF\n";

    protected function setUp(): void
    {
        parent::setUp();

        Storage::fake();
    }

    private function makeDocument(array $attrs = []): Document
    {
        return Document::create(array_merge([
            'title' => 'Travel insurance',
            'kind' => 'policy',
        ], $attrs));
    }

    private function upload(Document $document, UploadedFile $file): TestResponse
    {
        return $this->post("/api/documents/{$document->id}/file", ['file' => $file], ['Accept' => 'application/json']);
    }

    private function pdf(string $name = 'policy.pdf'): UploadedFile
    {
        return UploadedFile::fake()->createWithContent($name, self::PDF);
    }

    // ── Accepting a file ─────────────────────────────────────────────────────

    public function test_a_pdf_is_stored_and_the_record_comes_back(): void
    {
        $document = $this->makeDocument();

        $this->upload($document, $this->pdf())
            ->assertOk()
            ->assertJsonPath('mime', 'application/pdf')
            ->assertJsonPath('size_bytes', strlen(self::PDF));

        $path = $document->fresh()->file_path;

        $this->assertStringStartsWith(DocumentStore::DIR.'/', $path);
        $this->assertStringEndsWith('.pdf', $path);
        Storage::assertExists($path);
    }

    public function test_a_photograph_of_a_document_is_accepted_too(): void
    {
        // A scan is often a phone picture, and refusing one would send the
        // owner to a scanner for no reason.
        $document = $this->makeDocument();

        $this->upload($document, UploadedFile::fake()->image('receipt.jpg'))
            ->assertOk()
            ->assertJsonPath('mime', 'image/jpeg');
    }

    public function test_the_bytes_decide_the_type_rather_than_what_the_upload_claims(): void
    {
        $document = $this->makeDocument();

        // The content type is chosen by whoever is uploading. Stored on its
        // word, arbitrary bytes would be streamed back later as a PDF.
        $this->upload($document, UploadedFile::fake()->createWithContent('malice.pdf', '<?php echo 1;'))
            ->assertStatus(422)
            ->assertJsonPath('message', 'A document has to be a PDF or a picture (JPEG, PNG or WebP). Those bytes are neither.');

        $this->assertNull($document->fresh()->file_path);
        $this->assertSame([], Storage::allFiles(DocumentStore::DIR));
    }

    public function test_an_unsupported_kind_of_file_is_refused(): void
    {
        $document = $this->makeDocument();

        $this->upload($document, UploadedFile::fake()->createWithContent('notes.txt', 'just some text'))
            ->assertStatus(422);
    }

    public function test_a_file_over_the_cap_is_a_413_and_nothing_is_written(): void
    {
        // A 413 rather than a resize: there is no downscale in front of this,
        // so the owner chose this file and should be told it was refused.
        config(['documents.max_kb' => 1]);

        $document = $this->makeDocument();

        $this->upload($document, UploadedFile::fake()->createWithContent('big.pdf', self::PDF.str_repeat('x', 4096)))
            ->assertStatus(413);

        $this->assertNull($document->fresh()->file_path);
        $this->assertSame([], Storage::allFiles(DocumentStore::DIR));
    }

    public function test_a_file_over_phps_own_limit_is_a_413_that_names_it(): void
    {
        // Herd ships `upload_max_filesize=2M`, a tenth of the cap above. PHP
        // drops such a file before Laravel sees it, and the `file` rule would
        // otherwise answer "The file failed to upload."
        $path = tempnam(sys_get_temp_dir(), 'doc');
        file_put_contents($path, self::PDF);
        $dropped = new UploadedFile($path, 'scan.pdf', 'application/pdf', UPLOAD_ERR_INI_SIZE, true);

        $document = $this->makeDocument();

        $this->post("/api/documents/{$document->id}/file", ['file' => $dropped], ['Accept' => 'application/json'])
            ->assertStatus(413)
            ->assertJsonPath('message', fn (string $m) => str_contains($m, 'upload_max_filesize'));

        $this->assertNull($document->fresh()->file_path);
    }

    public function test_a_body_over_post_max_size_is_a_413_sentence(): void
    {
        // Refused before routing, so no document is even looked up.
        $this->call('POST', '/api/documents/1/file', server: ['CONTENT_LENGTH' => (string) (1024 ** 4), 'HTTP_ACCEPT' => 'application/json'])
            ->assertStatus(413)
            ->assertJsonPath('message', fn (string $m) => str_contains($m, 'post_max_size'));
    }

    public function test_the_upload_field_is_required(): void
    {
        $this->postJson("/api/documents/{$this->makeDocument()->id}/file", [])
            ->assertStatus(422)
            ->assertJsonValidationErrors('file');
    }

    // ── Replacing and clearing ───────────────────────────────────────────────

    public function test_replacing_a_file_removes_the_one_it_replaced(): void
    {
        $document = $this->makeDocument();

        $this->upload($document, $this->pdf('old.pdf'))->assertOk();
        $old = $document->fresh()->file_path;

        $this->upload($document, UploadedFile::fake()->image('new.png'))->assertOk();
        $new = $document->fresh()->file_path;

        $this->assertNotSame($old, $new);
        Storage::assertMissing($old);
        Storage::assertExists($new);
    }

    public function test_replacing_a_file_changes_the_url_it_is_served_from(): void
    {
        // `?v=` is updated_at, which is the whole reason the response may say
        // `immutable`: a replacement is a different URL, so no cached copy of
        // the old one is ever shown.
        $document = $this->makeDocument();

        $first = $this->upload($document, $this->pdf())->json('file_url');

        $this->travel(2)->seconds();
        $second = $this->upload($document, $this->pdf())->json('file_url');

        $this->assertNotSame($first, $second);
    }

    public function test_clearing_the_file_keeps_the_record(): void
    {
        $document = $this->makeDocument();

        $this->upload($document, $this->pdf())->assertOk();
        $path = $document->fresh()->file_path;

        $this->deleteJson("/api/documents/{$document->id}/file")
            ->assertOk()
            ->assertJsonPath('file_url', null)
            ->assertJsonPath('mime', null)
            ->assertJsonPath('size_bytes', null);

        Storage::assertMissing($path);
        // A document nobody has scanned yet is still one they are keeping
        // track of.
        $this->assertDatabaseCount('documents', 1);
    }

    public function test_deleting_the_record_takes_the_file_with_it(): void
    {
        $document = $this->makeDocument();

        $this->upload($document, $this->pdf())->assertOk();
        $path = $document->fresh()->file_path;

        $this->deleteJson("/api/documents/{$document->id}")->assertNoContent();

        // Through the model's hook, because a database cascade fires no events.
        Storage::assertMissing($path);
    }

    // ── Reading it back ──────────────────────────────────────────────────────

    public function test_the_signed_url_serves_the_file_without_a_token(): void
    {
        $document = $this->makeDocument();

        $url = $this->upload($document, $this->pdf())->json('file_url');

        // No Authorization header: an `<a>` and an `<embed>` cannot send one,
        // which is what the signature is standing in for.
        $response = $this->get($url);

        $response->assertOk()
            ->assertHeader('Content-Type', 'application/pdf')
            ->assertHeader('Cache-Control', 'immutable, max-age=31536000, private');

        $this->assertSame(self::PDF, $response->streamedContent());
    }

    public function test_the_file_is_offered_under_the_documents_own_name(): void
    {
        $document = $this->makeDocument(['title' => 'Travel insurance 2026']);

        $url = $this->upload($document, $this->pdf('a7f3c2.pdf'))->json('file_url');

        // The ULID it is stored under is not a name anybody wants saved.
        $this->get($url)->assertHeader(
            'Content-Disposition',
            'inline; filename=travel-insurance-2026.pdf',
        );
    }

    public function test_an_unsigned_request_for_a_file_is_refused(): void
    {
        $document = $this->makeDocument();
        $this->upload($document, $this->pdf())->assertOk();

        $this->get("/api/documents/{$document->id}/file")->assertForbidden();
    }

    public function test_a_signed_url_stops_working_after_its_day(): void
    {
        $document = $this->makeDocument();
        $url = $this->upload($document, $this->pdf())->json('file_url');

        $this->get($url)->assertOk();

        // Pinned to the end of the next UTC day, so a HUD left open overnight
        // still holds a working one.
        $this->travel(3)->days();
        $this->get($url)->assertForbidden();
    }

    public function test_a_record_whose_file_has_gone_is_a_404(): void
    {
        $document = $this->makeDocument();
        $url = $this->upload($document, $this->pdf())->json('file_url');

        Storage::delete($document->fresh()->file_path);

        // The record is what the app keeps; a checkout without the storage
        // folder should still open the screen.
        $this->get($url)->assertNotFound();
    }

    public function test_a_forged_url_says_nothing_about_which_documents_exist(): void
    {
        $document = $this->makeDocument();

        $this->get("/api/documents/{$document->id}/file?v=1")->assertForbidden();
        $this->get('/api/documents/999999/file?v=1')->assertForbidden();
    }

    public function test_a_tampered_signature_is_refused(): void
    {
        $url = URL::signedRoute('documents.file', ['document' => 1, 'v' => 1]);

        $this->get(str_replace('v=1', 'v=2', $url))->assertForbidden();
    }
}
