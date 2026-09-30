/**
 * Route selection for an outbound attempt (§9.4 "Outbound routing", "Route fallthrough"): the
 * routes matching a number and its caller, and one route's pre-checks and caller identity, which
 * decide whether it is attempted at all. Shared by `outboundExternal.ts`, whose attempts wait for
 * their outcome, and `externalLegRoutes.ts`, whose ring-race legs do not.
 */
import type { Snapshot } from '../internal/server.js';
import {
  channelCapAllows,
  matchingRoutes,
  type AttemptFailure,
  type Route
} from '../routing/trunk.js';
import type { Call } from './call.js';
import {
  resolveAttemptIdentity,
  type AttemptIdentity,
  type TrunkRow,
  type UserRow
} from './callerIdentity.js';
import { buildRoutes, callerGroupIds } from './outboundLookup.js';
import type { Pipeline } from './pipeline.js';
import type { TrunkState } from './trunkState.js';

/** `number`'s matching routes for a call made as `asUser`, in priority order (§9.4 "Outbound
 * routing"); `null` for a leg dialled on nobody's behalf, which matches only caller-less routes. */
export function routesFor(
  snapshot: Snapshot,
  number: string,
  asUser: string | null
): Route[] {
  const caller =
    asUser === null
      ? null
      : { userId: asUser, groupIds: callerGroupIds(asUser, snapshot) };
  return matchingRoutes(buildRoutes(snapshot), caller, number);
}

/** Trunk `trunkId`, `undefined` once soft-deleted or gone. */
export function liveTrunk(
  snapshot: Snapshot,
  trunkId: string
): TrunkRow | undefined {
  return snapshot.trunks.find(
    row => row.id === trunkId && row.deletedAt === null
  );
}

/** `route`'s trunk, `undefined` once soft-deleted. */
export function routeTrunk(
  snapshot: Snapshot,
  route: Route
): TrunkRow | undefined {
  return liveTrunk(snapshot, route.trunkId);
}

/**
 * One route's pre-checks (§9.4 "Route fallthrough"): a trunk that is `unreachable`, at its channel
 * cap, or cannot present a withheld call is skipped without an INVITE, with its trace line;
 * otherwise the attempt's caller identity, resolved for `callerUser` (§9.4 "Caller-ID", "CLIR").
 */
export function prepareRoute(params: {
  pipeline: Pipeline;
  trunkState: TrunkState;
  call: Call;
  /** `null` for a SIP target, which bypasses `outbound_routes` (§9.4 "SIP targets"). */
  route: Route | null;
  trunk: TrunkRow;
  callerUser: UserRow | null;
  clirPerCall: boolean | null;
  snapshot: Snapshot;
}):
  | { ok: true; identity: AttemptIdentity }
  | { ok: false; failure: AttemptFailure } {
  const { pipeline, trunkState, call, route, trunk, snapshot } = params;
  const skip = (
    failure: AttemptFailure
  ): { ok: false; failure: AttemptFailure } => {
    call.log.event({
      event: 'attempt',
      routeId: route?.id ?? null,
      trunkId: trunk.id,
      cause: failure.kind
    });
    return { ok: false, failure };
  };
  const status = pipeline.deps.state.trunks.get(trunk.id)?.status ?? 'unknown';
  if (status === 'unreachable') {
    return skip({ kind: 'unreachable' });
  }
  if (
    !channelCapAllows(trunkState.activeChannels(trunk.id), trunk.maxChannels)
  ) {
    return skip({ kind: 'cap' });
  }
  const identity = resolveAttemptIdentity({
    route,
    trunk,
    callerUser: params.callerUser,
    clirPerCall: params.clirPerCall,
    emergency: false,
    snapshot
  });
  if (!identity.ok) {
    return skip({ kind: 'clirUnsupported' });
  }
  return { ok: true, identity: identity.identity };
}
