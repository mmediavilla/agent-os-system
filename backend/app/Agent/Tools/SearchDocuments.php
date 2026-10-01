<?php

namespace App\Agent\Tools;

use App\Agent\CapabilityGroup;
use App\Models\Document;

class SearchDocuments extends BaseTool
{
    private const DEFAULT_LIMIT = 25;

    public function name(): string
    {
        return 'search_documents';
    }

    public function group(): CapabilityGroup
    {
        return CapabilityGroup::Documents;
    }

    public function description(): string
    {
        return <<<'TEXT'
        The user's filing cabinet — the documents they keep: passports, visas, insurance
        policies, contracts, receipts, certificates. Use it to answer "do I have X on file",
        "when does my Y expire" and "what is due for renewal", and to check before saying
        something is not on record.

        **This returns what is written about each document, never what is inside it.** You
        get the title, the kind, the issue and expiry dates, the user's own notes and whether
        a file has been uploaded — not a single word of the document's contents. So say what
        the record says, and if the answer needs reading the thing itself, say that it has to
        be opened rather than guessing at what it probably contains.

        An expiry date here is not a reminder. Anything the user has asked to be chased is a
        deadline, which is its own list.
        TEXT;
    }

    public function inputSchema(): array
    {
        return $this->object([
            'search' => $this->string(
                'Case-insensitive substring, matched against the title, the kind and the notes.'
            ),
            'kind' => $this->string(
                'Exact kind, as spelled on the record. Free text rather than a fixed set — '.
                'commonly '.implode(', ', Document::KINDS).'. Call with no arguments first to '.
                'see which are actually in use.'
            ),
            'expiring' => $this->boolean(
                'True to return only documents with an expiry date, soonest first — including '.
                'ones that have already expired.'
            ),
            'limit' => $this->limitProperty(self::DEFAULT_LIMIT),
        ]);
    }

    public function handle(array $input): array
    {
        $input = $this->validate($input, [
            'search' => ['nullable', 'string', 'max:255'],
            'kind' => ['nullable', 'string', 'max:40'],
            'expiring' => ['nullable', 'boolean'],
            'limit' => ['nullable', 'integer'],
        ]);

        $limit = $this->limit($input, self::DEFAULT_LIMIT);

        // The same scopes the Documents screen uses, so a tool answer and the
        // list the user is looking at cannot disagree about what matches.
        $query = Document::query()
            ->searchText($input['search'] ?? null)
            ->applyFilters($input);

        if (filter_var($input['expiring'] ?? false, FILTER_VALIDATE_BOOL)) {
            $query->whereNotNull('expires_on')->orderBy('expires_on');
        } else {
            $query->orderBy('kind')->orderBy('title');
        }

        $total = (clone $query)->count();

        return [
            'documents' => $query->limit($limit)->get()
                ->map(fn (Document $d) => array_filter([
                    'id' => $d->id,
                    'title' => $d->title,
                    'kind' => $d->kind,
                    'issued_on' => $d->issued_on?->toDateString(),
                    'expires_on' => $d->expires_on?->toDateString(),
                    'notes' => $d->notes,
                ], fn ($v) => $v !== null) + [
                    // Always present, both ways round, unlike the fields above:
                    // a row with no file is a note that the document exists,
                    // and a missing key would let the model assume there is
                    // something to open. The URL is not here — it is signed and
                    // time-limited, and a live credential does not belong in a
                    // transcript that is re-sent on every later turn.
                    'file_on_record' => $d->file_path !== null,
                ])->all(),
            'total_matching' => $total,
        ];
    }
}
