<?php

/*
|--------------------------------------------------------------------------
| The news desk's sources
|--------------------------------------------------------------------------
|
| Keyless, every one: outlets' own RSS and Atom feeds, Google News' RSS search
| for a query or an interest, and Hacker News' front page. A key would be a
| second secret to keep for public information, the weather's argument.
|
| Nothing here is an `.env` setting, for the diagnostics rule: these are
| judgements about this app, not knobs anybody turns per machine. Every feed
| below was checked live with `php artisan news:probe` before it was written
| down, and that command is where a feed that stops answering shows first.
|
| Every fetch goes through `App\Services\Calendar\FeedAddress` — https only,
| resolved and refused if it lands inside this network, the connection pinned
| to the address that was checked — because a feed is fetched from this
| machine as surely as a calendar is.
|
*/

return [

    // A feed is asked at most once per `ttl`; a failure is remembered for
    // `failure_ttl`, so an outlet that is down is not a retry loop while the
    // HUD is open. Searches change faster than a front page, and cost Google
    // one request per distinct question, so they keep for a little less.
    'ttl' => 1200,
    'failure_ttl' => 120,
    'search_ttl' => 900,

    'timeout' => 6,

    // A front page is tens of kilobytes; the largest checked (NASA, full
    // articles inline) is ~270KB. Past this it is not a feed worth parsing,
    // and SimpleXML holds several times the body in memory.
    'max_bytes' => 2_000_000,

    // What one answer holds. Five is a briefing, not a front page, and two per
    // outlet keeps one prolific outlet from being the whole of it.
    'per_beat' => 5,
    'per_source' => 2,

    // An item the assistant has already told the owner about is flagged as a
    // repeat for this long. Only the assistant marks; browsing the HUD does not.
    'seen_days' => 3,

    // How long an item shown to anyone can still be pinned by its id.
    'item_days' => 7,

    // A beat never serves a dated story older than this. The Metro sections
    // go days between stories, and newest-first would otherwise fill a quiet
    // day with last month's.
    'max_age_days' => 7,

    'summary_chars' => 280,

    // A stamp further ahead than this is a feed lying about its offset, and
    // is read as undated rather than pinned to the top of every list.
    'future_minutes' => 60,

    /*
    | The one search source. It is only ever a supplement to a beat's outlets,
    | or the whole of a query or an interest — never a beat on its own.
    | Its descriptions are the headline again plus the outlet's name, so
    | summaries are not read; its `<source>` names the real outlet.
    */

    'search' => [
        'name' => 'Google News',
        'url' => 'https://news.google.com/rss/search',
        'params' => ['hl' => 'en-PH', 'gl' => 'PH', 'ceid' => 'PH:en'],
        'summaries' => false,
        // Google's search carries social posts beside reporting, with the
        // post's whole text as the headline. Matched against the item's own
        // outlet name, which for these is the bare domain.
        'exclude' => ['facebook.com', 'instagram.com', 'x.com', 'twitter.com', 'tiktok.com', 'youtube.com', 'reddit.com', 'threads.net'],
    ],

    /*
    | The beats, in the order they are offered — local first.
    |
    | A feed is `name` and `url`, plus two optional corrections for feeds that
    | do not say what they mean:
    |
    | - `zone`: the feed's stamps are this zone's wall clock whatever offset
    |   they carry. Inquirer stamps Manila time `+0000`, which put every story
    |   eight hours in the future.
    | - `summaries => false`: the description is not a summary (Hacker News'
    |   is a "Comments" link).
    |
    | A beat's `search` adds Google News results for that phrase beside its
    | outlets, and narrows a query asked on that beat to it.
    */

    'beats' => [
        // The outlets' Metro sections, which are Metro Manila and nothing else
        // but move slowly (days between stories); GMA's and the search are
        // what keep the beat fresh.
        'local' => [
            'label' => 'Metro Manila',
            'feeds' => [
                ['name' => 'GMA News', 'url' => 'https://data.gmanetwork.com/gno/rss/news/metro/feed.xml'],
                ['name' => 'Inquirer', 'url' => 'https://newsinfo.inquirer.net/category/inquirer-headlines/metro/feed', 'zone' => 'Asia/Manila'],
                ['name' => 'Rappler', 'url' => 'https://www.rappler.com/philippines/metro-manila/feed/'],
            ],
            'search' => 'Metro Manila',
        ],
        // The same outlets' national front pages — the provinces, the Senate,
        // the courts — which the local beat's Metro sections leave out.
        'national' => [
            'label' => 'Philippines',
            'feeds' => [
                ['name' => 'Inquirer', 'url' => 'https://newsinfo.inquirer.net/feed', 'zone' => 'Asia/Manila'],
                ['name' => 'Rappler', 'url' => 'https://www.rappler.com/feed/'],
                ['name' => 'Philstar', 'url' => 'https://www.philstar.com/rss/nation'],
            ],
        ],
        'general' => [
            'label' => 'World',
            'feeds' => [
                ['name' => 'BBC News', 'url' => 'https://feeds.bbci.co.uk/news/world/rss.xml'],
                ['name' => 'The Guardian', 'url' => 'https://www.theguardian.com/world/rss'],
                ['name' => 'BBC News Asia', 'url' => 'https://feeds.bbci.co.uk/news/world/asia/rss.xml'],
            ],
        ],
        'tech' => [
            'label' => 'Tech',
            'feeds' => [
                ['name' => 'Hacker News', 'url' => 'https://news.ycombinator.com/rss', 'summaries' => false],
                ['name' => 'The Verge', 'url' => 'https://www.theverge.com/rss/index.xml'],
                ['name' => 'Ars Technica', 'url' => 'https://feeds.arstechnica.com/arstechnica/index'],
            ],
        ],
        'gaming' => [
            'label' => 'Gaming',
            'feeds' => [
                ['name' => 'Polygon', 'url' => 'https://www.polygon.com/rss/index.xml'],
                ['name' => 'Eurogamer', 'url' => 'https://www.eurogamer.net/feed'],
                ['name' => 'GameSpot', 'url' => 'https://www.gamespot.com/feeds/mashup/'],
            ],
        ],
        'travel' => [
            'label' => 'Travel',
            'feeds' => [
                ['name' => 'Condé Nast Traveler', 'url' => 'https://www.cntraveler.com/feed/rss'],
                ['name' => 'The Guardian Travel', 'url' => 'https://www.theguardian.com/travel/rss'],
            ],
        ],
        'lifestyle' => [
            'label' => 'Lifestyle',
            'feeds' => [
                ['name' => 'Philstar Lifestyle', 'url' => 'https://www.philstar.com/rss/lifestyle'],
                ['name' => 'The Guardian Life', 'url' => 'https://www.theguardian.com/lifeandstyle/rss'],
            ],
        ],
        'entertainment' => [
            'label' => 'Entertainment',
            'feeds' => [
                ['name' => 'Philstar Entertainment', 'url' => 'https://www.philstar.com/rss/entertainment'],
                ['name' => 'Variety', 'url' => 'https://variety.com/feed/'],
                ['name' => 'BBC News Entertainment', 'url' => 'https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml'],
            ],
        ],
        'science' => [
            'label' => 'Science',
            'feeds' => [
                ['name' => 'ScienceDaily', 'url' => 'https://www.sciencedaily.com/rss/top/science.xml'],
                ['name' => 'BBC News Science', 'url' => 'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml'],
                ['name' => 'New Scientist', 'url' => 'https://www.newscientist.com/feed/home/'],
            ],
        ],
    ],

    /*
    | The owner's interests, each a Google News search. At most `max` are kept
    | and the first `searched` are asked each time — one request apiece, so
    | ten interests would be ten requests behind one question.
    */

    'interests' => [
        'max' => 10,
        'searched' => 5,
        'per_interest' => 2,
    ],

];
