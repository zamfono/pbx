/**
 * The values a `sip` target's header placeholders stand for on one forwarded leg (§9.4 "Header
 * templates"), read from the call, its forward hops and the config snapshot, and the headers the
 * leg sends with them. `forwardHeaders.ts` renders them; this gathers them.
 */
import { ANONYMOUS, isE164 } from '@zamfono/shared';

import type { Snapshot } from '../internal/server.js';
import type { ForwardTarget } from '../routing/targets.js';
import type { Call } from './call.js';
import { contactName } from './contactName.js';
import type {
  Diversion,
  ForwardLeg,
  RedirectingReason
} from './forwardContext.js';
import {
  renderForwardHeaders,
  type ForwardValues,
  type SipHeader
} from './forwardHeaders.js';
import type { Pipeline } from './pipeline.js';

/** A hop's `REDIRECTING` reason as `{{forwardReason}}` names it, in the wire's camelCase. */
const FORWARD_REASONS = {
  away: 'outOfOffice',
  // eslint-disable-next-line camelcase -- Asterisk's own REDIRECTING reason
  time_of_day: 'closed',
  cfu: 'unconditional',
  cfb: 'busy',
  cfnr: 'noAnswer',
  unavailable: 'unavailable',
  dnd: 'dnd'
} as const satisfies Record<RedirectingReason, string>;

/**
 * The placeholder values of a leg `diversions` led to on `call`, `callerName` looked up already:
 * the called party is the first hop's diverting user or ring group, the one the call was for,
 * and the forwarding party the last hop's, whatever its kind.
 */
export function forwardValues(
  call: Call,
  diversions: Diversion[],
  snapshot: Snapshot,
  callerName: string
): ForwardValues {
  const called = diversions.find(hop => hop.party !== 'menu');
  const last = diversions.at(-1);
  return {
    callerNumber: call.from === ANONYMOUS ? '' : call.from,
    callerName,
    did: call.direction === 'inbound' && isE164(call.to) ? call.to : '',
    calledExtension: called?.extension ?? '',
    calledName: called?.name ?? '',
    forwardedByExtension: last?.extension ?? '',
    forwardedByName: last?.name ?? '',
    forwardReason: last === undefined ? '' : FORWARD_REASONS[last.reason],
    hopCount: String(diversions.length),
    callId: call.id,
    direction: call.direction,
    language: snapshot.settings.language,
    startedAt: call.startedAt
  };
}

/** The caller's name (§10.2 "Phone book"): the phone book's, else an internal caller's own user
 * name, else empty. A failed lookup reads as no name, since a header never holds up a call. */
async function callerNameOf(
  pipeline: Pipeline,
  call: Call,
  snapshot: Snapshot
): Promise<string> {
  const { db } = pipeline.deps;
  const contact =
    db === undefined ? '' : await contactName(db, call.from).catch(() => '');
  if (contact !== '') {
    return contact;
  }
  return call.callerUserId === null
    ? ''
    : (snapshot.users.find(row => row.id === call.callerUserId)?.name ?? '');
}

/** The headers a leg to `target` sends after `diversions` (§9.4 "Header templates"). */
async function sipTargetHeaders(
  pipeline: Pipeline,
  call: Call,
  target: Extract<ForwardTarget, { kind: 'sip' }>,
  diversions: Diversion[],
  snapshot: Snapshot
): Promise<SipHeader[]> {
  if (target.headers.length === 0) {
    return [];
  }
  const callerName = await callerNameOf(pipeline, call, snapshot);
  return renderForwardHeaders(
    target.headers,
    forwardValues(call, diversions, snapshot, callerName)
  );
}

/** The leg `diversions` lead to at a `sip` target, with its rendered headers (§9.4 "Forwarded
 * calls"); an `external` target's is `{ diversions, headers: [] }`, built without a wait. */
export async function sipForwardLeg(
  pipeline: Pipeline,
  call: Call,
  target: Extract<ForwardTarget, { kind: 'sip' }>,
  diversions: Diversion[],
  snapshot: Snapshot
): Promise<ForwardLeg> {
  return {
    diversions,
    headers: await sipTargetHeaders(
      pipeline,
      call,
      target,
      diversions,
      snapshot
    )
  };
}
