<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Filed artifacts (16.0): a passport, a policy, a receipt, a contract — the
 * things with dates on them somebody has to act on.
 *
 * **Not a second vault.** Permanent personal prose belongs in Obsidian, and the
 * facts store honoured that by holding only short atomic claims; this table
 * keeps the same discipline from the other side. What goes here is an artifact
 * and its metadata, never a body of writing.
 *
 * **The file is nullable, and so is every date.** Fields and bytes travel in
 * separate requests — JSON here, its own POST for the upload — so a failed
 * upload leaves the record saved rather than losing the form. A row with no
 * file is a note that a document exists; a row with no dates is a receipt.
 *
 * **`expires_on` does not create a deadline.** A deadline is its own row (16.2)
 * that may point at a document, because deriving one from this column would
 * make "file taxes by 15 April" — which has no document at all — inexpressible.
 *
 * `kind` is free text with a suggested vocabulary, like `equipment_type`: a
 * closed set would be wrong within a week of the first year's filing.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('documents', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->constrained()->cascadeOnDelete();

            $table->string('title', 160);
            $table->string('kind', 40);

            $table->date('issued_on')->nullable();
            $table->date('expires_on')->nullable();
            $table->text('notes')->nullable();

            // The private disk, `storage/app/private/documents` — never the
            // public one, so a fresh checkout needs no `storage:link` and the
            // read can be gated. Null until something is uploaded.
            $table->string('file_path')->nullable();
            $table->string('mime', 100)->nullable();
            $table->unsignedBigInteger('size_bytes')->nullable();

            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('documents');
    }
};
