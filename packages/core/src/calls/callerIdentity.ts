/** Caller-ID and CLIR resolution for one outbound attempt (§9.4 "Caller-ID", "Anonymous calls
 * (CLIR)"): resolved per attempt, since each route (or the trunk, for an emergency call) may
 * carry its own override. */
import type { Snapshot } from '../internal/snapshot.js';
import {
  callerIdHeaders,
  presentedNumber,
  resolveClir,
  type Route
} from '../routing/trunk.js';

export type TrunkRow = Snapshot['trunks'][number];
export type UserRow = Snapshot['users'][number];

/** The number an attempt presents, and whether it is withheld (§9.4 "Anonymous calls (CLIR)"). */
export type AttemptIdentity = { number: string; withhold: boolean };

function didNumbersById(snapshot: Snapshot): Map<string, { number: string }> {
  return new Map(snapshot.dids.map(row => [row.id, { number: row.number }]));
}

/** Caller-ID and CLIR, resolved per attempt since each route may override them (§9.4). */
export function resolveAttemptIdentity(params: {
  route: Route | null;
  trunk: TrunkRow;
  callerUser: UserRow | null;
  clirPerCall: boolean | null;
  emergency: boolean;
  snapshot: Snapshot;
}): { ok: true; identity: AttemptIdentity } | { ok: false } {
  const { route, trunk, callerUser, clirPerCall, emergency, snapshot } = params;
  const presented = presentedNumber({
    route,
    user: callerUser ? { callerIdDidId: callerUser.callerIdDidId } : null,
    dids: didNumbersById(snapshot),
    mainDidId: snapshot.settings.mainDidId
  });
  const rawUserClir = callerUser?.clir ?? null;
  const userClir = rawUserClir === null ? null : rawUserClir === 1;
  const withhold = resolveClir({
    perCall: clirPerCall,
    user: userClir,
    trunk: trunk.clir === null ? null : trunk.clir === 1,
    tenant: snapshot.settings.clir === 1,
    emergency
  });
  const headers = callerIdHeaders({
    withhold,
    number: presented,
    trunk,
    country: snapshot.settings.country
  });
  if (!headers.ok) {
    return { ok: false };
  }
  return {
    ok: true,
    identity: { number: headers.number, withhold: headers.withhold }
  };
}
