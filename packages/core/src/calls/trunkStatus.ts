/**
 * What Asterisk reports about a trunk, read as the trunk's status (spec §9.4 "Provisioning and
 * status"): `ip` trunks by the `qualify` reachability of their first host's contact, from the ARI
 * endpoint list at boot and `ContactStatusChange` after; `registration` trunks by their
 * registration outcome, from AMI `PJSIPShowRegistrationsOutbound` at boot and `Registry` events
 * after. Pure mappings from a snapshot and Asterisk's answer to `[trunkId, status]` pairs, which
 * `TrunkState` applies to the live state.
 */
import {
  registrationUris,
  trunkSectionName,
  type TrunkHost
} from '@zamfono/shared';

import type { AmiEvent } from '../ami/client.js';
import type { AriEvent, Endpoint } from '../ari/types.js';
import type { Snapshot } from '../internal/server.js';

export type TrunkStatus = 'registered' | 'unreachable';
export type StatusChange = [trunkId: string, status: TrunkStatus];

/** AMI `Registry`/`OutboundRegistrationDetail` status → trunk status; `Partial` since an unmapped AMI status looks up as `undefined` at runtime. */
const REGISTRY_STATUS: Partial<Record<string, TrunkStatus>> = {
  Registered: 'registered',
  Rejected: 'unreachable',
  Failed: 'unreachable',
  Unregistered: 'unreachable'
};

/** ARI endpoint state → trunk status: a PJSIP endpoint is `online` while a contact of its AOR is
 * reachable, and an `ip` trunk's AOR holds exactly its first outbound host's contact. */
const ENDPOINT_STATUS: Partial<Record<string, TrunkStatus>> = {
  online: 'registered',
  offline: 'unreachable'
};

function liveTrunks(snapshot: Snapshot): Snapshot['trunks'] {
  return snapshot.trunks.filter(trunk => trunk.deletedAt === null);
}

function ipTrunks(snapshot: Snapshot): Snapshot['trunks'] {
  return liveTrunks(snapshot).filter(trunk => trunk.authMode === 'ip');
}

/** `trunk`'s `outbound`/`both` hosts, in priority order (§9.4 "Hosts"). */
export function outboundHosts(
  snapshot: Snapshot,
  trunkId: string
): TrunkHost[] {
  return snapshot.trunkHosts
    .filter(
      host =>
        host.trunkId === trunkId &&
        (host.direction === 'outbound' || host.direction === 'both')
    )
    .sort((left, right) => left.priority - right.priority)
    .map(host => ({
      priority: host.priority,
      host: host.host,
      port: host.port
    }));
}

/** Every live `registration` trunk with the client and server URIs its registration carries. */
export function registrationTrunks(
  snapshot: Snapshot
): { id: string; clientUri: string; serverUri: string }[] {
  return liveTrunks(snapshot)
    .filter(
      (trunk): trunk is Snapshot['trunks'][number] & { username: string } =>
        trunk.authMode === 'registration' && trunk.username !== null
    )
    .map(trunk => ({
      id: trunk.id,
      ...registrationUris({
        username: trunk.username,
        hosts: outboundHosts(snapshot, trunk.id)
      })
    }));
}

/** The registration trunks' outcomes in a `PJSIPShowRegistrationsOutbound` answer. */
export function registrationDetailStatuses(
  snapshot: Snapshot,
  frames: AmiEvent[]
): StatusChange[] {
  return registrationTrunks(snapshot).flatMap(trunk => {
    const detail = frames.find(
      frame =>
        frame.Event === 'OutboundRegistrationDetail' &&
        frame.ClientUri === trunk.clientUri &&
        frame.ServerUri === trunk.serverUri
    );
    const status =
      detail === undefined ? undefined : REGISTRY_STATUS[detail.Status ?? ''];
    return status === undefined ? [] : [[trunk.id, status] as StatusChange];
  });
}

/** The registration trunk a `Registry` event reports on, by its client and server URIs. */
export function registryEventStatus(
  snapshot: Snapshot,
  event: AmiEvent
): StatusChange | null {
  const status = REGISTRY_STATUS[event.Status ?? ''];
  const trunk = registrationTrunks(snapshot).find(
    entry =>
      event.Username === entry.clientUri && event.Domain === entry.serverUri
  );
  return status === undefined || trunk === undefined
    ? null
    : [trunk.id, status];
}

/** The `ip` trunk whose contact a `ContactStatusChange` reports on, when it says reachable or not. */
export function contactEventStatus(
  snapshot: Snapshot,
  event: AriEvent
): StatusChange | null {
  const info = event.contact_info as
    { aor?: string; contact_status?: string } | undefined;
  const trunk = ipTrunks(snapshot).find(
    row => trunkSectionName(row.id) === info?.aor
  );
  if (trunk === undefined) {
    return null;
  }
  if (info?.contact_status === 'Reachable') {
    return [trunk.id, 'registered'];
  }
  return info?.contact_status === 'Unreachable'
    ? [trunk.id, 'unreachable']
    : null;
}

/** The `ip` trunks' reachability in ARI's endpoint list, read at boot (§9.4 "resyncs at boot"). */
export function endpointStatuses(
  snapshot: Snapshot,
  endpoints: Endpoint[]
): StatusChange[] {
  return ipTrunks(snapshot).flatMap(trunk => {
    const endpoint = endpoints.find(
      entry => entry.resource === trunkSectionName(trunk.id)
    );
    const status =
      endpoint === undefined ? undefined : ENDPOINT_STATUS[endpoint.state];
    return status === undefined ? [] : [[trunk.id, status] as StatusChange];
  });
}
