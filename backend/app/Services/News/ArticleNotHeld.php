<?php

namespace App\Services\News;

use RuntimeException;

/**
 * An id the item registry no longer holds — or never did — or a title that is
 * not the one it holds under that id.
 *
 * The message is a sentence the model can act on and the HUD can show, so the
 * tool lets it through as its error and the controller as a 422.
 */
final class ArticleNotHeld extends RuntimeException
{
    public static function id(string $id): self
    {
        return new self("No news item with id {$id} is held any more — fetch the news again and use an id from that result.");
    }

    public static function title(string $id): self
    {
        return new self("The title given for {$id} is not the one held under that id — use the id and title exactly as get_news gave them.");
    }
}
