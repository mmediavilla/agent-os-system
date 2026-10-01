<?php

namespace Tests\Unit\News;

use Tests\TestCase;

/**
 * The shape `config/news.php` owes everything that reads it. Whether each
 * feed actually answers is `news:probe`'s, run live; this is what can be
 * held without the network.
 */
class NewsConfigTest extends TestCase
{
    public function test_every_beat_has_a_label_and_at_least_one_outlet_of_its_own(): void
    {
        $beats = config('news.beats');
        $search = parse_url(config('news.search.url'), PHP_URL_HOST);

        $this->assertNotEmpty($beats);

        foreach ($beats as $key => $beat) {
            $this->assertNotSame('', trim((string) ($beat['label'] ?? '')), "{$key} has no label");

            // Google News is only ever a supplement: a beat that was nothing
            // but a search would be Google's front page wearing a label.
            $outlets = array_filter($beat['feeds'] ?? [], fn (array $f) => parse_url($f['url'], PHP_URL_HOST) !== $search);
            $this->assertNotEmpty($outlets, "{$key} has no outlet of its own");
        }
    }

    public function test_every_feed_is_named_https_and_listed_once_per_beat(): void
    {
        foreach (config('news.beats') as $key => $beat) {
            $this->assertSame(
                count($beat['feeds']),
                count(array_unique(array_column($beat['feeds'], 'url'))),
                "{$key} lists a feed twice",
            );

            foreach ($beat['feeds'] as $feed) {
                $this->assertNotSame('', trim((string) ($feed['name'] ?? '')));
                $this->assertStringStartsWith('https://', $feed['url'], "{$feed['name']} is not https");

                if (isset($feed['zone'])) {
                    $this->assertContains($feed['zone'], timezone_identifiers_list());
                }
            }
        }

        $this->assertStringStartsWith('https://', config('news.search.url'));
    }

    public function test_beat_keys_are_plain_and_leave_interests_free(): void
    {
        $keys = array_keys(config('news.beats'));

        // The tool's `beat` enum is these keys plus `interests`.
        $this->assertNotContains('interests', $keys);
        $this->assertSame('local', $keys[0], 'Local comes first');

        foreach ($keys as $key) {
            $this->assertMatchesRegularExpression('/^[a-z]+$/', $key);
        }
    }

    public function test_the_caps_hold_together(): void
    {
        $this->assertLessThanOrEqual(config('news.per_beat'), config('news.per_source'));
        $this->assertLessThanOrEqual(config('news.interests.max'), config('news.interests.searched'));
        $this->assertLessThan(config('news.ttl'), config('news.failure_ttl'));
        $this->assertGreaterThanOrEqual(config('news.seen_days'), config('news.item_days'));
    }
}
