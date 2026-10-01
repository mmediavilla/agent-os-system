<?php

namespace App\Agent\Tools;

use App\Agent\CapabilityGroup;
use App\Agent\Contracts\MutatingTool;
use App\Services\News\PinWriter;

/**
 * Put news items on the owner's reading list.
 *
 * **An array, so "pin these three" is one approval card** — `save_facts`' rule.
 * Resolved whole and written in one transaction by {@see PinWriter}: a stale
 * third id pins none of them.
 *
 * **Each item is an id and its title.** The id is what is pinned — never a URL,
 * so the model can only pin what `get_news` handed it — and the title is there
 * for the owner: the approval card shows the input, and a card of bare hex ids
 * is one nobody can decide. `PinWriter` checks the title against the item held
 * under that id, so the card cannot say one story while the id pins another.
 *
 * Typed chat and MCP only: voice is read-only, and says pinning has to be typed.
 */
class PinArticles extends BaseTool implements MutatingTool
{
    /** A briefing is five items; ten is room for two of them, not a feed. */
    public const MAX_ARTICLES = 10;

    public function __construct(private readonly PinWriter $writer) {}

    public function name(): string
    {
        return 'pin_articles';
    }

    public function group(): CapabilityGroup
    {
        return CapabilityGroup::News;
    }

    public function description(): string
    {
        return <<<'TEXT'
        Put news items on the user's reading list, to read later. Use it when the user asks to pin,
        save or keep a story for later. Several items from one request go in one call.

        Each item is the `id` and the `title` exactly as a get_news result in this conversation gave
        them — never make up an id or build one from a link. The title is what the user sees when
        approving, and it must match the item held under that id. An id from an older result may no
        longer be held: if so, call get_news again and use the fresh id.

        Pinning an item already on the list changes nothing; the result says so. The list itself is
        list_pinned_articles. Marking an item read or taking it off the list is done on screen, not
        here.
        TEXT;
    }

    public function inputSchema(): array
    {
        return $this->object([
            'articles' => $this->array(
                'The items to pin, at most '.self::MAX_ARTICLES.'.',
                $this->object([
                    'id' => $this->string('The item\'s `id` from a get_news result: twelve hex characters.'),
                    'title' => $this->string('The item\'s `title`, exactly as get_news gave it.'),
                ], ['id', 'title']),
            ),
        ], ['articles']);
    }

    public function handle(array $input): array
    {
        $data = $this->validate($input, [
            'articles' => ['required', 'array', 'min:1', 'max:'.self::MAX_ARTICLES],
            'articles.*' => ['required', 'array'],
            'articles.*.id' => ['required', 'string', 'regex:/^[0-9a-f]{12}$/'],
            'articles.*.title' => ['required', 'string', 'max:500'],
        ]);

        return [
            'articles' => array_map(fn (array $done) => [
                'id' => $done['pin']->item_id,
                'title' => $done['pin']->title,
                'source' => $done['pin']->source,
                'outcome' => $done['outcome'],
            ], $this->writer->pin($data['articles'])),
        ];
    }
}
