/**
 * Trunk selection, caller-ID presentation and CLIR (spec §9.4 "Outbound
 * routing", "Caller-ID", "Anonymous calls (CLIR)", "Channels", "Trunk
 * order", §10.1 "Emergency calls"). Pure functions only: the routing
 * pipeline passes in the rows already loaded for a call.
 */

import { callingCode } from '@zamfono/shared';

export type Route = {
  id: string;
  priority: number;
  trunkId: string;
  calleridDidId: string | null;
  users: string[];
  userGroups: string[];
  numbers: { number: string; isPrefix: boolean }[];
};

/** Whether `route`'s caller lists (§9.4 "Outbound routing") admit `caller`. */
function callerMatches(
  route: Route,
  caller: { userId: string; groupIds: string[] } | null
): boolean {
  if (route.users.length === 0 && route.userGroups.length === 0) {
    return true;
  }
  if (caller === null) {
    return false;
  }
  return (
    route.users.includes(caller.userId) ||
    route.userGroups.some(groupId => caller.groupIds.includes(groupId))
  );
}

/** Whether `route`'s number list (§9.4 "Outbound routing") admits `number`. */
function numberMatches(route: Route, number: string): boolean {
  if (route.numbers.length === 0) {
    return true;
  }
  return route.numbers.some(entry =>
    entry.isPrefix ? number.startsWith(entry.number) : number === entry.number
  );
}

/**
 * The routes that admit `caller` and `number`, in priority order (§9.4
 * "Outbound routing"): the order attempts run down on Route fallthrough.
 */
export function matchingRoutes(
  routes: Route[],
  caller: { userId: string; groupIds: string[] } | null,
  number: string
): Route[] {
  return routes
    .filter(
      route => callerMatches(route, caller) && numberMatches(route, number)
    )
    .sort((left, right) => left.priority - right.priority);
}

export type AttemptFailure =
  | { kind: 'unreachable' }
  | { kind: 'cap' }
  | { kind: 'clirUnsupported' }
  | { kind: 'hostsExhausted' }
  | { kind: 'noResponse' }
  | { kind: 'final'; code: number; alerted: boolean };

/** SIP final responses that state the callee's own condition (§9.4 "Route fallthrough"). */
const SIP_TEMPORARILY_UNAVAILABLE = 480;
const SIP_BUSY_HERE = 486;
const SIP_BUSY_EVERYWHERE = 600;
const SIP_DECLINE = 603;
const CALLEE_CONDITION_CODES = new Set<number>([
  SIP_TEMPORARILY_UNAVAILABLE,
  SIP_BUSY_HERE,
  SIP_BUSY_EVERYWHERE,
  SIP_DECLINE
]);

/**
 * Whether an attempt's failure falls through to the next matching route
 * (§9.4 "Route fallthrough"). A response naming the callee's own condition
 * never falls through; any other final response falls through only when it
 * arrived before the far end alerted.
 */
export function shouldFallThrough(failure: AttemptFailure): boolean {
  if (failure.kind !== 'final') {
    return true;
  }
  if (CALLEE_CONDITION_CODES.has(failure.code)) {
    return false;
  }
  return !failure.alerted;
}

/** No provisional response within this budget of an outbound INVITE marks the trunk dead (§9.4 "Route fallthrough"). */
export const ATTEMPT_NO_RESPONSE_MS = 8000;

/**
 * Emergency trunks to try (§10.1 "Emergency calls"): only those with `trunks.emergency` set (§9.4
 * "Emergency trunks"), in `trunks.priority` order, `unreachable` ones skipped.
 */
export function emergencyTrunks(
  trunks: {
    id: string;
    priority: number;
    emergency: boolean;
    status: 'registered' | 'unreachable' | 'unknown';
  }[]
): string[] {
  return trunks
    .filter(trunk => trunk.emergency && trunk.status !== 'unreachable')
    .sort((left, right) => left.priority - right.priority)
    .map(trunk => trunk.id);
}

/**
 * The presented number for a call (§9.4 "Caller-ID"): the matching route's
 * override, else the caller's own number, else the company main number.
 */
export function presentedNumber(params: {
  route: Route | null;
  user: { calleridDidId: string | null } | null;
  dids: Map<string, { number: string }>;
  mainDidId: string;
}): string {
  const didId =
    params.route?.calleridDidId ??
    params.user?.calleridDidId ??
    params.mainDidId;
  const did = params.dids.get(didId);
  if (did === undefined) {
    throw new Error(`presentedNumber: no DID row for "${didId}"`);
  }
  return did.number;
}

/**
 * Whether the presented number is withheld (§9.4 "Anonymous calls (CLIR)"):
 * the first non-null level wins, and an emergency call is never anonymous.
 */
export function resolveClir(params: {
  perCall: boolean | null;
  user: boolean | null;
  trunk: boolean | null;
  tenant: boolean;
  emergency: boolean;
}): boolean {
  if (params.emergency) {
    return false;
  }
  return params.perCall ?? params.user ?? params.trunk ?? params.tenant;
}

/** A trunk's outbound channel cap admits one more active call (§9.4 "Channels"); `null` is unlimited. */
export function channelCapAllows(
  active: number,
  maxChannels: number | null
): boolean {
  return maxChannels === null || active < maxChannels;
}

/** A withheld call refused because its trunk has nowhere to carry the identity (§9.4 "Anonymous calls (CLIR)"). */
const CLIR_UNSUPPORTED_STATUS = 403;

/** Renders `number` (E.164) per `format` (§9.4 "Caller-ID"): `national` drops the country's calling code for a leading `0`. */
function formatCallerId(
  number: string,
  format: 'e164' | 'national',
  country: string
): string {
  if (format === 'e164') {
    return number;
  }
  const internationalPrefix = `+${callingCode(country)}`;
  return number.startsWith(internationalPrefix)
    ? `0${number.slice(internationalPrefix.length)}`
    : number;
}

/**
 * The caller ID of a call's attempt (§9.4 "Caller-ID", "Anonymous calls (CLIR)"): the presented
 * number in the trunk's format, and whether it is withheld. chan_pjsip lays out the headers from
 * it: `From` carries it (a `pai` trunk's endpoint puts its account identity there instead), and
 * a `pai` or `both` trunk's `send_pai` asserts it in `P-Asserted-Identity`, withheld or not. A
 * withheld call on a `from`-only trunk has nowhere to carry the real identity and is refused.
 */
export function callerIdHeaders(params: {
  withhold: boolean;
  number: string;
  trunk: {
    callerIdHeader: 'from' | 'pai' | 'both';
    callerIdFormat: 'e164' | 'national';
  };
  country: string;
}):
  | { ok: true; number: string; withhold: boolean }
  | { ok: false; code: typeof CLIR_UNSUPPORTED_STATUS } {
  if (params.withhold && params.trunk.callerIdHeader === 'from') {
    return { ok: false, code: CLIR_UNSUPPORTED_STATUS };
  }
  return {
    ok: true,
    number: formatCallerId(
      params.number,
      params.trunk.callerIdFormat,
      params.country
    ),
    withhold: params.withhold
  };
}
