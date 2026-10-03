type Env = Record<string, string | undefined>;

/**
 * The stack's public hostname, the `FQDN` of `.env`, which every stack has (§6.1, §6.3
 * "Environment"); throws while it is unset, which `api`'s boot does first (`hooks.server.ts`).
 */
export function stackDomain(env: Env): string {
  // An empty value is unset: compose.yaml hands `${FQDN}` to `api` as is.
  if (!env.FQDN) {
    throw new Error('FQDN environment variable is required.');
  }
  return env.FQDN;
}

/**
 * The stack's public origin, `https://${fqdn}`: the OAuth issuer, the MCP resource and the base of
 * every absolute link `api` hands out (§5.2).
 */
export function stackOrigin(fqdn: string): string {
  return `https://${fqdn}`;
}

/**
 * The public IPv4 address SIP and media use (§6.1, §9.1): `EXTERNAL_IPV4` in the ports mode, which
 * Asterisk writes into SIP and SDP, else `STACK_IPV4`, which its transports bind in the macvlan
 * mode, the same order as the Asterisk entrypoint's; `null` when neither is set.
 */
export function stackIpv4(env: Env): string | null {
  // An empty value is unset: compose.yaml hands both to `api` as `${…:-}`.
  for (const value of [env.EXTERNAL_IPV4, env.STACK_IPV4]) {
    if (value) {
      return value;
    }
  }
  return null;
}

/** §6.1 "One IP, two listeners": the fixed SIP-TLS port every client, Ringotel included, dials. */
export const SIP_TLS_PORT = 5061;

/** §9.1: the fixed port of the plain SIP transports, UDP and TCP alike. */
export const SIP_PLAIN_PORT = 5060;

export type PlainSipTransport = 'udp' | 'tcp';

/** The plain SIP transports `SIP_UDP_ENABLED` and `SIP_TCP_ENABLED` leave on (§9.1), both by default. */
export function plainSipTransports(env: Env): PlainSipTransport[] {
  const enabled: PlainSipTransport[] = [];
  if (env.SIP_UDP_ENABLED !== 'false') {
    enabled.push('udp');
  }
  if (env.SIP_TCP_ENABLED !== 'false') {
    enabled.push('tcp');
  }
  return enabled;
}
