<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * What a Troubleshoot run did (18.2): one outcome per fix the owner confirmed —
 * done, failed or skipped, with its sentence.
 *
 * Null on a diagnosis, which runs nothing. The findings beside it are the state
 * *after* the fixes, so the page reads a troubleshoot report exactly as it reads
 * a diagnosis, plus this.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('diagnostic_reports', function (Blueprint $table) {
            $table->json('outcomes')->nullable()->after('findings');
        });
    }

    public function down(): void
    {
        Schema::table('diagnostic_reports', function (Blueprint $table) {
            $table->dropColumn('outcomes');
        });
    }
};
