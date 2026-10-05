import { isIP } from 'node:net';

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
