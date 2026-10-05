/**
 * The source addresses never banned for failed SIP attempts (§5.6 "Counting"): a trunk's
 * `inbound` or `both` host, a device's `allowed_ips_json`, the allowlist and the stack's own.
 */
import { BlockList, isIP, isIPv6 } from 'node:net';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';

import { isCidr } from '@zamfono/shared';

import type { Logger } from '../ari/types.js';
import type { CoreEnv } from '../env.js';
import type { LookupFn } from '../hep.js';
import type { Snapshot } from '../internal/snapshot.js';

const LOOPBACK = ['127.0.0.0/8', '::1/128'];

/** The config an exemption reads, as the config snapshot holds it. */
export type ExemptConfig = {
  sipAllowlist: Pick<Snapshot['sipAllowlist'][number], 'address'>[];
  devices: Pick<Snapshot['devices'][number], 'allowedIps'>[];
  trunks: Pick<Snapshot['trunks'][number], 'id'>[];
  trunkHosts: Pick<
    Snapshot['trunkHosts'][number],
    'trunkId' | 'host' | 'direction'
  >[];
};

/**
 * The stack's own addresses: loopback, `STACK_IPV4` and `EXTERNAL_IPV4` in `stack`, and in
 * `internal` the subnets of `core`'s interfaces, which are on the `internal` network alone
 * (§6.3) and so hold its gateway.
 */
export type OwnAddresses = { stack: string[]; internal: string[] };

export function ownAddresses(
  env: Pick<CoreEnv, 'stackIpv4' | 'externalIpv4'>,
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()
): OwnAddresses {
  return {
    stack: [
      ...LOOPBACK,
      ...[env.stackIpv4, env.externalIpv4].filter(value => value !== null)
    ],
    internal: Object.values(interfaces)
      .flatMap(infos => infos ?? [])
      .filter(info => !info.internal && info.cidr !== null)
      .map(info => info.cidr ?? '')
  };
}

function family(address: string): 'ipv4' | 'ipv6' {
  return isIPv6(address) ? 'ipv6' : 'ipv4';
}

/** Whether `range`, an address or a CIDR range, holds `address`. */
function holds(range: string, address: string): boolean {
  const [network = '', prefix] = range.split('/');
  const list = new BlockList();
  if (prefix === undefined) {
    list.addAddress(network, family(network));
  } else {
    list.addSubnet(network, Number(prefix), family(network));
  }
  return list.check(address, family(address));
}

/**
 * Whether two ranges, each an address or a CIDR range, share an address: one holds the other's
 * written address, since two CIDR ranges either nest or are disjoint. A count key that is an IPv6
 * /64 is thereby exempt when it holds an exempt address, as its ban would block that address too.
 */
function overlaps(first: string, second: string): boolean {
  const written = (range: string): string => range.split('/')[0] ?? '';
  return holds(first, written(second)) || holds(second, written(first));
}

/** A trunk host's addresses: itself for an address or a range, else what its FQDN resolves to. */
async function hostAddresses(
  host: string,
  lookup: LookupFn,
  log: Logger
): Promise<string[]> {
  if (isIP(host) !== 0 || isCidr(host)) {
    return [host];
  }
  try {
    return (await lookup(host)).map(({ address }) => address);
  } catch (error) {
    log.warn({ err: error, host }, 'SIP ban: trunk host did not resolve');
    return [];
  }
}

/**
 * Why `key`, an address or an IPv6 /64, is never banned: `internalNetwork` for `core`'s subnet
 * of the `internal` network, where a runtime that hides the source puts every request (§5.6
 * "Residual risks"), `listed` for every other exemption, `null` for none. A trunk FQDN resolves
 * now, when the address reached the threshold.
 */
export async function exemption(
  key: string,
  config: ExemptConfig,
  own: OwnAddresses,
  lookup: LookupFn,
  log: Logger
): Promise<'internalNetwork' | 'listed' | null> {
  if (own.internal.some(range => overlaps(key, range))) {
    return 'internalNetwork';
  }
  const listed = [
    ...own.stack,
    ...config.sipAllowlist.map(row => row.address),
    ...config.devices.flatMap(device => device.allowedIps ?? [])
  ];
  if (listed.some(range => overlaps(key, range))) {
    return 'listed';
  }
  const liveTrunks = new Set(config.trunks.map(trunk => trunk.id));
  const trunkHosts = await Promise.all(
    config.trunkHosts
      .filter(
        host => host.direction !== 'outbound' && liveTrunks.has(host.trunkId)
      )
      .map(host => hostAddresses(host.host, lookup, log))
  );
  return trunkHosts.flat().some(range => overlaps(key, range))
    ? 'listed'
    : null;
}
