import { lookup } from 'node:dns';
import { BlockList, isIP, isIPv6, type LookupFunction } from 'node:net';

// The ranges a URL anyone can name must not reach (RFC 6890): unspecified, loopback, private,
// shared (carrier-grade NAT), link-local (cloud metadata services among them) and unique local.
// `BlockList` matches an IPv4-mapped IPv6 address against the IPv4 ranges.
const NON_PUBLIC_NETWORKS = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '::/128',
  '::1/128',
  'fc00::/7',
  'fe80::/10'
];
const IPV6_FAMILY = 6;
// `URL.hostname` brackets an IPv6 literal; `isIP` takes it bare.
const IPV6_BRACKETS = /^\[(?<address>.*)\]$/u;

const nonPublic = new BlockList();
for (const cidr of NON_PUBLIC_NETWORKS) {
  const [network = '', prefix] = cidr.split('/');
  nonPublic.addSubnet(
    network,
    Number(prefix),
    isIPv6(network) ? 'ipv6' : 'ipv4'
  );
}

function isPublicAddress(address: string, family: number): boolean {
  return !nonPublic.check(address, family === IPV6_FAMILY ? 'ipv6' : 'ipv4');
}

/** `url`'s host is an IP literal on a non-public address. A connection to an IP literal resolves
 *  nothing, so {@link publicLookup} never sees it: this is its check for that case. */
export function isNonPublicLiteral(url: URL): boolean {
  const host = url.hostname.replace(IPV6_BRACKETS, '$<address>');
  const family = isIP(host);
  return family !== 0 && !isPublicAddress(host, family);
}

/**
 * A socket `lookup` that resolves like the default one but fails for a host with any non-public
 * address. The check holds for the very answer the socket connects to, so a name whose answer
 * changes between a check and the connection (DNS rebinding) cannot slip a private one in.
 */
export const publicLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err !== null) {
      callback(err, []);
      return;
    }
    const [first] = addresses;
    if (
      first === undefined ||
      !addresses.every(({ address, family }) =>
        isPublicAddress(address, family)
      )
    ) {
      callback(new Error(`${hostname} resolves to a non-public address`), []);
      return;
    }
    if (options.all === true) {
      callback(null, addresses);
    } else {
      callback(null, first.address, first.family);
    }
  });
};
