import { BlockList, isIP } from 'node:net';

const IPV4_FAMILY = 4;
const MAX_IPV4_PREFIX = 32;
const MAX_IPV6_PREFIX = 128;

/**
 * Whether `value` is a CIDR range, `<address>/<prefix>`, of either family with a prefix no wider
 * than that family's bit width (§11.1 "Column types"). A bare address is not a range.
 */
export function isCidr(value: string): boolean {
  const slashIndex = value.indexOf('/');
  if (slashIndex === -1) {
    return false;
  }
  const family = isIP(value.slice(0, slashIndex));
  const prefix = value.slice(slashIndex + 1);
  if (family === 0 || !/^\d+$/u.test(prefix)) {
    return false;
  }
  return (
    Number(prefix) <=
    (family === IPV4_FAMILY ? MAX_IPV4_PREFIX : MAX_IPV6_PREFIX)
  );
}

/** An address or CIDR range as its address part, prefix length and family. */
function parseRange(value: string): {
  address: string;
  prefix: number;
  type: 'ipv4' | 'ipv6';
} {
  const [address = '', prefix] = value.split('/');
  const type = isIP(address) === IPV4_FAMILY ? 'ipv4' : 'ipv6';
  const width = type === 'ipv4' ? MAX_IPV4_PREFIX : MAX_IPV6_PREFIX;
  return {
    address,
    prefix: prefix === undefined ? width : Number(prefix),
    type
  };
}

/**
 * Whether two addresses or CIDR ranges of either family (`isIP` or `isCidr`) share an address.
 * Two ranges are nested or disjoint, so they overlap exactly when one holds the other's address.
 */
export function addressRangesOverlap(left: string, right: string): boolean {
  const first = parseRange(left);
  const second = parseRange(right);
  if (first.type !== second.type) {
    return false;
  }
  const holds = (range: typeof first, other: typeof first): boolean => {
    const list = new BlockList();
    list.addSubnet(range.address, range.prefix, range.type);
    return list.check(other.address, other.type);
  };
  return holds(first, second) || holds(second, first);
}

const SIP_BAN_IPV6_SUFFIX = '/64';

/**
 * Whether `value` is what a SIP ban holds (§5.6, §11.2): an IPv4 address, or an IPv6 /64 in CIDR
 * form, lower case, without an embedded dotted quad. The ban helper refuses a list with any other
 * line as a whole (§9.1).
 */
export function isSipBanAddress(value: string): boolean {
  if (isIP(value) === IPV4_FAMILY) {
    return true;
  }
  return (
    value.endsWith(SIP_BAN_IPV6_SUFFIX) &&
    value === value.toLowerCase() &&
    !value.includes('.') &&
    isIP(value.slice(0, -SIP_BAN_IPV6_SUFFIX.length)) !== 0
  );
}
