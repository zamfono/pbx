import { isIPv4, isIPv6 } from 'node:net';

import {
  HTTP_UNPROCESSABLE_CONTENT,
  type HostDirection
} from '@zamfono/shared';

import { OpError } from '../types.js';

// A CR/LF or a bracket could open a new PJSIP section when a host or outbound proxy is
// interpolated into generated config (pjsip/shared.ts's `assertSafeConfigValue`); refused here,
// at the write boundary, rather than at render time.
const UNSAFE_HOST_PATTERN = /[\r\n[\]]/u;

// RFC 1123 hostname: dot-separated labels of letters, digits and internal hyphens.
const FQDN_PATTERN =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/iu;

const MAX_IPV4_PREFIX_LENGTH = 32;
const MAX_IPV6_PREFIX_LENGTH = 128;

/** Whether `value` is a CIDR range of either family, `<address>/<prefix>` (§11.1 "Column types"). */
function isValidCidr(value: string): boolean {
  const slashIndex = value.indexOf('/');
  if (slashIndex === -1) {
    return false;
  }
  const address = value.slice(0, slashIndex);
  const prefix = value.slice(slashIndex + 1);
  if (!/^\d+$/u.test(prefix)) {
    return false;
  }
  const prefixLength = Number(prefix);
  if (isIPv4(address)) {
    return prefixLength <= MAX_IPV4_PREFIX_LENGTH;
  }
  if (isIPv6(address)) {
    return prefixLength <= MAX_IPV6_PREFIX_LENGTH;
  }
  return false;
}

/**
 * Throws 422 for a `trunk_hosts.host` value that is not safe to interpolate into generated PJSIP
 * config, or that is not an FQDN, an IP literal, or — for `direction: 'inbound'` only — a CIDR
 * range of either family (§9.4 "Hosts", §11.2 "trunk_hosts": CIDR is inbound-only).
 */
export function assertValidHost(host: string, direction: HostDirection): void {
  if (UNSAFE_HOST_PATTERN.test(host)) {
    throw new OpError(
      HTTP_UNPROCESSABLE_CONTENT,
      `host contains characters unsafe for generated config: ${host}`
    );
  }
  if (isIPv4(host) || isIPv6(host) || FQDN_PATTERN.test(host)) {
    return;
  }
  if (direction === 'inbound' && isValidCidr(host)) {
    return;
  }
  throw new OpError(HTTP_UNPROCESSABLE_CONTENT, `invalid host: ${host}`);
}

/** Throws 422 for any `host` in `hosts` that {@link assertValidHost} refuses. */
export function assertValidHosts(
  hosts: { host: string; direction?: HostDirection }[]
): void {
  for (const host of hosts) {
    assertValidHost(host.host, host.direction ?? 'both');
  }
}

// A SIP URI parameter this outbound proxy accepts: loose routing or an explicit transport
// (pjsip/trunks.ts writes the value into `outbound_proxy`, its `;` escaped for Asterisk's config
// parser, and PJSIP parses it as a URI).
const SIP_URI_PARAM_PATTERN = /^(?:lr|transport=(?:udp|tcp|tls))$/iu;

/**
 * Whether `value` is a SIP URI PJSIP's `outbound_proxy` accepts: an optional `sip:`/`sips:`
 * scheme, an FQDN or IPv4 host, an optional `:port`, and any number of `;lr`/`;transport=`
 * parameters.
 *
 * ponytail: no bracketed-IPv6 host, since brackets are refused up front as unsafe for generated
 * config; add `[::1]`-style support only if an IPv6 outbound proxy is actually needed.
 */
function isValidOutboundProxyUri(value: string): boolean {
  const withoutScheme = value.replace(/^sips?:/iu, '');
  const [hostPort, ...params] = withoutScheme.split(';');
  // `String.split` always returns at least one element.
  if (hostPort === undefined) {
    return false;
  }
  if (params.some(param => !SIP_URI_PARAM_PATTERN.test(param))) {
    return false;
  }
  const colonIndex = hostPort.indexOf(':');
  const host = colonIndex === -1 ? hostPort : hostPort.slice(0, colonIndex);
  const port = colonIndex === -1 ? undefined : hostPort.slice(colonIndex + 1);
  if (port !== undefined && !/^\d{1,5}$/u.test(port)) {
    return false;
  }
  return isIPv4(host) || FQDN_PATTERN.test(host);
}

/**
 * Throws 422 for an `outboundProxy` that is not safe to interpolate into generated PJSIP config,
 * or that {@link isValidOutboundProxyUri} refuses: an outbound proxy is always a dial target,
 * never a source address, so — unlike a host — it never accepts a CIDR range (§11.2
 * "trunk_hosts": CIDR is inbound-only).
 */
export function assertValidOutboundProxy(
  outboundProxy: string | null | undefined
): void {
  if (outboundProxy === null || outboundProxy === undefined) {
    return;
  }
  if (UNSAFE_HOST_PATTERN.test(outboundProxy)) {
    throw new OpError(
      HTTP_UNPROCESSABLE_CONTENT,
      `host contains characters unsafe for generated config: ${outboundProxy}`
    );
  }
  if (!isValidOutboundProxyUri(outboundProxy)) {
    throw new OpError(
      HTTP_UNPROCESSABLE_CONTENT,
      `invalid outbound proxy: ${outboundProxy}`
    );
  }
}

// A CR/LF or a bracket could open a new PJSIP section, same as a host; an '@' or whitespace
// would split `sip:<username>@<host>` (registrationUris in @zamfono/shared) into more or fewer
// parts than the AMI Registry-event matching of §9.4 "Provisioning and status" expects.
const UNSAFE_USERNAME_PATTERN = /[\r\n[\]@\s]/u;

// Asterisk's config parser strips every character below this code point (space and the control
// characters, `ast_strip`) from both ends of a value, and has no quoting or escape that keeps
// them, so a credential with one at either end cannot be written as entered.
const FIRST_UNTRIMMED_CODE_POINT = 0x21;

/** Whether `value` begins or ends with a character Asterisk's config parser trims away. */
function hasTrimmedEnd(value: string): boolean {
  const first = value.codePointAt(0) ?? FIRST_UNTRIMMED_CODE_POINT;
  const last =
    value.codePointAt(value.length - 1) ?? FIRST_UNTRIMMED_CODE_POINT;
  return (
    first < FIRST_UNTRIMMED_CODE_POINT || last < FIRST_UNTRIMMED_CODE_POINT
  );
}

/**
 * Throws 422 for a `username` that is not safe to interpolate into generated PJSIP config, or
 * into the `sip:<username>@<host>` registration URI (§9.4 "Provisioning and status").
 */
export function assertValidUsername(username: string): void {
  if (UNSAFE_USERNAME_PATTERN.test(username) || hasTrimmedEnd(username)) {
    throw new OpError(
      HTTP_UNPROCESSABLE_CONTENT,
      `username contains characters unsafe for generated config: ${username}`
    );
  }
}

/**
 * Throws 422 for a `password` that is not safe to interpolate into generated PJSIP config, or
 * that begins or ends with whitespace the config parser would trim off.
 */
export function assertValidPassword(password: string): void {
  if (UNSAFE_HOST_PATTERN.test(password)) {
    throw new OpError(
      HTTP_UNPROCESSABLE_CONTENT,
      'password contains characters unsafe for generated config'
    );
  }
  if (hasTrimmedEnd(password)) {
    throw new OpError(
      HTTP_UNPROCESSABLE_CONTENT,
      'password must not begin or end with whitespace or a control character'
    );
  }
}
