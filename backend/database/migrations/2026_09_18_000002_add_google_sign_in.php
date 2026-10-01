<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Google sign-in: who the owner is at Google, a log of every attempt, and where
 * each session came from.
 *
 * `google_sub` is nullable and stays null until the first successful sign-in
 * pins it. From then on it — not the email address — is what a sign-in must
 * match, because an address can be renamed or recycled and `sub` never is.
 *
 * `sign_ins` records refusals as well as successes. A refused attempt writes no
 * token, so without this row it would leave no trace at all, and "somebody
 * tried" is the one thing a single-user app most wants to be told.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('users', function (Blueprint $table) {
            $table->string('google_sub')->nullable()->unique();
            $table->string('avatar_url', 1024)->nullable();
            $table->timestamp('last_login_at')->nullable();
        });

        Schema::create('sign_ins', function (Blueprint $table) {
            $table->id();
            $table->string('email')->nullable();
            $table->string('google_sub')->nullable();
            $table->string('outcome', 16); // ok | refused | failed
            $table->string('reason', 64)->nullable();
            $table->string('ip', 45)->nullable();
            $table->text('user_agent')->nullable();
            $table->timestamp('created_at')->nullable()->index();
        });

        Schema::table('personal_access_tokens', function (Blueprint $table) {
            $table->string('ip_address', 45)->nullable();
            $table->text('user_agent')->nullable();
        });
    }

    public function down(): void
    {
        Schema::table('personal_access_tokens', function (Blueprint $table) {
            $table->dropColumn(['ip_address', 'user_agent']);
        });

        Schema::dropIfExists('sign_ins');

        Schema::table('users', function (Blueprint $table) {
            $table->dropUnique(['google_sub']);
            $table->dropColumn(['google_sub', 'avatar_url', 'last_login_at']);
        });
    }
};
