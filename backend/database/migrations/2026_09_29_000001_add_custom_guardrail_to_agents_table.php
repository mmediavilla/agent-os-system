<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * An agent's guardrail in the owner's own words, when they have reworded it.
 *
 * **Null is the default, not "no rule"**: the agent is then held to the rules
 * of the groups it owns (`CapabilityGroup::guardrail()`), and that default
 * follows its groups when they change. So every existing row keeps exactly the
 * guardrail it had, and clearing the field can only ever put the default back.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('agents', function (Blueprint $table) {
            $table->text('custom_guardrail')->nullable()->after('purpose');
        });
    }

    public function down(): void
    {
        Schema::table('agents', function (Blueprint $table) {
            $table->dropColumn('custom_guardrail');
        });
    }
};
