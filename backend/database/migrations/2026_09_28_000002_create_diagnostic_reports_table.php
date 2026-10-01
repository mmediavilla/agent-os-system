<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Diagnose runs (18.0), and later Troubleshoot runs (18.2): what was found,
 * and the `.md` written from it.
 *
 * **The findings are the source; the markdown is a rendering of them**, kept
 * on the row so the page never needs the file, and written to the private disk
 * once so there is a copy to hand to someone. Neither is ever edited after the
 * run.
 *
 * **`source` says who asked** — the Stats page or the command line. A report on
 * the page nobody can account for is a report nobody trusts. The assistant was
 * planned as a third source (18.3) and dropped: it is what a diagnosis is most
 * often about, so it is never the one that runs it.
 *
 * The three counts are denormalised from `findings` so the list of past
 * reports reads without decoding each one's JSON. Retention is the newest 20,
 * pruned through the model so each file goes with its row.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('diagnostic_reports', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->constrained()->cascadeOnDelete();

            $table->string('kind', 20);
            $table->string('source', 20);
            $table->timestamp('ran_at')->index();

            $table->unsignedSmallInteger('problems');
            $table->unsignedSmallInteger('warnings');
            $table->unsignedSmallInteger('passed');

            $table->json('findings');
            $table->text('markdown');

            // The private disk, `storage/app/private/diagnostics`. Null only in
            // the moment between the row and its file being written.
            $table->string('path')->nullable();
            $table->unsignedInteger('bytes')->nullable();

            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('diagnostic_reports');
    }
};
