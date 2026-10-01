<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Pinned articles (19.2): news items the owner put aside to read later.
 *
 * **A snapshot, not a reference.** A feed moves on within hours and the item
 * registry (`news.item.{id}`) forgets after `news.item_days`, so a pin that
 * pointed at either would go blank exactly when it is finally read. The row
 * holds what was reported — title, outlet, link, summary, when — as it was
 * when pinned.
 *
 * **`item_id` is the service's own 12-hex id**, never a URL a caller named:
 * both the tool and the HUD pin by id, and `PinWriter` resolves it against the
 * registry. Unique per owner, so pinning twice is one row.
 *
 * **Reading is a timestamp, not a delete** — the deadlines' rule. A pin marked
 * read stays on the list, collapsed, and can be reopened; removing it is a
 * separate, deliberate act.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('pinned_articles', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->constrained()->cascadeOnDelete();

            $table->string('item_id', 12);
            $table->string('title', 500);
            $table->string('source', 160);
            $table->text('link');
            $table->text('summary')->nullable();
            $table->timestamp('published_at')->nullable();

            $table->timestamp('read_at')->nullable();

            $table->timestamps();

            $table->unique(['user_id', 'item_id']);
            // The one order every reader asks for: unread first, newest pin first.
            $table->index(['read_at', 'created_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('pinned_articles');
    }
};
