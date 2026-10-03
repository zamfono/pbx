/**
 * Parking over the internal API (§10.2 "Call parking"): `POST /internal/calls/{id}/park` parks a
 * call's other party the way `*70` does, through `parking.ts`'s `parkParty`, and
 * `GET /internal/parking` lists the occupied slots (`parkingView.ts`). `actions.ts` mounts both.
 */
import { HTTP_CONFLICT, type ParkRequest } from '@zamfono/shared';

import { ActionError, notBridged } from './actionError.js';
import type { Call } from './call.js';
import { bridgedParty, channelOf } from './callLookup.js';
import { parkParty } from './parking.js';
import type { Pipeline } from './pipeline.js';

/** `req.userId` parks the other party of `call` as `*70` would. No feature dial hears the slot,
 * so it is returned instead; the parker's own channel in the call is hung up as `*70` hangs it
 * up. 409 when `req.userId` has no channel in the call (`notInCall`), the call is not bridged
 * (`notBridged`, a party added to a call included) or every slot is taken (`noFreeSlot`). */
export async function parkOnRequest(
  pipeline: Pipeline,
  call: Call,
  req: ParkRequest
): Promise<{ slot: string }> {
  const { presence } = pipeline.deps;
  const channelId = channelOf(call, req.userId);
  if (channelId === null) {
    throw new ActionError(
      HTTP_CONFLICT,
      'notInCall',
      'the user is not in the call'
    );
  }
  const conversation = bridgedParty(call, channelId);
  if (conversation === null) {
    throw notBridged();
  }
  const slot = await parkParty(
    pipeline,
    presence,
    call,
    { ...req, channelId },
    conversation
  );
  if (slot === null) {
    throw new ActionError(
      HTTP_CONFLICT,
      'noFreeSlot',
      'no parking slot is free'
    );
  }
  return { slot };
}
