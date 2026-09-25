export type TrunkHost = { priority: number; host: string; port: number | null };

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
  const server =
    registrar.port === null
      ? registrar.host
      : `${registrar.host}:${registrar.port}`;
  return {
    clientUri: `sip:${trunk.username}@${registrar.host}`,
    serverUri: `sip:${server}`
  };
}
