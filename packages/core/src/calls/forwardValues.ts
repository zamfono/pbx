/**
 * The values a call's placeholders stand for (§9.4 "Templates"), read from the call, its forward
 * hops and the config snapshot, as a `sip` target's headers on one forwarded leg and every other
 * template of the call render with them. `@zamfono/shared` renders; this gathers.
 */
import {
  isE164,
  renderSipHeaders,
  type CallValues,
  type SipHeader
} from '@zamfono/shared';

import { logFailure } from '../ari/failures.js';
import { userById, type Snapshot } from '../internal/snapshot.js';
import type { ForwardTarget } from '../routing/targets.js';
import type { Call } from './call.js';
import { callerNumber, contactName } from './contactName.js';
import type { Diversion, RedirectingReason } from './forwardContext.js';
import type { ForwardLeg } from './forwardLeg.js';
import type { Pipeline } from './pipeline.js';

/** A hop's `REDIRECTING` reason as `{{forwardReason}}` names it, in the wire's camelCase. */
const FORWARD_REASONS = {
  away: 'outOfOffice',
  time_of_day: 'closed',
  cfu: 'unconditional',
  cfb: 'busy',
  cfnr: 'noAnswer',
  unavailable: 'unavailable',
  dnd: 'dnd',
  deflection: 'deflection'
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
): CallValues {
  const called = diversions.find(
    hop => hop.party === 'user' || hop.party === 'ringGroup'
  );
  const last = diversions.at(-1);
  return {
    callerNumber: callerNumber(call.from),
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
 * name, else empty. A failed lookup is logged and reads as no name, since a header never holds
 * up a call. */
export async function callerNameOf(
  pipeline: Pipeline,
  call: Call,
  snapshot: Snapshot
): Promise<string> {
  const contact =
    (await contactName(pipeline.deps.db, call.from).catch(
      logFailure(pipeline.deps.logger, 'phone book lookup', { callId: call.id })
    )) ?? '';
  if (contact !== '') {
    return contact;
  }
  return userById(snapshot, call.callerUserId)?.name ?? '';
}

/** The caller's name, looked up once per call. */
function cachedCallerName(
  pipeline: Pipeline,
  call: Call,
  snapshot: Snapshot
): Promise<string> {
  call.callerName ??= callerNameOf(pipeline, call, snapshot);
  return call.callerName;
}

/** What `call`'s templates render with right now (§9.4 "Templates"): its placeholders after the
 * forward hops taken so far, and its variables, a placeholder winning over a variable of its
 * name. */
export async function templateValues(
  pipeline: Pipeline,
  call: Call,
  snapshot: Snapshot
): Promise<Record<string, unknown>> {
  return {
    ...call.variables,
    ...forwardValues(
      call,
      call.diversions,
      snapshot,
      await cachedCallerName(pipeline, call, snapshot)
    )
  };
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
  const callerName = await cachedCallerName(pipeline, call, snapshot);
  return renderSipHeaders(
    target.headers,
    forwardValues(call, diversions, snapshot, callerName),
    call.variables
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
