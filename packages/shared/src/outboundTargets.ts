/**
 * The addresses a URL or host an admin or a client names may be connected to (§3.1 "Outbound
 * targets"): a webhook (§10.6), a `webSocket` forward target (§9.4), a backup target's server
 * (§6.5) and, with private networks refused, a Client ID Metadata Document (§5.2).
 */
import { lookup, type LookupAddress } from 'node:dns';
import { BlockList, isIP, isIPv6, type LookupFunction } from 'node:net';
import { networkInterfaces } from 'node:os';

// Never connected to (RFC 6890): unspecified, loopback and link-local, cloud metadata services
// among them. `BlockList` matches an IPv4-mapped IPv6 address against the IPv4 ranges.
const ALWAYS_REFUSED = [
  '0.0.0.0/8',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '::/128',
  '::1/128',
  'fe80::/10'
];
// Private networks, carrier-grade NAT's shared space among them, as an on-premises LAN or a VPN
// such as Tailscale uses it: refused with `ALLOW_PRIVATE_TARGETS=false`.
const PRIVATE = [
  '10.0.0.0/8',
  '100.64.0.0/10',
  '172.16.0.0/12',
  '192.168.0.0/16',
  'fc00::/7'
];
const IPV6_FAMILY = 6;
// `URL.hostname` brackets an IPv6 literal; `isIP` takes it bare.
const IPV6_BRACKETS = /^\[(?<address>.*)\]$/u;

/** The `code` of the error a refused address fails a connection with. */
export const FORBIDDEN_ADDRESS_CODE = 'ERR_FORBIDDEN_ADDRESS';

/**
 * Whether private networks are allowed (`ALLOW_PRIVATE_TARGETS`), and the subnets of the stack's
 * own `internal` network, by default those of this container's interfaces (`ownSubnets`).
 */
export type TargetPolicy = {
  allowPrivate: boolean;
  ownSubnets?: readonly string[];
};

/** The subnets of this container's interfaces besides loopback: on `api` and `core`, the
 *  `internal` network's alone (§6.3). */
export function ownSubnets(
  interfaces: NodeJS.Dict<
    { internal: boolean; cidr: string | null }[]
  > = networkInterfaces()
): string[] {
  return Object.values(interfaces)
    .flatMap(infos => infos ?? [])
    .filter(info => !info.internal && info.cidr !== null)
    .map(info => info.cidr ?? '');
}

// ponytail: read once per process, as Compose fixes a container's networks at its creation; a
// network connected to the running container by hand counts only after a restart.
let processSubnets: string[] | undefined;

function familyOf(address: string): 'ipv4' | 'ipv6' {
  return isIPv6(address) ? 'ipv6' : 'ipv4';
}

// One list per policy object, which its holder keeps for the process (a webhook dispatcher, the
// metadata fetch), so a lookup builds none.
const refusedLists = new WeakMap<TargetPolicy, BlockList>();

function refusedList(policy: TargetPolicy): BlockList {
  const cached = refusedLists.get(policy);
  if (cached !== undefined) {
    return cached;
  }
  const list = new BlockList();
  const ranges = [
    ...ALWAYS_REFUSED,
    ...(policy.allowPrivate ? [] : PRIVATE),
    ...(policy.ownSubnets ?? (processSubnets ??= ownSubnets()))
  ];
  for (const range of ranges) {
    const [network = '', prefix] = range.split('/');
    list.addSubnet(network, Number(prefix), familyOf(network));
  }
  refusedLists.set(policy, list);
  return list;
}

/** The error a refused address fails a connection with, its message the refusal's own class
 *  and nothing about the address: what a backup run's `error` shows (§6.5). */
export function forbiddenAddressError(): Error {
  return Object.assign(new Error('forbidden address'), {
    code: FORBIDDEN_ADDRESS_CODE
  });
}

/** Whether `error`, or the error it wraps, is a refused address's. */
export function isForbiddenAddressError(error: unknown): boolean {
  for (let current = error; current instanceof Error; current = current.cause) {
    if ((current as { code?: unknown }).code === FORBIDDEN_ADDRESS_CODE) {
      return true;
    }
  }
  return false;
}

/** Whether `policy` refuses `address`, an IP address. */
export function isForbiddenAddress(
  address: string,
  policy: TargetPolicy
): boolean {
  return refusedList(policy).check(address, familyOf(address));
}

/**
 * `host` (an `URL.hostname`, an IPv6 literal bracketed or not) is an IP literal that `policy`
 * refuses. A connection to an IP literal resolves nothing, so {@link targetLookup} never sees it:
 * this is its check for that case.
 */
export function isForbiddenLiteral(
  host: string,
  policy: TargetPolicy
): boolean {
  const bare = host.replace(IPV6_BRACKETS, '$<address>');
  return isIP(bare) !== 0 && isForbiddenAddress(bare, policy);
}

/** What a write refuses at once (422): an address literal refused whatever
 *  `ALLOW_PRIVATE_TARGETS` says, on loopback, link-local or unspecified. The connection checks
 *  the rest. */
export function isAlwaysForbiddenLiteral(host: string): boolean {
  return isForbiddenLiteral(host, { allowPrivate: true, ownSubnets: [] });
}

/** The reason a write refused for `isAlwaysForbiddenLiteral` names. */
export const ALWAYS_FORBIDDEN_REASON =
  'a loopback, link-local or unspecified address is never connected to';

/**
 * A socket `lookup` that resolves like the default one but fails, with a
 * `FORBIDDEN_ADDRESS_CODE` error, for a host with any address `policy` refuses. The check holds
 * for the very answer the socket connects to, so a name whose answer changes between a check and
 * the connection (DNS rebinding) cannot slip a refused one in.
 */
export function targetLookup(policy: TargetPolicy): LookupFunction {
  return (hostname, options, callback) => {
    lookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) {
        callback(error, []);
        return;
      }
      const refused = refusedList(policy);
      const [first] = addresses;
      if (
        first === undefined ||
        addresses.some(({ address, family }) =>
          refused.check(address, family === IPV6_FAMILY ? 'ipv6' : 'ipv4')
        )
      ) {
        callback(forbiddenAddressError(), []);
      } else if (options.all === true) {
        callback(null, addresses);
      } else {
        callback(null, first.address, first.family);
      }
    });
  };
}

/**
 * Every address `host` resolves to, or `host` itself for an IP literal; rejects with a
 * `FORBIDDEN_ADDRESS_CODE` error when `policy` refuses any of them. For a tool `api` spawns,
 * which resolves the name again itself (§6.5).
 */
export function resolveTarget(
  host: string,
  policy: TargetPolicy
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    targetLookup(policy)(
      host.replace(IPV6_BRACKETS, '$<address>'),
      { all: true },
      (error, addresses) => {
        if (error) {
          reject(error);
        } else {
          resolve((addresses as LookupAddress[]).map(({ address }) => address));
        }
      }
    );
  });
}
