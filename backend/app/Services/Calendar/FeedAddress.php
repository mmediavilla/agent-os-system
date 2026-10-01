<?php

namespace App\Services\Calendar;

use Closure;
use Psr\Http\Message\UriInterface;

/**
 * Where a calendar address may send this server, and where it may not.
 *
 * Any calendar that publishes an iCal address is accepted: Google's secret
 * address, iCloud's public link, Outlook's published ICS, a Nextcloud share.
 * 10.0 accepted Google's alone, and that allowlist was doing two jobs. One was
 * naming the provider, which stopped being wanted the moment a calendar lived
 * in iCloud. **The other was keeping the server off this machine's own network.**
 * Every stored address is fetched from inside this machine, every few minutes,
 * so an address that was only checked for its shape would have the server ask
 * `http://127.0.0.1:…`, a router's admin page or a cloud metadata endpoint on
 * behalf of whoever pasted it.
 *
 * So the check moved from *whose* the address is to *where it lands*. The host
 * is resolved and refused if **any** of its addresses is loopback, private,
 * link-local or reserved. That runs when the form is submitted and again before
 * every fetch, because a name that was public when it was saved can be pointed
 * somewhere else later. The fetch then connects to **the address that was
 * checked** (`CURLOPT_RESOLVE`) rather than looking the name up a second time,
 * which is what defeats a name that answers differently on the second lookup.
 *
 * A redirect is followed, up to three hops and https only, and each hop is put
 * through the same check before it is requested. The one gap left is that a
 * hop's connection is not pinned the way the first one is: a redirect target
 * would have to change its DNS answer in the milliseconds between the check and
 * the connect. That is a rebinding attack mounted by someone who controls both
 * a calendar host and its DNS, against a server reachable only from this machine.
 *
 * Plain `http` is refused as well, and not as an SSRF measure: these addresses
 * are secrets, and an http one sends the secret across the network in clear.
 * `webcal://` is the same address with a scheme that tells a calendar app to
 * subscribe, and it is rewritten to `https://` before anything else looks at it.
 */
final class FeedAddress
{
    /** @var Closure(string): list<string> */
    private readonly Closure $lookup;

    /** @param  (Closure(string): list<string>)|null  $lookup  a host's addresses; the tests pass a fake */
    public function __construct(?Closure $lookup = null)
    {
        $this->lookup = $lookup ?? self::dns(...);
    }

    /**
     * The form an address is stored, hashed and fetched in.
     *
     * Normalising before the hash is what keeps the duplicate check honest: the
     * same iCloud calendar pasted once as `webcal://` and once as `https://` is
     * one calendar.
     */
    public static function normalize(string $url): string
    {
        $url = trim($url);

        return preg_replace('~^webcals?://~i', 'https://', $url) ?? $url;
    }

    /**
     * Whether an address may be fetched, and if so what to connect to.
     *
     * Every refusal is a sentence written for the Settings field, and none of
     * them quotes the address: it is a credential, and a message is somewhere
     * it would be read back out.
     *
     * @return array{ok: true, host: string, port: int, ip: string}|array{ok: false, message: string}
     */
    public function check(string $url): array
    {
        $parts = parse_url($url);

        if (! is_array($parts) || ! isset($parts['scheme'], $parts['host'])) {
            return self::refused('That is not a web address. Paste the calendar\'s iCal address — it starts with https:// or webcal://.');
        }

        $scheme = strtolower($parts['scheme']);

        if ($scheme === 'http') {
            return self::refused('Use the https:// form of the address. An http one would send the calendar\'s secret across the network unencrypted.');
        }

        if ($scheme !== 'https') {
            return self::refused('Paste the calendar\'s iCal address — it starts with https:// or webcal://.');
        }

        if (isset($parts['user']) || isset($parts['pass'])) {
            return self::refused('An address with a username or password in it is not supported. Use the calendar\'s published or secret iCal link instead.');
        }

        $host = strtolower(trim($parts['host'], '[]'));
        $port = $parts['port'] ?? 443;

        $ips = filter_var($host, FILTER_VALIDATE_IP) !== false ? [$host] : ($this->lookup)($host);

        if ($ips === []) {
            return self::refused('The server in that address could not be found. Check it was copied whole.');
        }

        foreach ($ips as $ip) {
            if (! self::isPublic($ip)) {
                return self::refused('That address points inside this computer or its network, so this server will not fetch it.');
            }
        }

        // IPv4 first where there is one: it is what curl would have preferred on
        // its own, and a machine with no IPv6 route fails on the other.
        usort($ips, fn (string $a, string $b) => str_contains($a, ':') <=> str_contains($b, ':'));

        return ['ok' => true, 'host' => $host, 'port' => $port, 'ip' => $ips[0]];
    }

    /**
     * The Guzzle options that make a fetch go where {@see self::check()} said.
     *
     * @param  array{host: string, port: int, ip: string}  $target
     * @return array<string, mixed>
     */
    public function options(array $target): array
    {
        $ip = str_contains($target['ip'], ':') ? "[{$target['ip']}]" : $target['ip'];

        return [
            'curl' => [CURLOPT_RESOLVE => ["{$target['host']}:{$target['port']}:{$ip}"]],
            'allow_redirects' => [
                'max' => 3,
                'protocols' => ['https'],
                'on_redirect' => fn ($request, $response, UriInterface $uri) => $this->guardRedirect($uri),
            ],
        ];
    }

    /**
     * Refuse a hop the address itself would have been refused for.
     *
     * Guzzle calls this before it requests the hop, so a throw here means the
     * request is never sent.
     *
     * @throws AddressRefused
     */
    public function guardRedirect(UriInterface $uri): void
    {
        if (! $this->check((string) $uri)['ok']) {
            throw new AddressRefused('The calendar redirected to somewhere this server will not follow.');
        }
    }

    public static function isPublic(string $ip): bool
    {
        return filter_var(
            $ip,
            FILTER_VALIDATE_IP,
            FILTER_FLAG_GLOBAL_RANGE | FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE,
        ) !== false;
    }

    /** @return array{ok: false, message: string} */
    private static function refused(string $message): array
    {
        return ['ok' => false, 'message' => $message];
    }

    /**
     * Every A and AAAA record for a host.
     *
     * Both, because a host that is public over IPv4 and loopback over IPv6 is
     * exactly the trick a check that only asked for one of them would miss.
     *
     * @return list<string>
     */
    private static function dns(string $host): array
    {
        $v4 = gethostbynamel($host) ?: [];
        $v6 = array_column(@dns_get_record($host, DNS_AAAA) ?: [], 'ipv6');

        return array_values(array_unique([...$v4, ...$v6]));
    }
}
