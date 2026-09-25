/**
 * An external leg's walk down its matching routes (§9.4 "Outbound routing", "Route fallthrough",
 * "Hosts"), one dial target at a time: `externalLeg.ts` asks for the first, and for the next each
 * time an attempt fails before alerting. Pre-checks and caller identity are `routeSelection.ts`'s.
 */
import type { Snapshot } from '../internal/server.js';
import {
  shouldFallThrough,
  type AttemptFailure,
  type Route
} from '../routing/trunk.js';
import type { Call } from './call.js';
import type { AttemptIdentity, TrunkRow, UserRow } from './callerIdentity.js';
import type { Pipeline } from './pipeline.js';
import { prepareRoute, routesFor, routeTrunk } from './routeSelection.js';
import { dialTargets, retriesNextHost } from './trunkDial.js';
import type { TrunkState } from './trunkState.js';

/** One dial target of a matching route, with the trunk and the identity the attempt presents. */
export type Candidate = {
  route: Route;
  trunk: TrunkRow;
  identity: AttemptIdentity;
  endpoint: string;
};

/** A leg's cursor: the matching routes not yet tried, and the current route's remaining hosts. */
export type RouteCursor = {
  pipeline: Pipeline;
  trunkState: TrunkState;
  call: Call;
  callerUser: UserRow | null;
  snapshot: Snapshot;
  routes: Route[];
  current: Candidate | null;
  endpoints: string[];
  lastFailureKind: AttemptFailure['kind'] | null;
};

/** A cursor over `target.number`'s matching routes for a call made as `target.asUser`. */
export function openCursor(
  ctx: {
    pipeline: Pipeline;
    trunkState: TrunkState;
    call: Call;
    snapshot: Snapshot;
  },
  target: { number: string; asUser: string | null }
): RouteCursor {
  const { snapshot } = ctx;
  return {
    ...ctx,
    callerUser:
      target.asUser === null
        ? null
        : (snapshot.users.find(row => row.id === target.asUser) ?? null),
    routes: routesFor(snapshot, target.number, target.asUser),
    current: null,
    endpoints: [],
    lastFailureKind: null
  };
}

/** `route`'s first dial target once its pre-checks pass (§9.4 "Route fallthrough"), else `null`. */
function candidateFor(leg: RouteCursor, route: Route): Candidate | null {
  const trunk = routeTrunk(leg.snapshot, route);
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
    let route = leg.routes.shift();
    route !== undefined;
    route = leg.routes.shift()
  ) {
    const candidate = candidateFor(leg, route);
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
