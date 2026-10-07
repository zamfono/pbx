/**
 * What a trunk leg dialled for a forward target or a blind transfer carries of its call's
 * forwarding context (§9.4 "Forwarded calls", `forwardContext.ts`): the `REDIRECTING` data, the
 * `Diversion` its trunk's policy sends, written by `forwardDiversion.ts`, the identity header of a
 * leg that presents the original caller (`forwardedCaller.ts`), and a `sip` target's headers,
 * rendered by `forwardHeaders.ts`.
 */
import type { Diversion } from './forwardContext.js';
import { diversionHeader, type DiversionTrunk } from './forwardDiversion.js';
import { headerVariables, type SipHeader } from './forwardHeaders.js';

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

/** A trunk leg dialled for a forward target, or for a blind transfer: the hops
 * that led to it, the call's own and, for a ring-group member's followed forward, the member's
 * (§10.1 step 5), and the headers it sends, a `sip` target's rendered for it and none for an
 * `external` one (§9.4 "Forwarded calls"). */
export type ForwardLeg = {
  diversions: Diversion[];
  headers: SipHeader[];
  /** The user whose unconditional forward the leg dials (`Leg.standsInFor`). */
  standsInFor?: string;
  /** The target the leg dials records its calls (`Leg.targetRecords`). */
  targetRecords?: true;
};

/** The user whose own rule forwards a call (§10.1 step 7), whose call an external or SIP target is
 * dialled as; `standsIn` for their `unconditional` rule, whose trunk leg then is their
 * participation (§10.2 "Effective flag"). */
export type Forwarder = { userId: string; standsIn: boolean };

/** The `ForwardLeg.standsInFor` of a leg `forwarder` forwards to. */
export function standInOf(
  forwarder: Forwarder | null
): Pick<ForwardLeg, 'standsInFor'> {
  return forwarder?.standsIn === true ? { standsInFor: forwarder.userId } : {};
}

/** The `ForwardLeg.targetRecords` of a leg dialled for `target` (§10.2 "Recording semantics"). */
export function recordingOf(target: {
  record?: true;
}): Pick<ForwardLeg, 'targetRecords'> {
  return target.record === true ? { targetRecords: true } : {};
}

/** The forwarding context `forward`'s leg carries over `trunk` (§9.4 "Forwarded calls"): its
 * `REDIRECTING` data, the `Diversion` the trunk's policy sends, the identity header of a leg that
 * presents the original caller (`forwardedCaller.ts`) and its headers, every header the leg adds,
 * so any other joins them here. */
export function forwardVariables(
  forward: ForwardLeg,
  trunk: DiversionTrunk,
  identity: SipHeader | null
): Record<string, string> {
  const diversion = diversionHeader(forward.diversions, trunk);
  return {
    ...redirectingVariables(forward.diversions),
    ...(diversion === null
      ? {}
      : headerVariables([{ name: 'Diversion', value: diversion }])),
    ...(identity === null ? {} : headerVariables([identity])),
    ...headerVariables(forward.headers)
  };
}
