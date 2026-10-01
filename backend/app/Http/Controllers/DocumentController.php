<?php

namespace App\Http\Controllers;

use App\Http\Controllers\Concerns\PaginatesIndex;
use App\Models\Document;
use App\Services\Documents\DocumentRejected;
use App\Services\Documents\DocumentStore;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Symfony\Component\HttpFoundation\StreamedResponse;

/**
 * The filing cabinet: documents and their metadata.
 *
 * **Fields and file travel separately** — JSON here, its own POST for the
 * upload — which is the equipment photo's arrangement and for its reasons: PHP
 * does not parse a multipart PUT, and creating a record first means a failed
 * upload leaves a saved row rather than losing the form. Creating a document
 * with a file is therefore two requests.
 *
 * Reading the file is a **signed URL outside the gate**, because neither an
 * `<a download>` nor an `<embed>` can send the bearer token. Writing one is in
 * here, behind it.
 */
class DocumentController extends Controller
{
    use PaginatesIndex;

    /**
     * GET /api/documents
     *
     * Paginated only when asked, via `PaginatesIndex` — the catalog rule. A
     * default page size would silently shorten whichever caller needs the whole
     * set, and a list that is quietly missing its tail is a bug nobody reports.
     */
    public function index(Request $request): JsonResponse
    {
        // Ordered like the equipment catalog — the group first, then the name
        // inside it — so a filing cabinet reads as a filing cabinet rather than
        // as whatever order things were added in.
        $query = Document::orderBy('kind')
            ->orderBy('title')
            ->searchText($request->query('search'))
            ->applyFilters($request->query());

        return $this->paginatedResponse($request, $query);
    }

    /** POST /api/documents */
    public function store(Request $request): JsonResponse
    {
        // No owner passed: `BelongsToOwner` stamps it at `creating`.
        $document = Document::create($request->validate($this->rules()));

        return response()->json($document, 201);
    }

    /** PATCH /api/documents/{document} — any of the writable fields. */
    public function update(Request $request, Document $document): JsonResponse
    {
        $document->update($request->validate($this->rules(partial: true)));

        return response()->json($document);
    }

    /** DELETE /api/documents/{document} — the file goes with it, via the model. */
    public function destroy(Document $document): JsonResponse
    {
        $document->delete();

        return response()->json(null, 204);
    }

    // ── The file ─────────────────────────────────────────────────────────────

    /**
     * POST /api/documents/{document}/file
     *
     * Answers with the record, so the client picks up the new, cache-busted
     * `file_url` without a second round trip.
     *
     * The upload is validated as a file and nothing more: what it *is* gets
     * decided from its own bytes in {@see DocumentStore}, not from the type the
     * browser declared. The size cap is there too, because being over it is a
     * 413 rather than the 422 a `max:` rule would give.
     */
    public function uploadFile(Request $request, Document $document): JsonResponse
    {
        // Over PHP's own limit the file arrives as an upload error, and the
        // `file` rule would call it a failed upload rather than a big one.
        if ($request->file('file')?->getError() === UPLOAD_ERR_INI_SIZE) {
            $e = DocumentRejected::overPhpLimit();

            return response()->json(['message' => $e->getMessage()], $e->status);
        }

        $request->validate(['file' => ['required', 'file']]);

        try {
            $document = DocumentStore::attach($document, $request->file('file'));
        } catch (DocumentRejected $e) {
            return response()->json(['message' => $e->getMessage()], $e->status);
        }

        return response()->json($document);
    }

    /** DELETE /api/documents/{document}/file — the row stays, the file goes. */
    public function deleteFile(Document $document): JsonResponse
    {
        return response()->json(DocumentStore::detach($document));
    }

    /**
     * GET /api/documents/{document}/file — signed, outside the gate.
     *
     * `immutable` is safe because the URL carries `?v={updated_at}`: replacing
     * the file moves the row, which changes the URL, so this copy never needs
     * revalidating and a large scan is downloaded once.
     */
    public function file(Document $document): StreamedResponse
    {
        // A row whose file has gone is a 404 rather than a 500 — the record is
        // what the app keeps, and a checkout without the storage folder should
        // still open the screen.
        abort_if(! $document->file_path || ! Storage::exists($document->file_path), 404);

        return Storage::response($document->file_path, $this->downloadName($document), [
            'Content-Type' => $document->mime,
            'Cache-Control' => 'private, max-age=31536000, immutable',
        ]);
    }

    // ── Internals ────────────────────────────────────────────────────────────

    /**
     * What the file is called when it is saved, which is the document's title
     * rather than the ULID it is stored under. Slugged, because the name goes
     * into a `Content-Disposition` header and a title is free text.
     */
    private function downloadName(Document $document): string
    {
        $stem = Str::slug($document->title) ?: 'document';

        return $stem.'.'.pathinfo($document->file_path, PATHINFO_EXTENSION);
    }

    /**
     * The row's writable fields.
     *
     * `kind` is free text rather than `Rule::in(Document::KINDS)` — the list is
     * a vocabulary the form suggests, not a constraint, for `equipment_type`'s
     * reason. Both dates are nullable because a receipt has no expiry and a
     * passport found in a drawer may have neither date to hand.
     *
     * `partial` is what a PATCH sends: every rule keeps its own validation and
     * only becomes optional, so a field that *is* sent is never half-checked.
     * The file columns are not here at all — they belong to `DocumentStore`.
     */
    private function rules(bool $partial = false): array
    {
        $sometimes = $partial ? ['sometimes'] : [];

        return [
            'title' => [...$sometimes, 'required', 'string', 'max:160'],
            'kind' => [...$sometimes, 'required', 'string', 'max:40'],
            'issued_on' => ['nullable', 'date'],
            'expires_on' => ['nullable', 'date'],
            'notes' => ['nullable', 'string'],
        ];
    }
}
