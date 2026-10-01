<?php

namespace Tests\Unit\News;

use App\Services\News\FeedParser;
use PHPUnit\Framework\TestCase;

/**
 * Every shape a feed arrives in, off a string. The fetching, caching and
 * merging are NewsServiceTest's.
 */
class FeedParserTest extends TestCase
{
    /** An RSS 2.0 body around the given `<item>`s. */
    public static function rss(array $items): string
    {
        return '<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>Outlet</title>'
            .implode('', $items).'</channel></rss>';
    }

    /** One RSS item. */
    public static function item(string $title, string $link, ?string $date = null, string $description = '', string $extra = ''): string
    {
        return '<item><title>'.htmlspecialchars($title, ENT_XML1).'</title><link>'.htmlspecialchars($link, ENT_XML1).'</link>'
            .($date !== null ? "<pubDate>{$date}</pubDate>" : '')
            .'<description><![CDATA['.$description.']]></description>'.$extra.'</item>';
    }

    private static function parse(string $body, array $options = []): array
    {
        return FeedParser::parse($body, $options['source'] ?? 'Outlet', $options['chars'] ?? 280, $options['zone'] ?? null, $options['summaries'] ?? true);
    }

    public function test_an_rss_item_becomes_plain_fields_with_an_instant(): void
    {
        $out = self::parse(self::rss([
            self::item('Flood gates open', 'https://outlet.example/a', 'Tue, 29 Sep 2026 17:21:02 +0800', '<p>The <b>MMDA</b> opened them.</p>'),
        ]));

        $this->assertNull($out['error']);
        $this->assertSame([[
            'title' => 'Flood gates open',
            'link' => 'https://outlet.example/a',
            'source' => 'Outlet',
            'published_at' => '2026-09-29T09:21:02+00:00',
            'summary' => 'The MMDA opened them.',
        ]], $out['items']);
    }

    public function test_an_atom_entry_reads_its_alternate_link_and_published_stamp(): void
    {
        $body = <<<'XML'
            <?xml version="1.0" encoding="UTF-8"?>
            <feed xmlns="http://www.w3.org/2005/Atom">
              <title>The Verge</title>
              <entry>
                <title type="html"><![CDATA[Your car’s data &amp; you]]></title>
                <link rel="replies" href="https://verge.example/a#comments" />
                <link rel="alternate" type="text/html" href="https://verge.example/a" />
                <updated>2026-09-28T15:54:48-04:00</updated>
                <published>2026-09-29T06:00:00-04:00</published>
                <summary type="html"><![CDATA[<p>Cars collect data.</p>]]></summary>
              </entry>
            </feed>
            XML;

        $out = self::parse($body, ['source' => 'The Verge']);

        // `published`, not `updated`: an edit is not when a story went out.
        $this->assertSame([[
            'title' => 'Your car’s data & you',
            'link' => 'https://verge.example/a',
            'source' => 'The Verge',
            'published_at' => '2026-09-29T10:00:00+00:00',
            'summary' => 'Cars collect data.',
        ]], $out['items']);
    }

    public function test_an_aggregators_source_names_the_outlet_and_leaves_the_headline(): void
    {
        $out = self::parse(self::rss([
            self::item('Water interruptions set for Metro Manila - GMA Network', 'https://news.google.com/rss/articles/abc', 'Mon, 28 Sep 2026 07:33:00 GMT', '',
                '<source url="https://www.gmanetwork.com">GMA Network</source>'),
        ]), ['source' => 'Google News', 'summaries' => false]);

        $this->assertSame('Water interruptions set for Metro Manila', $out['items'][0]['title']);
        $this->assertSame('GMA Network', $out['items'][0]['source']);
        $this->assertNull($out['items'][0]['summary']);
    }

    public function test_a_dublin_core_date_is_read_where_there_is_no_pub_date(): void
    {
        $out = self::parse(self::rss([
            self::item('World', 'https://g.example/w', null, '', '<dc:date>2026-09-29T11:25:46Z</dc:date>'),
        ]));

        $this->assertSame('2026-09-29T11:25:46+00:00', $out['items'][0]['published_at']);
    }

