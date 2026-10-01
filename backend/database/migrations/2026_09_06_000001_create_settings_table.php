<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Settings the *user* flips, as opposed to the ones the machine is configured
 * with.
 *
 * Everything adjustable in this app has so far been one of two things: a value
 * in `.env`, which needs a text editor and a cache clear and is therefore a
 * decision made once at setup, or a value in `localStorage`, which is per
 * browser and invisible to the server. The Anthropic switch is neither. It has
 * to be flippable from the screen, and it has to be **true for the whole
 * machine** — the proactive layer runs at 07:00 on a queue worker with no
 * browser open anywhere, and a kill switch that the scheduler cannot see is not
 * a kill switch.
 *
 * So: a row, and the smallest table that holds one. `key` is the primary key
 * rather than an id, because a setting is looked up by name every time and
 * never listed; `value` is json rather than a string so the next setting does
 * not need a migration to hold a number or a list.
 *
 * **Deliberately not the cache.** `Cache::forever` would have done the job with
 * no migration at all, and its failure direction is exactly wrong: a cache
 * flush — a deploy, a `php artisan optimize:clear`, an evicted key — would
 * silently turn a switch that was *off* back on, and the first evidence would
 * be the invoice. A row that survives everything short of a migration fails the
 * other way, which is the way a switch guarding money has to fail.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('settings', function (Blueprint $table) {
            $table->string('key')->primary();
            $table->json('value')->nullable();
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('settings');
    }
};
