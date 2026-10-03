import * as privateEnv from '$app/env/private';

/**
 * The stack's public origin, `https://<FQDN>`: the OAuth issuer every authorization response
 * carries as `iss` (RFC 9207), the MCP resource and the base of every absolute link `api` hands
 * out (§5.2).
 */
export function originFromEnv(): string {
  return `https://${privateEnv.FQDN}`;
}

/**
 * The public IPv4 address SIP and media use (§6.1, §9.1): `EXTERNAL_IPV4` in the ports mode, which
 * Asterisk writes into SIP and SDP, else `STACK_IPV4`, which its transports bind in the macvlan
 * mode, the same order as the Asterisk entrypoint's; `null` when neither is set.
 */
export function stackIpv4(env: {
  EXTERNAL_IPV4?: string | undefined;
  STACK_IPV4?: string | undefined;
}): string | null {
  return env.EXTERNAL_IPV4 ?? env.STACK_IPV4 ?? null;
}

/** §6.1 "One IP, two listeners": the fixed SIP-TLS port every client, Ringotel included, dials. */
export const SIP_TLS_PORT = 5061;

/** §9.1: the fixed port of the plain SIP transports, UDP and TCP alike. */
export const SIP_PLAIN_PORT = 5060;

export type PlainSipTransport = 'udp' | 'tcp';

/** The plain SIP transports `SIP_UDP_ENABLED` and `SIP_TCP_ENABLED` leave on (§9.1), both by default. */
export function plainSipTransports(env: {
  SIP_UDP_ENABLED: boolean;
  SIP_TCP_ENABLED: boolean;
}): PlainSipTransport[] {
  const enabled: PlainSipTransport[] = [];
  if (env.SIP_UDP_ENABLED) {
    enabled.push('udp');
  }
  if (env.SIP_TCP_ENABLED) {
    enabled.push('tcp');
  }
  return enabled;
}
