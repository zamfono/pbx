/** A park by blind transfer (§10.2 "Call parking"): a `REFER` to the park code or to a parking
 * slot, the way a phone's park key or a slot's BLF key parks; `parking.ts` owns the slot
 * registry. */
import { ignoreGone } from '../ari/failures.js';
import { callerChannel, type Call } from './call.js';
import { holdInSlot, holdParty, lowestFreeSlot } from './parking.js';
import { ringParkerBack } from './parkingRingback.js';
import type { Pipeline } from './pipeline.js';

/**
 * A blind transfer to `*70` or to parking slot `slot`, which is how a phone's park key or a slot's
 * BLF key parks (a `REFER`): the transferee, `call`'s own caller, is parked for the transferrer on
 * `slot`, or with `*70` on the lowest free slot, and `call`, the transfer's onward call, is the
 * parked call from here on. The transferrer's phone has left the call, so nobody hears the slot.
 * With `slot` taken or no slot free, the transferrer is rung back at once, as on a timeout, so the
 * transferee is never dropped.
 */
export async function parkTransferee(
  pipeline: Pipeline,
  call: Call,
  transferrerUserId: string,
  slot: string | null
): Promise<void> {
  const snapshot = await pipeline.deps.cache.get();
  const slots = pipeline.parkingSlots;
  // `null` for a taken slot, as for no free one: the transferrer is rung back.
  const free = (ext: string): string | null => (slots.has(ext) ? null : ext);
  const ext = slot === null ? lowestFreeSlot(snapshot, slots) : free(slot);
  const partyChannelId = callerChannel(call);
  // Taken in by the park, the call ends as answered, as a parked call does (§10.2).
  call.status = 'answered';
  await pipeline.deps.ari.channels.answer(partyChannelId).catch(ignoreGone);
  if (ext === null) {
    await holdParty(pipeline, snapshot, call, partyChannelId);
    call.log.event({
      event: 'parkFailed',
      by: transferrerUserId,
      ...(slot === null
        ? { reason: 'noFreeSlot' }
        : { ext: slot, reason: 'slotTaken' })
    });
    await ringParkerBack(pipeline, {
      parkerUserId: transferrerUserId,
      parked: call,
      partyChannelId
    });
    return;
  }
  await holdInSlot(
    pipeline,
    pipeline.deps.presence,
    call,
    { ext, parkerUserId: transferrerUserId, partyChannelId },
    {}
  );
}
