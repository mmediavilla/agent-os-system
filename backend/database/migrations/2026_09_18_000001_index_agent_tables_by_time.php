<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * A plain `created_at` index on the three agent tables Assistant → Activity
 * counts over a week.
 *
 * Until now all three were only ever read *by conversation*, so
 * `(conversation_id, …)` was the only access path they needed. "What did the
 * assistant do in the last seven days" is a new access path, and it gets its own
 * index rather than a scan that grows with every transcript — the same reason
 * `snapshots` has carried a bare `created_at` index since the daily frame
 * ceiling. `insights` needs nothing: it already has `(domain, created_at)` and
 * gains about one row a day.
 */
return new class extends Migration
{
    private const TABLES = ['conversation_messages', 'agent_runs', 'agent_actions'];

    public function up(): void
    {
        foreach (self::TABLES as $name) {
            Schema::table($name, function (Blueprint $table) {
                $table->index('created_at');
            });
        }
    }

    public function down(): void
    {
        foreach (self::TABLES as $name) {
            Schema::table($name, function (Blueprint $table) {
                $table->dropIndex(['created_at']);
            });
        }
    }
};
