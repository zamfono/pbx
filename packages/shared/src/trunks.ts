export type TrunkHost = { priority: number; host: string; port: number | null };

/** A trunk host's SIP URI, `sip:<host>` or `sip:<host>:<port>` (§9.4 "Hosts"): its `ip`-trunk
 * contact in `pjsip_trunks.conf`, the core's per-host dial target and a registrar's server URI. */
export function sipHostUri(host: {
  host: string;
  port: number | null;
}): string {
  return host.port === null
    ? `sip:${host.host}`
    : `sip:${host.host}:${host.port}`;
}

/**
 * The client and server URIs of a registration trunk's registrar, the host with the lowest
 * priority (§9.4 "Flows"). Rendered into `pjsip_trunks.conf` and matched against AMI `Registry`
 * events by the same strings (§9.4 "Provisioning and status").
 */
export function registrationUris(trunk: {
  username: string;
  hosts: TrunkHost[];
}): { clientUri: string; serverUri: string } {
  if (trunk.hosts.length === 0) {
    throw new Error('registrationUris: trunk has no hosts');
  }
  const registrar = trunk.hosts.reduce((lowest, host) =>
    host.priority < lowest.priority ? host : lowest
  );
  return {
    clientUri: `sip:${trunk.username}@${registrar.host}`,
    serverUri: sipHostUri(registrar)
  };
}

/** `trunks.diversion` (§9.4 "Forwarded calls", §11.2): the `Diversion` a forwarded leg over the
 * trunk carries, none, the newest forward hop's or every hop's; `off` for a new trunk. */
export const DIVERSION_POLICIES = ['off', 'last', 'all'] as const;
export type DiversionPolicy = (typeof DIVERSION_POLICIES)[number];
