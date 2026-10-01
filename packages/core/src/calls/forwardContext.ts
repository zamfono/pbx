/**
 * A call's forwarding context (§9.4 "Forwarded calls"): the forward hops it took, each with the
 * diverting party and a reason, and what a trunk leg dialled for a forward target carries of
 * them: the `REDIRECTING` data, the `Diversion` its trunk's policy sends, written by
 * `forwardDiversion.ts`, and a `sip` target's headers, rendered by `forwardHeaders.ts`.
 */
import type { Snapshot } from '../internal/snapshot.js';
import type { Call } from './call.js';
import { extensionOf } from './extensionOwner.js';
import {
  diversionHeader,
  diversionNumber,
  type DiversionTrunk
} from './forwardDiversion.js';
import { headerVariables, type SipHeader } from './forwardHeaders.js';

/**
 * Asterisk's `REDIRECTING` reasons a forward hop maps to (§9.4 "Forwarded calls"), and the
 * `Diversion` `reason` sent for each (`forwardDiversion.ts`): `away` away, `time_of_day`
 * time-of-day, `cfu` unconditional, `cfb` user-busy, `cfnr` no-answer, `unavailable` unavailable,
 * `dnd` do-not-disturb.
 */
export type RedirectingReason =
  'away' | 'time_of_day' | 'cfu' | 'cfb' | 'cfnr' | 'unavailable' | 'dnd';

/** One forward hop: who diverted the call, and why. `number` is the `REDIRECTING` number, an
 * extension where the party has no number of its own; `diversionNumber` the one its `Diversion`
 * entry names, never an extension, `null` for none (§9.4 "Forwarded calls"). `party` and
 * `extension` are the diverting party's kind and extension, a menu's `null`, which a `sip`
 * target's headers name (§9.4 "Header templates"). */
export type Diversion = {
  number: string;
  diversionNumber: string | null;
  name: string | null;
  reason: RedirectingReason;
  party: 'user' | 'ringGroup' | 'menu';
  extension: string | null;
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

/** A user's number as `REDIRECTING` names it: their primary number, else their extension. */
function userNumber(snapshot: Snapshot, userId: string): string | null {
  const user = snapshot.users.find(row => row.id === userId);
  const did =
    user?.calleridDidId === null || user === undefined
      ? undefined
      : snapshot.dids.find(row => row.id === user.calleridDidId);
  return did?.number ?? extensionOf(snapshot, { userId });
}

type PartyIdentity = Omit<
  Diversion,
  'number' | 'diversionNumber' | 'reason'
> & {
  number: string | null;
};

/** `party`'s number, name and extension: a user's primary number or extension, a ring group's
 * extension, a menu's called number, the one an inbound call dialled. */
function partyIdentity(
  snapshot: Snapshot,
  call: Call,
  party: DivertingParty
): PartyIdentity {
  if ('userId' in party) {
    return {
      number: userNumber(snapshot, party.userId),
      name: snapshot.users.find(row => row.id === party.userId)?.name ?? null,
      party: 'user',
      extension: extensionOf(snapshot, { userId: party.userId })
    };
  }
  if ('ringGroupId' in party) {
    const extension = extensionOf(snapshot, {
      ringGroupId: party.ringGroupId
    });
    return {
      number: extension,
      name:
        snapshot.ringGroups.find(row => row.id === party.ringGroupId)?.name ??
        null,
      party: 'ringGroup',
      extension
    };
  }
  return {
    number: call.direction === 'inbound' ? call.to : null,
    name: snapshot.menus.find(row => row.id === party.menuId)?.name ?? null,
    party: 'menu',
    extension: null
  };
}

/**
 * The hop `party` makes for `reason`, with the party's numbers and name; `null` where it has no
 * `REDIRECTING` number to name, a menu of an internal call.
 */
export function diversionFor(
  snapshot: Snapshot,
  call: Call,
  party: DivertingParty,
  reason: RedirectingReason
): Diversion | null {
  const { number, ...identity } = partyIdentity(snapshot, call, party);
  return number === null
    ? null
    : {
        number,
        diversionNumber: diversionNumber(snapshot, call, party),
        reason,
        ...identity
      };
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
 * signalled before the INVITE; nothing is sent from it, since every trunk endpoint has
 * `send_diversion = no` (§9.4 "Forwarded calls"). None for a leg no hop led to.
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
 * ring-group member's followed forward, the member's (§10.1 step 5), and the headers it sends, a
 * `sip` target's rendered for it and none for an `external` one (§9.4 "Forwarded calls"). */
export type ForwardLeg = { diversions: Diversion[]; headers: SipHeader[] };

/** The forwarding context `forward`'s leg carries over `trunk` (§9.4 "Forwarded calls"): its
 * `REDIRECTING` data, the `Diversion` the trunk's policy sends and its headers, every header the
 * leg adds, so any other joins them here. */
export function forwardVariables(
  forward: ForwardLeg,
  trunk: DiversionTrunk
): Record<string, string> {
  const diversion = diversionHeader(forward.diversions, trunk);
  return {
    ...redirectingVariables(forward.diversions),
    ...(diversion === null
      ? {}
      : headerVariables([{ name: 'Diversion', value: diversion }])),
    ...headerVariables(forward.headers)
  };
}
