/**
 * A call's forwarding context (§9.4 "Forwarded calls"): the forward hops it took, each with the
 * diverting party and a reason, and what a trunk leg dialled for a forward target carries of
 * them, the `REDIRECTING` data chan_pjsip builds `Diversion` from and the custom headers of
 * `forwardHeaders.ts`.
 */
import type { Snapshot } from '../internal/server.js';
import type { Call } from './call.js';
import { forwardHeaders, headerVariables } from './forwardHeaders.js';

/**
 * Asterisk's `REDIRECTING` reasons a forward hop maps to (§9.4 "Forwarded calls"), and the
 * `Diversion` `reason` chan_pjsip sends for each: `away` away, `time_of_day` time-of-day, `cfu`
 * unconditional, `cfb` user-busy, `cfnr` no-answer, `unavailable` unavailable, `dnd`
 * do-not-disturb.
 */
export type RedirectingReason =
  'away' | 'time_of_day' | 'cfu' | 'cfb' | 'cfnr' | 'unavailable' | 'dnd';

/** One forward hop: who diverted the call, and why. */
export type Diversion = {
  number: string;
  name: string | null;
  reason: RedirectingReason;
};

/** The entity a hop diverts from: the target the call was on when its rule applied. */
export type DivertingParty =
  { userId: string } | { ringGroupId: string } | { menuId: string };

/** A user's forward rule condition, or a ring group's outcome, as the hop's reason. */
export const CONDITION_REASONS = {
  unconditional: 'cfu',
  busy: 'cfb',
  noAnswer: 'cfnr',
  offline: 'unavailable',
  dnd: 'dnd',
  unanswered: 'cfnr',
  unavailable: 'unavailable'
} as const satisfies Record<string, RedirectingReason>;

/** A user's number as a `Diversion` names it: their primary number, else their extension. */
function userNumber(snapshot: Snapshot, userId: string): string | null {
  const user = snapshot.users.find(row => row.id === userId);
  const did =
    user?.calleridDidId === null || user === undefined
      ? undefined
      : snapshot.dids.find(row => row.id === user.calleridDidId);
  return (
    did?.number ??
    snapshot.extensions.find(row => row.userId === userId)?.ext ??
    null
  );
}

/** `party`'s number and name: a user's primary number or extension, a ring group's extension, a
 * menu's called number, the one an inbound call dialled. */
function partyIdentity(
  snapshot: Snapshot,
  call: Call,
  party: DivertingParty
): { number: string | null; name: string | null } {
  if ('userId' in party) {
    return {
      number: userNumber(snapshot, party.userId),
      name: snapshot.users.find(row => row.id === party.userId)?.name ?? null
    };
  }
  if ('ringGroupId' in party) {
    return {
      number:
        snapshot.extensions.find(row => row.ringGroupId === party.ringGroupId)
          ?.ext ?? null,
      name:
        snapshot.ringGroups.find(row => row.id === party.ringGroupId)?.name ??
        null
    };
  }
  return {
    number: call.direction === 'inbound' ? call.to : null,
    name: snapshot.menus.find(row => row.id === party.menuId)?.name ?? null
  };
}

/**
 * The hop `party` makes for `reason`, with the party's number and name; `null` where it has no
 * number to name, a menu of an internal call, since a `Diversion` without one is not sent.
 */
export function diversionFor(
  snapshot: Snapshot,
  call: Call,
  party: DivertingParty,
  reason: RedirectingReason
): Diversion | null {
  const { number, name } = partyIdentity(snapshot, call, party);
  return number === null ? null : { number, name, reason };
}

/** Records `diversion`, the hop a forward is taking, in the call's context (§10.1 step 7). */
export function noteDiversion(call: Call, diversion: Diversion | null): void {
  if (diversion !== null) {
    call.diversions.push(diversion);
  }
}

/** A diverting party's number and name as the `REDIRECTING` fields of `prefix` take them. */
function partyVariables(
  prefix: 'orig' | 'from',
  diversion: Diversion
): Record<string, string> {
  return {
    [`REDIRECTING(${prefix}-num,i)`]: diversion.number,
    ...(diversion.name === null
      ? {}
      : { [`REDIRECTING(${prefix}-name,i)`]: diversion.name })
  };
}

/**
 * The `REDIRECTING` data of a leg that took `diversions`, first hop first: the first hop as the
 * original party, the last as the redirecting one, and the count, each set with `i` so nothing is
 * signalled before the INVITE; chan_pjsip sends a `Diversion` from the redirecting party (§9.4
 * "Forwarded calls"). None for a leg no hop led to.
 */
export function redirectingVariables(
  diversions: Diversion[]
): Record<string, string> {
  const first = diversions.at(0);
  const last = diversions.at(-1);
  if (first === undefined || last === undefined) {
    return {};
  }
  return {
    ...partyVariables('orig', first),
    'REDIRECTING(orig-reason,i)': first.reason,
    ...partyVariables('from', last),
    'REDIRECTING(reason,i)': last.reason,
    'REDIRECTING(count,i)': String(diversions.length)
  };
}

/** A trunk leg dialled for a forward target: the hops that led to it, the call's own and, for a
 * ring-group member's followed forward, the member's (§10.1 step 5). */
export type ForwardLeg = { diversions: Diversion[] };

/** The forwarding context `forward`'s leg carries (§9.4 "Forwarded calls"): its `REDIRECTING`
 * data and the custom headers for the call it belongs to. */
export function forwardVariables(
  call: Call,
  forward: ForwardLeg
): Record<string, string> {
  return {
    ...redirectingVariables(forward.diversions),
    ...headerVariables(
      forwardHeaders({
        caller: call.from,
        called: call.direction === 'inbound' ? call.to : null
      })
    )
  };
}
