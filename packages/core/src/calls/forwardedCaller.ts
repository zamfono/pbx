/**
 * What a forwarded or blind-transferred trunk leg presents under its trunk's
 * `trunks.forwarded_caller_id` (§9.4 "Forwarded calls"): with `original` or `originalPreferred`,
 * the original caller as the leg's caller ID, which chan_pjsip puts in `From`, and the number the
 * leg presents under `own` in one `P-Asserted-Identity` or `P-Preferred-Identity` the core adds
 * beside its `Diversion`. A `from` trunk's endpoint, the only layout the API allows it on, has
 * neither `send_pai` nor `send_rpid`, so chan_pjsip adds no identity header of its own.
 */
import { isE164 } from '@zamfono/shared';

import { formatCallerId } from '../routing/trunk.js';
import type { Call } from './call.js';
import type { AttemptIdentity, TrunkRow } from './callerIdentity.js';
import { diversionHeader, type DiversionTrunk } from './forwardDiversion.js';
import type { SipHeader } from './forwardHeaders.js';
import type { ForwardLeg } from './forwardLeg.js';

const IDENTITY_HEADERS = {
  original: 'P-Asserted-Identity',
  originalPreferred: 'P-Preferred-Identity'
} as const;

/** The original caller a leg presents, and the header naming the tenant's own number. */
export type OriginalCaller = { number: string; identity: SipHeader };

/** One trunk leg's attempt: its trunk, the hops it carries, its own caller ID and its `Diversion`
 * settings. */
type ForwardedAttempt = {
  trunk: TrunkRow;
  forward: ForwardLeg;
  identity: AttemptIdentity;
  diversion: DiversionTrunk;
};

/**
 * The original caller `attempt` presents on `call`, `null` where it presents its own number: under
 * `own`; for a caller who is no inbound outside caller with a transmitted number, a withheld or
 * internal one; for a withheld leg; and for a leg that sends no `Diversion`, by which the carrier
 * recognises the forwarding (§120 (2) TKG allows the caller's number on a forwarded call alone).
 */
export function originalCaller(
  call: Call,
  attempt: ForwardedAttempt
): OriginalCaller | null {
  const { trunk, forward, identity, diversion } = attempt;
  if (
    trunk.forwardedCallerId === 'own' ||
    identity.withhold ||
    diversion.host === null ||
    call.direction !== 'inbound' ||
    call.callerUserId !== null ||
    !isE164(call.from) ||
    diversionHeader(forward.diversions, diversion) === null
  ) {
    return null;
  }
  return {
    number: formatCallerId(call.from, trunk.callerIdFormat, diversion.country),
    identity: {
      name: IDENTITY_HEADERS[trunk.forwardedCallerId],
      value: `<sip:${identity.number}@${diversion.host}>`
    }
  };
}
