/**
 * A ring race settling without an answer (§10.1 step 4): the timeout, or the last ringing leg
 * ending, and the busy/noAnswer outcome that follows. Its own module so `legsEnded.ts`, the end
 * of a call's answered legs and caller, stays under the repository's `max-lines` lint rule.
 */
import { logFailure } from '../ari/failures.js';
import { AST_CAUSE_USER_BUSY } from '../sipCodes.js';
import type { Call, Leg } from './call.js';
import { clearFindMeTimers, findMeLegsPending } from './findMe.js';
import { endLeg, hangupLeg, type RingResolver } from './legs.js';
import type { Pipeline } from './pipeline.js';

// `ChannelDestroyed.cause` is Asterisk's Q.850 hangup cause: AST_CAUSE_USER_BUSY for SIP 486/600
// (§10.1 step 4 speaks of the SIP codes; this is Asterisk's own mapping of them). A 603 decline
// maps to AST_CAUSE_CALL_REJECTED instead, which step 4 does not count as busy.
/** Step 4's busy/noAnswer split: busy only once every device leg has answered 486 or 600; any
 * other end, a 603 decline included, leaves the ring to the `noAnswer` rule. */
function ringOutcome(call: Call): 'busy' | 'noAnswer' {
  const deviceLegs = [...call.legs.values()].filter(
    leg => leg.kind === 'device'
  );
  const everyDeviceBusy =
    deviceLegs.length > 0 &&
    deviceLegs.every(leg => leg.endCause === AST_CAUSE_USER_BUSY);
  return everyDeviceBusy ? 'busy' : 'noAnswer';
}

/**
 * Settles `call`'s ring race without an answer: the timeout, or the last leg ending (§10.1 step 4).
 * A race whose answer is claimed and still being bridged is won already (`winLeg`), though no leg
 * of it rings any more: nothing settles it but that win. With `ring`, only that race is settled:
 * a ring on a user's own phones that already handed its answer over (`ownDevices.ts`) may still
 * be placing its last device while the call's next ring, the click-to-dial's target, has begun.
 */
export function concludeRing(
  pipeline: Pipeline,
  call: Call,
  ring?: RingResolver
): void {
  const pending = pipeline.pendingRing.get(call.id);
  if (
    pending === undefined ||
    pending.won === true ||
    (ring !== undefined && pending !== ring)
  ) {
    return;
  }
  pipeline.pendingRing.delete(call.id);
  clearTimeout(pending.timer);
  clearFindMeTimers(pipeline, call.id);
  // Read before hanging up the still-ringing legs, so a timeout's hangup is never mistaken for a busy decline.
  const outcome = ringOutcome(call);
  for (const leg of call.legs.values()) {
    if (leg.state === 'ringing') {
      hangupLeg(pipeline, leg).catch(
        logFailure(pipeline.deps.logger, 'ringing leg hangup', {
          callId: call.id
        })
      );
    }
  }
  pending.resolve(outcome);
}

/** A ringing leg ended with Q.850 `cause`; the ring race ends once none is still ringing, being
 * placed, nor, as a find-me leg, still to come (§10.1 step 4). */
export function endRingingLeg(
  pipeline: Pipeline,
  call: Call,
  leg: Leg,
  cause: number | null
): void {
  leg.endCause = cause;
  call.log.event({ event: 'declined', channelId: leg.channelId, cause });
  endLeg(pipeline, leg.channelId, leg);
  const stillRinging = [...call.legs.values()].some(
    other => other.state === 'ringing'
  );
  const placing = pipeline.pendingRing.get(call.id)?.placing ?? 0;
  if (!stillRinging && placing === 0 && !findMeLegsPending(pipeline, call.id)) {
    concludeRing(pipeline, call);
  }
}

/** Places every one of `items` at once (§9.3 "One endpoint per device": the core dials a user's
 * devices in parallel), each counted on `call`'s ring race while it is still being placed. */
export async function placeAll<T>(
  pipeline: Pipeline,
  call: Call,
  items: readonly T[],
  place: (item: T) => Promise<void>
): Promise<void> {
  const pending = pipeline.pendingRing.get(call.id);
  if (pending !== undefined) {
    pending.placing += items.length;
  }
  await Promise.all(
    items.map(item =>
      place(item).finally(() => {
        if (pending !== undefined) {
          pending.placing -= 1;
        }
      })
    )
  );
}