    public function test_a_zone_reads_the_stamps_wall_clock_there_whatever_offset_it_claims(): void
    {
        // Inquirer: Manila's 19:28 labelled +0000, which is 11:28 UTC.
        $out = self::parse(self::rss([
            self::item('Iloilo drug bust', 'https://inq.example/1', 'Tue, 29 Sep 2026 19:28:41 +0000'),
        ]), ['zone' => 'Asia/Manila']);

        $this->assertSame('2026-09-29T11:28:41+00:00', $out['items'][0]['published_at']);
    }

    public function test_a_missing_or_unreadable_stamp_is_undated(): void
    {
        $out = self::parse(self::rss([
            self::item('No date', 'https://o.example/1'),
            self::item('Bad date', 'https://o.example/2', 'last Tuesday-ish, probably'),
        ]));

        $this->assertSame([null, null], array_column($out['items'], 'published_at'));
    }

    public function test_markup_and_entities_come_out_and_a_literal_angle_bracket_stays(): void
    {
        $out = self::parse(self::rss([
            self::item('Rates &#8216;steady&#8217; &amp; calm', 'https://o.example/1', null, "<p>Growth&nbsp;&lt; 3%\n\n and <a href=\"x\">falling</a></p>"),
        ]));

        $this->assertSame('Rates ‘steady’ & calm', $out['items'][0]['title']);
        $this->assertSame('Growth < 3% and falling', $out['items'][0]['summary']);
    }

    public function test_a_long_summary_is_cut_at_a_word_with_an_ellipsis(): void
    {
        $text = str_repeat('word ', 100);

        $summary = self::parse(self::rss([self::item('Long', 'https://o.example/1', null, $text)]), ['chars' => 50])['items'][0]['summary'];

        $this->assertLessThanOrEqual(50, mb_strlen($summary));
        $this->assertStringEndsWith('word…', $summary);
    }

    public function test_summaries_off_is_null_and_an_empty_description_is_null(): void
    {
        $body = self::rss([self::item('HN', 'https://o.example/1', null, '<a href="https://news.ycombinator.com/item?id=1">Comments</a>')]);

        $this->assertNull(self::parse($body, ['summaries' => false])['items'][0]['summary']);
        $this->assertNull(self::parse(self::rss([self::item('Bare', 'https://o.example/2')]))['items'][0]['summary']);
    }

    public function test_an_item_without_a_title_or_a_web_link_is_dropped(): void
    {
        $out = self::parse(self::rss([
            self::item('', 'https://o.example/1'),
            self::item('Script', 'javascript:alert(1)'),
            self::item('Relative', '/story/1'),
            self::item('Kept', 'http://o.example/4'),
        ]));

        $this->assertSame(['Kept'], array_column($out['items'], 'title'));
    }

    public function test_rss_1_items_sit_beside_the_channel(): void
    {
        $body = '<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">'
            .'<channel><title>Old</title></channel>'
            .'<item><title>RDF story</title><link>https://o.example/rdf</link><dc:date>2026-09-29T01:00:00Z</dc:date></item></rdf:RDF>';

        $out = self::parse($body);

        $this->assertSame(['RDF story'], array_column($out['items'], 'title'));
        $this->assertSame('2026-09-29T01:00:00+00:00', $out['items'][0]['published_at']);
    }

    public function test_something_that_is_not_a_feed_is_empty_with_a_reason_and_never_throws(): void
    {
        foreach (['<html><body>Blocked</body></html>', 'not xml at all <', '', '<?xml version="1.0"?><urlset></urlset>'] as $body) {
            $out = self::parse($body);

            $this->assertSame([], $out['items']);
            $this->assertIsString($out['error']);
        }
    }

    public function test_an_external_entity_is_never_expanded(): void
    {
        $body = '<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>'
            .'<rss version="2.0"><channel><item><title>A &xxe; B</title><link>https://o.example/1</link></item></channel></rss>';

        $out = self::parse($body);

        foreach ($out['items'] as $item) {
            $this->assertStringNotContainsString('root:', $item['title']);
        }

        $this->assertTrue(true);
    }
}
