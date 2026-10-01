/**
 * Parking over the internal API (§10.2 "Call parking"): `POST /internal/calls/{id}/park` parks a
 * call's other party the way `*70` does, through `parking.ts`'s `parkParty`, and
 * `GET /internal/parking` lists the occupied slots (`parkingView.ts`). `actions.ts` mounts both.
 */
import type { ParkRequest } from '@zamfono/shared';

import { ActionError } from './actionError.js';
import type { Call } from './call.js';
import { parkParty, type ParkRefusal } from './parking.js';
import type { Pipeline } from './pipeline.js';

const HTTP_CONFLICT = 409;
// The problem titles of a refused park, each answered as a 409 whose `detail` is the reason.
const PARK_REFUSALS: Record<ParkRefusal, string> = {
  notInCall: 'the user is not in the call',
  notBridged: 'call is not bridged',
  noFreeSlot: 'no parking slot is free'
};

/** `req.userId` parks the other party of `call` as `*70` would. No feature dial hears the slot,
 * so it is returned instead; the parker's own channel in the call is hung up as `*70` hangs it
 * up. */
export async function parkOnRequest(
  pipeline: Pipeline,
  call: Call,
  req: ParkRequest
): Promise<{ slot: string }> {
  const { presence } = pipeline.deps;
  if (presence === null) {
    throw new Error('park: presence is not wired');
  }
  const outcome = await parkParty(pipeline, presence, call, req);
  if ('refused' in outcome) {
    const reason = outcome.refused;
    throw new ActionError(HTTP_CONFLICT, reason, PARK_REFUSALS[reason]);
  }
  return { slot: outcome.ext };
}
