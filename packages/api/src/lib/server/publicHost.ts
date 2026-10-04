import { lookup } from 'node:dns/promises';
import { BlockList, isIPv6 } from 'node:net';

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
// `URL.hostname` brackets an IPv6 literal; `lookup` takes it bare.
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

/** Every address `url`'s host resolves to is public; `false` too when it does not resolve. An IP
 *  literal resolves to itself. */
export async function resolvesToPublicAddresses(url: URL): Promise<boolean> {
  const host = url.hostname.replace(IPV6_BRACKETS, '$<address>');
  try {
    const addresses = await lookup(host, { all: true });
    return addresses.every(
      ({ address, family }) =>
        !nonPublic.check(address, family === IPV6_FAMILY ? 'ipv6' : 'ipv4')
    );
  } catch {
    return false;
  }
}
