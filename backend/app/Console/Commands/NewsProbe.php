<?php

namespace App\Console\Commands;

use App\Services\News\NewsService;
use Carbon\CarbonImmutable;
use Illuminate\Console\Command;
use InvalidArgumentException;

/**
 * Ask every outlet now and say how each went — free, no model call.
 *
 * This is where a feed's address is proven before it goes into
 * `config/news.php`, and where one that has stopped answering shows first.
 * It fetches past the cache, and what it reads is cached as any fetch is.
 */
class NewsProbe extends Command
{
    protected $signature = 'news:probe {beat? : One beat; every beat when left out}';

    protected $description = 'Fetch every news feed now and print its status, item count and freshness (free — no model call)';

    public function handle(NewsService $news): int
    {
        try {
            $rows = $news->probe($this->argument('beat'));
        } catch (InvalidArgumentException $e) {
            $this->error($e->getMessage().' Beats: '.implode(', ', array_keys($news->beats())).'.');

            return self::FAILURE;
        }

        $this->table(
            ['Beat', 'Source', 'Status', 'Items', 'Newest', 'Why not'],
            array_map(fn (array $row) => [
                $row['beat'],
                $row['source'].($row['kind'] === 'search' ? ' (search)' : ''),
                $row['ok'] ? 'ok' : 'FAILED',
                $row['items'],
                $row['newest'] === null ? '—' : CarbonImmutable::parse($row['newest'])->diffForHumans(),
                $row['message'] ?? '',
            ], $rows),
        );

        $failed = count(array_filter($rows, fn (array $row) => ! $row['ok']));
        $this->line($failed === 0 ? 'Every source answered.' : "{$failed} of ".count($rows).' sources failed.');

        return $failed === 0 ? self::SUCCESS : self::FAILURE;
    }
}
