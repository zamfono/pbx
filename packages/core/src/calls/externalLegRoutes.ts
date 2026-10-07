/**
 * The route cursor of every outbound dial (§9.4 "Outbound routing", "Route fallthrough",
 * "Hosts"): a walk down its ways, one dial target at a time, asked for the first and for the next
 * after each failed attempt — by the dial that waits for its outcome (`dialAttempt.ts`) and by a
 * ring race's external leg (`externalLeg.ts`). A SIP target walks its own trunk's hosts alone,
 * with no route (§9.4 "SIP targets"), an emergency call each emergency trunk's (§10.1 "Emergency
 * calls"). Pre-checks and caller identity are `routeSelection.ts`'s.
 */
import type { Snapshot } from '../internal/snapshot.js';
import {
  shouldFallThrough,
  type AttemptFailure,
  type Route
} from '../routing/trunk.js';
import type { Call } from './call.js';
import type { AttemptIdentity, TrunkRow, UserRow } from './callerIdentity.js';
import type { ForwardLeg } from './forwardLeg.js';
import type { Pipeline } from './pipeline.js';
import {
  liveTrunk,
  prepareRoute,
  routesFor,
  routeTrunk
} from './routeSelection.js';
import type { TrunkChannels } from './trunkChannels.js';
import { dialTargets, retriesNextHost } from './trunkDial.js';

/** One dial target of a way, with the trunk and the identity the attempt presents; `route` is
 * `null` for a way with no route. */
export type Candidate = {
  route: Route | null;
  trunk: TrunkRow;
  identity: AttemptIdentity;
  endpoint: string;
};

/** One way out: a matching route and its trunk (`undefined` once soft-deleted), or a trunk with
 * no route (a SIP target's, an emergency trunk). `identity` given, the way takes no pre-checks:
 * an emergency call's, which bypasses them (§10.1 "Emergency calls"). */
export type Way = {
  route: Route | null;
  trunk: TrunkRow | undefined;
  identity?: AttemptIdentity;
};

/** What a cursor dials: `number` over its ways, the pre-checks and identity resolved for
 * `callerUser` with `clirPerCall`, and for a forward target the hops that led to it (§9.4
 * "Forwarded calls"). */
export type CursorCtx = {
  pipeline: Pipeline;
  trunkChannels: TrunkChannels;
  call: Call;
  snapshot: Snapshot;
  number: string;
  callerUser: UserRow | null;
  clirPerCall: boolean | null;
  forward: ForwardLeg | undefined;
};

/** A cursor: the ways not yet tried, and the current one's remaining hosts. */
export type RouteCursor = CursorCtx & {
  ways: Way[];
  current: Candidate | null;
  endpoints: string[];
  lastFailureKind: AttemptFailure['kind'] | null;
};

/** `number`'s matching routes for a call made as `asUser` (§9.4 "Outbound routing"), as ways. */
export function routeWays(
  snapshot: Snapshot,
  number: string,
  asUser: string | null
): Way[] {
  return routesFor(snapshot, number, asUser).map(route => ({
    route,
    trunk: routeTrunk(snapshot, route)
  }));
}

/** A SIP target's one way: its own trunk, no route (§9.4 "SIP targets"). */
export function trunkWay(snapshot: Snapshot, trunkId: string): Way {
  return { route: null, trunk: liveTrunk(snapshot, trunkId) };
}

export function openCursor(ctx: CursorCtx, ways: Way[]): RouteCursor {
  return { ...ctx, ways, current: null, endpoints: [], lastFailureKind: null };
}

/** `way`'s first dial target once its pre-checks pass (§9.4 "Route fallthrough"), else `null`. */
function candidateFor(leg: RouteCursor, way: Way): Candidate | null {
  const { route, trunk } = way;
  if (!trunk) {
    leg.lastFailureKind = 'unreachable';
    return null;
  }
  const prepared =
    way.identity === undefined
      ? prepareRoute({ ...leg, route, trunk })
      : { ok: true as const, identity: way.identity };
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
  for (let way = leg.ways.shift(); way !== undefined; way = leg.ways.shift()) {
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
