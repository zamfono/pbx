import { isIPv4, isIPv6 } from 'node:net';

// A /64 key keeps 4 of an IPv6 address's 8 hextets.
const IPV6_GROUP_COUNT = 8;
const IPV6_PREFIX_GROUP_COUNT = 4;
const HEX_RADIX = 16;
const BYTE_MULTIPLIER = 256;
const IPV4_MAPPED_MARKER = 0xffff;
// An embedded IPv4 address occupies the last 2 hextets, after either 5 zero hextets
// (`::ffff:a.b.c.d` mapped, `::a.b.c.d` compatible) or 4 zero hextets plus the `ffff`
// marker and one more zero hextet (`::ffff:0:a.b.c.d` translated, RFC 2765).
const IPV4_MAPPED_ZERO_COUNT = 5;
const IPV4_TRANSLATED_ZERO_COUNT = 4;
const IPV4_EMBEDDED_HEXTET_COUNT = 2;

/**
 * `ip`'s RFC 5952 canonical text, without a zone (`%eth0`): the WHATWG URL parser's IPv6
 * serialisation, which lowercases, compresses the longest zero run and writes an embedded
 * dotted quad as its two hextets.
 */
function canonicalIpv6(ip: string): string {
  const [address = ''] = ip.split('%');
  return new URL(`http://[${address}]`).hostname.slice(1, -1);
}

/** The 8 hextets of canonical IPv6 text, its one `::` expanded. */
function hextets(canonical: string): number[] {
  const parse = (side: string): number[] =>
    side === '' ? [] : side.split(':').map(group => parseInt(group, HEX_RADIX));
  const [head = '', tail] = canonical.split('::');
  if (tail === undefined) {
    return parse(head);
  }
  const before = parse(head);
  const after = parse(tail);
  const missing = IPV6_GROUP_COUNT - before.length - after.length;
  return [...before, ...new Array<number>(missing).fill(0), ...after];
}

/**
 * The IPv4 address embedded in `groups` (8 hextets) as IPv4-mapped, IPv4-compatible or
 * IPv4-translated (RFC 2765); `undefined` otherwise. The zero-marked (compatible) form
 * is trusted only when `ip`'s own text spells the tail as a dotted quad — it is
 * otherwise indistinguishable from an address like `::1`.
 */
function embeddedIpv4(groups: number[], ip: string): string | undefined {
  const leadingZeros = (count: number): boolean =>
    groups.slice(0, count).every(group => group === 0);
  const hasFfffMarker =
    (leadingZeros(IPV4_MAPPED_ZERO_COUNT) &&
      groups[IPV4_MAPPED_ZERO_COUNT] === IPV4_MAPPED_MARKER) ||
    (leadingZeros(IPV4_TRANSLATED_ZERO_COUNT) &&
      groups[IPV4_TRANSLATED_ZERO_COUNT] === IPV4_MAPPED_MARKER &&
      groups[IPV4_TRANSLATED_ZERO_COUNT + 1] === 0);
  if (hasFfffMarker) {
    const high = groups[IPV6_GROUP_COUNT - IPV4_EMBEDDED_HEXTET_COUNT] ?? 0;
    const low = groups[IPV6_GROUP_COUNT - 1] ?? 0;
    return [
      Math.floor(high / BYTE_MULTIPLIER),
      high % BYTE_MULTIPLIER,
      Math.floor(low / BYTE_MULTIPLIER),
      low % BYTE_MULTIPLIER
    ].join('.');
  }
  if (
    leadingZeros(IPV4_MAPPED_ZERO_COUNT) &&
    groups[IPV4_MAPPED_ZERO_COUNT] === 0
  ) {
    const embedded = ip.split(':').pop();
    return embedded !== undefined && isIPv4(embedded) ? embedded : undefined;
  }
  return undefined;
}

/**
 * The per-address key of the HTTP limiter (§5.5) and of `core`'s count of failed SIP attempts
 * (§5.6): an IPv4 address verbatim, its embedded form for an IPv4-mapped/compatible/translated
 * IPv6 address, or else the IPv6 address's canonical /64 prefix, since one subscriber controls a
 * whole /64. An unparsable address shares one bucket, since the value reaches the limiter from a
 * client-controlled header.
 */
export function addressKey(ip: string): string {
  if (isIPv4(ip)) {
    return ip;
  }
  if (!isIPv6(ip)) {
    // ponytail: garbage X-Forwarded-For collapses into one shared bucket instead of
    // throwing at a trust boundary; validate/reject upstream if that bucket ever needs
    // its own limit.
    return 'unparsable';
  }
  const groups = hextets(canonicalIpv6(ip));
  const embedded = embeddedIpv4(groups, ip);
  if (embedded !== undefined) {
    return embedded;
  }
  const prefix = groups
    .slice(0, IPV6_PREFIX_GROUP_COUNT)
    .map(group => group.toString(HEX_RADIX))
    .join(':');
  return `${canonicalIpv6(`${prefix}::`)}/64`;
}
