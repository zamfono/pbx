/**
 * A call's forwarding context (§9.4 "Forwarded calls"): the forward hops it took, each with the
 * diverting party and a reason, recorded as the call forwards. What a trunk leg dialled for a
 * forward target or a blind transfer carries of them is `forwardLeg.ts`'s.
 */
import { userById, type Snapshot } from '../internal/snapshot.js';
import type { ForwardTarget } from '../routing/targets.js';
import type { Call } from './call.js';
import { extensionOf } from './extensionOwner.js';
import { diversionNumber } from './forwardDiversion.js';

/**
 * Asterisk's `REDIRECTING` reasons a forward hop or a blind transfer maps to (§9.4 "Forwarded
 * calls"), and the `Diversion` `reason` sent for each (`forwardDiversion.ts`): `away` away,
 * `time_of_day` time-of-day, `cfu` unconditional, `cfb` user-busy, `cfnr` no-answer,
 * `unavailable` unavailable, `dnd` do-not-disturb, `deflection` deflection.
 */
export type RedirectingReason =
  | 'away'
  | 'time_of_day'
  | 'cfu'
  | 'cfb'
  | 'cfnr'
  | 'unavailable'
  | 'dnd'
  | 'deflection';

/** One forward hop: who diverted the call, and why. `number` is the `REDIRECTING` number, an
 * extension where the party has no number of its own; `diversionNumber` the one its `Diversion`
 * entry names, never an extension, `null` for none (§9.4 "Forwarded calls"). `party` and
 * `extension` are the diverting party's kind and extension, a menu's and a tenant number's `null`,
 * which a `sip` target's headers name (§9.4 "Header templates"). */
export type Diversion = {
  number: string;
  diversionNumber: string | null;
  name: string | null;
  reason: RedirectingReason;
  party: 'user' | 'ringGroup' | 'menu' | 'number';
  extension: string | null;
};

/** The entity a hop diverts from: the target the call was on when its rule applied, or the
 * tenant number whose own target it is (`TenantNumber`). */
export type DivertingParty =
  | { userId: string }
  | { ringGroupId: string }
  | { menuId: string }
  | TenantNumber;

/** A tenant number that forwards (§9.4 "Forwarded calls"): a DID, or the called number a block's
 * or the tenant's fallback routes (`fallbackBlockId` the block, `null` for the tenant's). */
export type TenantNumber =
  { didId: string } | { fallbackBlockId: string | null };

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
  const user = userById(snapshot, userId);
  const did =
    user?.callerIdDidId === null || user === null
      ? undefined
      : snapshot.dids.find(row => row.id === user.callerIdDidId);
  return did?.number ?? extensionOf(snapshot, { userId });
}

type PartyIdentity = Omit<
  Diversion,
  'number' | 'diversionNumber' | 'reason'
> & {
  number: string | null;
};

/** `party`'s number, name and extension: a user's primary number or extension, a ring group's
 * extension, a menu's called number, the one an inbound call dialled, else the tenant's main
 * number; `null` for a menu with neither, a main DID since deleted; a DID's own number and label, a
 * fallback's called number and its block's label. */
function partyIdentity(
  snapshot: Snapshot,
  call: Call,
  party: DivertingParty
): PartyIdentity {
  if ('userId' in party) {
    return {
      number: userNumber(snapshot, party.userId),
      name: userById(snapshot, party.userId)?.name ?? null,
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
  if ('didId' in party) {
    const did = snapshot.dids.find(row => row.id === party.didId);
    return {
      number: did?.number ?? null,
      name: did?.label ?? null,
      party: 'number',
      extension: null
    };
  }
  if ('fallbackBlockId' in party) {
    const block = snapshot.didBlocks.find(
      row => row.id === party.fallbackBlockId
    );
    return {
      number: call.to,
      name: block?.label ?? null,
      party: 'number',
      extension: null
    };
  }
  return {
    number:
      call.direction === 'inbound'
        ? call.to
        : diversionNumber(snapshot, call, party),
    name: snapshot.menus.find(row => row.id === party.menuId)?.name ?? null,
    party: 'menu',
    extension: null
  };
}

/**
 * The hop `party` makes for `reason`, with the party's numbers and name; `null` where it has no
 * `REDIRECTING` number to name, a menu of an internal call with no main number.
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

/** Records the hop tenant `number` makes to its own `target` when that is an `external` or `sip`
 * target, which a trunk leg dials: the number forwards unconditionally (§9.4 "Forwarded calls"). */
export function noteNumberForward(
  snapshot: Snapshot,
  call: Call,
  number: TenantNumber,
  target: ForwardTarget
): void {
  if (target.kind === 'external' || target.kind === 'sip') {
    noteDiversion(call, diversionFor(snapshot, call, number, 'cfu'));
  }
}

/** Records a blind transfer by `transferrerUserId` in its onward call's context: the
 * transferrer's deflection, the first hop of whatever leg the onward call forwards to (§9.4
 * "Forwarded calls"). */
export function noteBlindTransfer(
  snapshot: Snapshot,
  call: Call,
  transferrerUserId: string
): void {
  noteDiversion(
    call,
    diversionFor(snapshot, call, { userId: transferrerUserId }, 'deflection')
  );
}
