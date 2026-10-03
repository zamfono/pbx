import { isIP } from 'node:net';
import * as env from '$app/env/private';

import { HTTP_UNPROCESSABLE_CONTENT } from '@zamfono/shared';

import { plainSipTransports } from '#lib/server/stackAddress.js';

import { OpError } from '../types.js';
import { type DeviceKind, type Transport } from './_shared.js';

const MAX_IPV4_PREFIX = 32;
const MAX_IPV6_PREFIX = 128;
const IPV4_FAMILY = 4;
const NO_SLASH = -1;

/** One IPv4 or IPv6 address, with an optional CIDR prefix of that family's own bit width (§11.1). */
function isValidIpOrCidr(value: string): boolean {
  const slashIndex = value.indexOf('/');
  const address = slashIndex === NO_SLASH ? value : value.slice(0, slashIndex);
  const family = isIP(address);
  if (family === 0) {
    return false;
  }
  if (slashIndex === NO_SLASH) {
    return true;
  }
  const prefix = value.slice(slashIndex + 1);
  if (!/^[0-9]+$/u.test(prefix)) {
    return false;
  }
  return (
    Number(prefix) <=
    (family === IPV4_FAMILY ? MAX_IPV4_PREFIX : MAX_IPV6_PREFIX)
  );
}

/**
 * Throws 422 for an empty allowlist: §9.3 "Transport policy" makes `allowedIps` the entire ACL
 * basis of a `plain` device, and the rendered endpoint denies every address it does not permit,
 * so an empty list is an endpoint nothing can reach. Shared by `devices.create` and
 * `devices.update`.
 */
export function assertNonEmptyIps(ips: string[]): void {
  if (ips.length === 0) {
    throw new OpError(
      HTTP_UNPROCESSABLE_CONTENT,
      'devices: a plain device requires allowedIps'
    );
  }
}

/** Throws 422 unless every entry of `ips` is a valid IPv4/IPv6 address or CIDR range. */
export function assertValidIps(ips: string[]): void {
  for (const ip of ips) {
    if (!isValidIpOrCidr(ip)) {
      throw new OpError(
        HTTP_UNPROCESSABLE_CONTENT,
        `devices: invalid IP or CIDR '${ip}'`
      );
    }
  }
}

/** Throws 422 for a `plain` device while both plain transports are disabled (§9.1, §9.3). */
export function assertPlainTransportEnabled(): void {
  if (plainSipTransports(env).length === 0) {
    throw new OpError(
      HTTP_UNPROCESSABLE_CONTENT,
      'devices: plain transport is disabled by this deployment'
    );
  }
}

/** Throws 422 for a `ringotel` device on `plain` transport (§11.2 `devices` CHECK). */
export function assertKindTransport(
  kind: DeviceKind,
  transport: Transport
): void {
  if (kind === 'ringotel' && transport !== 'tls') {
    throw new OpError(
      HTTP_UNPROCESSABLE_CONTENT,
      'devices: a ringotel device must use the tls transport'
    );
  }
}
