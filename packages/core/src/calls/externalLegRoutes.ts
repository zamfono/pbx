/**
 * An external leg's walk down its matching routes (§9.4 "Outbound routing", "Route fallthrough",
 * "Hosts"), one dial target at a time: `externalLeg.ts` asks for the first, and for the next each
 * time an attempt fails before alerting. A SIP target's leg walks its own trunk's hosts alone,
 * with no route (§9.4 "SIP targets"). Pre-checks and caller identity are `routeSelection.ts`'s.
 */
import { userById, type Snapshot } from '../internal/snapshot.js';
import {
  shouldFallThrough,
  type AttemptFailure,
  type Route
} from '../routing/trunk.js';
import type { Call } from './call.js';
import type { AttemptIdentity, TrunkRow, UserRow } from './callerIdentity.js';
import type { Pipeline } from './pipeline.js';
import {
  liveTrunk,
  prepareRoute,
  routesFor,
  routeTrunk
} from './routeSelection.js';
import { dialTargets, retriesNextHost } from './trunkDial.js';
import type { TrunkState } from './trunkState.js';

/** One dial target of a matching route, with the trunk and the identity the attempt presents;
 * `route` is `null` for a SIP target's. */
export type Candidate = {
  route: Route | null;
  trunk: TrunkRow;
  identity: AttemptIdentity;
  endpoint: string;
};

/** One way out a leg has: a matching route and its trunk (`undefined` once soft-deleted), or a
 * SIP target's own trunk with no route. */
type Way = { route: Route | null; trunk: TrunkRow | undefined };

/** A leg's cursor: the ways out not yet tried, and the current one's remaining hosts. */
export type RouteCursor = {
  pipeline: Pipeline;
  trunkState: TrunkState;
  call: Call;
  callerUser: UserRow | null;
  snapshot: Snapshot;
  routes: Way[];
  current: Candidate | null;
  endpoints: string[];
  lastFailureKind: AttemptFailure['kind'] | null;
};

/** A cursor over `target.number`'s matching routes for a call made as `target.asUser`, or over
 * `target.trunkId` alone for a SIP target's user part. */
export function openCursor(
  ctx: {
    pipeline: Pipeline;
    trunkState: TrunkState;
    call: Call;
    snapshot: Snapshot;
  },
  target: { number: string; asUser: string | null; trunkId?: string }
): RouteCursor {
  const { snapshot } = ctx;
  const routes: Way[] =
    target.trunkId === undefined
      ? routesFor(snapshot, target.number, target.asUser).map(route => ({
          route,
          trunk: routeTrunk(snapshot, route)
        }))
      : [{ route: null, trunk: liveTrunk(snapshot, target.trunkId) }];
  return {
    ...ctx,
    callerUser: userById(snapshot, target.asUser),
    routes,
    current: null,
    endpoints: [],
    lastFailureKind: null
  };
}

/** `way`'s first dial target once its pre-checks pass (§9.4 "Route fallthrough"), else `null`. */
function candidateFor(leg: RouteCursor, way: Way): Candidate | null {
  const { route, trunk } = way;
  if (!trunk) {
    leg.lastFailureKind = 'unreachable';
    return null;
  }
  const prepared = prepareRoute({
    pipeline: leg.pipeline,
    trunkState: leg.trunkState,
    call: leg.call,
    route,
    trunk,
    callerUser: leg.callerUser,
    clirPerCall: null,
    snapshot: leg.snapshot
  });
  if (!prepared.ok) {
    leg.lastFailureKind = prepared.failure.kind;
    return null;
  }
  const endpoints = dialTargets(trunk, leg.snapshot);
  const endpoint = endpoints.shift();
  if (endpoint === undefined) {
    leg.lastFailureKind = 'hostsExhausted';
    return null;
  }
  leg.endpoints = endpoints;
  leg.current = { route, trunk, identity: prepared.identity, endpoint };
  return leg.current;
}

export function nextRoute(leg: RouteCursor): Candidate | null {
  for (
    let way = leg.routes.shift();
    way !== undefined;
    way = leg.routes.shift()
  ) {
    const candidate = candidateFor(leg, way);
    if (candidate !== null) {
      return candidate;
    }
  }
  return null;
}

/** After `failure`: the current trunk's next host (§9.4 "Hosts"), else the next matching route
 * the failure falls through to (§9.4 "Route fallthrough"), else `null`. */
export function nextCandidate(
  leg: RouteCursor,
  failure: AttemptFailure
): Candidate | null {
  leg.lastFailureKind = failure.kind;
  const endpoint = leg.endpoints.at(0);
  if (
    leg.current !== null &&
    endpoint !== undefined &&
    retriesNextHost(failure)
  ) {
    leg.endpoints = leg.endpoints.slice(1);
    leg.current = { ...leg.current, endpoint };
    return leg.current;
  }
  return shouldFallThrough(failure) ? nextRoute(leg) : null;
}
