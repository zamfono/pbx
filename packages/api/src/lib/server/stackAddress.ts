type Env = Record<string, string | undefined>;

/** The stack's public hostname, the `FQDN` of `.env` (§6.1); `null` while unset. */
export function stackDomain(env: Env): string | null {
  // An empty value is unset: compose.yaml hands `${FQDN}` to `api` as is.
  if (env.FQDN) {
    return env.FQDN;
  }
  return null;
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
