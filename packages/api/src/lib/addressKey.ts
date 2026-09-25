import { isIPv4, isIPv6 } from 'node:net';

// IPv6 canonical-form helpers: a /64 key keeps 4 of the address's 8 hextets.
const IPV6_GROUP_COUNT = 8;
const IPV6_PREFIX_GROUP_COUNT = 4;
const IPV6_MAX_COMPRESSION_PARTS = 2;
const HEX_RADIX = 16;
const BYTE_MULTIPLIER = 256;
const IPV4_MAPPED_MARKER = 0xffff;
const MIN_COMPRESSIBLE_RUN = 2;
// An embedded IPv4 address occupies the last 2 hextets, after either 5 zero hextets
// (`::ffff:a.b.c.d` mapped, `::a.b.c.d` compatible) or 4 zero hextets plus the `ffff`
// marker and one more zero hextet (`::ffff:0:a.b.c.d` translated, RFC 2765).
const IPV4_MAPPED_ZERO_COUNT = 5;
const IPV4_TRANSLATED_ZERO_COUNT = 4;
const IPV4_EMBEDDED_HEXTET_COUNT = 2;

/**
 * Parses one `::`-side of an IPv6 address into hextets, expanding a trailing embedded
 * IPv4 dotted-quad (`x:x:x:x:x:x:d.d.d.d` and its `::`-compressed forms, RFC 4291 §2.2)
 * into its two hextets.
 */
function parseHextets(side: string): number[] {
  if (!side) {
    return [];
  }
  return side.split(':').flatMap(group => {
    if (!isIPv4(group)) {
      return [parseInt(group, HEX_RADIX)];
    }
    const [firstOctet, secondOctet, thirdOctet, fourthOctet] = group
      .split('.')
      .map(Number);
    // `isIPv4(group)` above guarantees exactly 4 dotted octets.
    if (
      firstOctet === undefined ||
      secondOctet === undefined ||
      thirdOctet === undefined ||
      fourthOctet === undefined
    ) {
      throw new Error(`addressKey: malformed IPv4 octet: ${group}`);
    }
    return [
      firstOctet * BYTE_MULTIPLIER + secondOctet,
      thirdOctet * BYTE_MULTIPLIER + fourthOctet
    ];
  });
}

/**
 * Expands a full or `::`-compressed IPv6 address into its 8 hextets as numbers.
 */
function expandIpv6(address: string): number[] {
  const halves = address.split('::');
  if (halves.length > IPV6_MAX_COMPRESSION_PARTS) {
    throw new Error(`addressKey: malformed IPv6 address: ${address}`);
  }
  const head = parseHextets(halves[0] ?? '');
  if (halves.length === 1) {
    return head;
  }
  const tail = parseHextets(halves[1] ?? '');
  const missing = IPV6_GROUP_COUNT - head.length - tail.length;
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

/**
 * RFC 5952 canonical text of a full 8-hextet IPv6 address: lowercase hex hextets, with
 * the longest run of zero hextets (leftmost on a tie) compressed to `::`.
 */
function canonicalIpv6Text(groups: number[]): string {
  let bestStart = -1;
  let bestLen = 0;
  let runStart = -1;
  let runLen = 0;
  for (const [index, group] of groups.entries()) {
    if (group !== 0) {
      runStart = -1;
      runLen = 0;
      continue;
    }
    runStart = runStart === -1 ? index : runStart;
    runLen += 1;
    if (runLen > bestLen) {
      bestStart = runStart;
      bestLen = runLen;
    }
  }
  const hex = groups.map(group => group.toString(HEX_RADIX));
  if (bestLen < MIN_COMPRESSIBLE_RUN) {
    return hex.join(':');
  }
  const before = hex.slice(0, bestStart).join(':');
  const after = hex.slice(bestStart + bestLen).join(':');
  return `${before}::${after}`;
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
 * The limiter's per-address key: an IPv4 address verbatim, its embedded form for an
 * IPv4-mapped/compatible/translated IPv6 address, or else the IPv6 address's canonical
 * /64 prefix, since one subscriber controls a whole /64 (§5.5). An unparsable address
 * shares one bucket, since the value reaches the limiter from a client-controlled header.
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
  const groups = expandIpv6(ip);
  const embedded = embeddedIpv4(groups, ip);
  if (embedded !== undefined) {
    return embedded;
  }
  const prefix = [
    ...groups.slice(0, IPV6_PREFIX_GROUP_COUNT),
    ...new Array<number>(IPV6_GROUP_COUNT - IPV6_PREFIX_GROUP_COUNT).fill(0)
  ];
  return `${canonicalIpv6Text(prefix)}/64`;
}
