/**
 * The parked calls as `GET /internal/parking` serves them (§10.2 "Call parking"): every occupied
 * slot, which every user's BLF shows, with the parked party's number as the phones show it. Its
 * own module beside `parking.ts`, which owns the slot registry.
 */
import { ANONYMOUS, type ParkedCall } from '@zamfono/shared';

import { fromOf } from './onwardCall.js';
import type { Pipeline } from './pipeline.js';

/** One entry per occupied slot, by slot: a withheld caller's number is none (§9.4 "Withheld
 * caller"). */
export async function parkedCalls(pipeline: Pipeline): Promise<ParkedCall[]> {
  const snapshot = await pipeline.deps.cache.get();
  return [...pipeline.parkingSlots]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([slot, entry]) => {
      const number = fromOf(entry.call, entry.partyChannelId, snapshot);
      return {
        slot,
        callId: entry.call.id,
        caller: number === ANONYMOUS ? null : number,
        parkedAt: entry.parkedAt,
        parkedByUserId: entry.parkerUserId
      };
    });
}
