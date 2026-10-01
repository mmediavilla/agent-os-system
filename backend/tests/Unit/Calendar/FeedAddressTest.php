<?php

namespace Tests\Unit\Calendar;

use App\Services\Calendar\AddressRefused;
use App\Services\Calendar\FeedAddress;
use GuzzleHttp\Psr7\Uri;
use PHPUnit\Framework\TestCase;

/**
 * Where a calendar fetch may go. The HTTP half is CalendarTest's; this is the
 * rule itself, off a fake resolver.
 */
class FeedAddressTest extends TestCase
{
    private function address(array $hosts = []): FeedAddress
    {
        return new FeedAddress(fn (string $host) => $hosts[$host] ?? ['93.184.215.14']);
    }

    public function test_webcal_is_https_and_nothing_else_changes(): void
    {
        $this->assertSame('https://p52-caldav.icloud.com/published/2/abc', FeedAddress::normalize('  webcal://p52-caldav.icloud.com/published/2/abc '));
        $this->assertSame('https://x.example/a.ics', FeedAddress::normalize('WEBCALS://x.example/a.ics'));
        $this->assertSame('https://calendar.google.com/Private-AbC', FeedAddress::normalize('https://calendar.google.com/Private-AbC'));
    }

    public function test_the_fetch_connects_to_the_address_that_was_checked(): void
    {
        $target = $this->address(['cal.example' => ['2606:2800:220:1::1', '93.184.215.14']])->check('https://cal.example/a.ics');

        // IPv4 preferred where there is one, and pinned so curl does not look
        // the name up a second time and get a different answer.
        $this->assertSame(['ok' => true, 'host' => 'cal.example', 'port' => 443, 'ip' => '93.184.215.14'], $target);
        $this->assertSame(['cal.example:443:93.184.215.14'], $this->address()->options($target)['curl'][CURLOPT_RESOLVE]);
    }

    public function test_an_ipv6_only_host_is_pinned_in_brackets_on_its_own_port(): void
    {
        $address = $this->address(['cal.example' => ['2606:2800:220:1::1']]);
        $target = $address->check('https://cal.example:8443/a.ics');

        $this->assertSame(['cal.example:8443:[2606:2800:220:1::1]'], $address->options($target)['curl'][CURLOPT_RESOLVE]);
    }

    public function test_redirects_are_https_only_and_capped(): void
    {
        $redirects = $this->address()->options(['host' => 'a', 'port' => 443, 'ip' => '93.184.215.14'])['allow_redirects'];

        $this->assertSame(['https'], $redirects['protocols']);
        $this->assertSame(3, $redirects['max']);
    }

    public function test_a_hop_into_the_network_is_refused_before_it_is_requested(): void
    {
        $address = $this->address(['intranet.test' => ['10.0.0.5']]);

        $address->guardRedirect(new Uri('https://p52-caldav.icloud.com/published/2/abc'));

        $this->expectException(AddressRefused::class);
        $address->guardRedirect(new Uri('https://intranet.test/admin'));
    }

    public function test_only_globally_routable_addresses_are_public(): void
    {
        foreach (['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.0.10', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::ffff:127.0.0.1', 'fe80::1', 'fd00::1'] as $ip) {
            $this->assertFalse(FeedAddress::isPublic($ip), $ip);
        }

        foreach (['93.184.215.14', '17.253.144.10', '2404:6800:4017:809::200e'] as $ip) {
            $this->assertTrue(FeedAddress::isPublic($ip), $ip);
        }
    }
}
