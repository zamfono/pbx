type Env = Record<string, string | undefined>;

/**
 * The stack's public hostname, the `FQDN` of `.env` (§6.1), read from `ORIGIN` (`https://${FQDN}`,
 * §6.3) rather than a second variable carrying the same value; `null` when unset or unparseable.
 */
export function stackDomain(env: Env): string | null {
  const origin = env.ORIGIN;
  if (!origin) {
    return null;
  }
  try {
    return new URL(origin).hostname;
  } catch {
    return null;
  }
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
