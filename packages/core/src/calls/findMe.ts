/**
 * Find-me legs (§10.1 step 4): the delayed external legs a user's `find_me` list adds to their own
 * ring, and the accept prompt that keeps a voicemail box on the far end from swallowing the call.
 */
import { MS_PER_SECOND } from '@zamfono/shared';

import { defaultPrompt } from '../prompts.js';
import type { Call, Leg } from './call.js';
import { ringExternalLeg, type ExternalLegOwner } from './externalLeg.js';
import {
  endLeg,
  hangupLeg,
  trackLeg,
  type FindMeAcceptWait,
  type RingResolver
} from './legs.js';
import type { Pipeline } from './pipeline.js';
import { playAndWait } from './playback.js';
import { concludeRing, endRingingLeg } from './ringConclusion.js';

type FindMeEntry = { number: string; delayS: number };

/** A find-me leg not accepted within this window is dropped (§10.1 step 4, fixed, not
 * configurable). It counts from the end of the accept prompt, so the answering party always hears
 * the whole prompt first, in every tenant language (the French one alone runs over 5 s). */
const FIND_ME_ACCEPT_TIMEOUT_MS = 5000;

export const FIND_ME_ACCEPT_DIGIT = '1';

/** The prompt's "or 2 to reject it": the leg is dropped at once, as a leg not accepted is. */
export const FIND_ME_REJECT_DIGIT = '2';

export function clearFindMeTimers(pipeline: Pipeline, callId: string): void {
  for (const timer of pipeline.findMeTimers.get(callId) ?? []) {
    clearTimeout(timer);
  }
  pipeline.findMeTimers.delete(callId);
}

/** The single-user ring race `ring` as an external leg's owner (`externalLeg.ts`): each attempt's
 * channel is a `findMe` leg of `call`, and a superseded attempt leaves the race without counting
 * as ended. */
function findMeOwner(
  pipeline: Pipeline,
  call: Call,
  userId: string,
  ring: RingResolver
): ExternalLegOwner {
  const ringingLeg = (channelId: string): Leg | null => {
    const leg = call.legs.get(channelId);
    return leg?.state === 'ringing' ? leg : null;
  };
  return {
    track: channelId => {
      const leg: Leg = {
        channelId,
        kind: 'findMe',
        userId,
        state: 'ringing',
        endCause: null
      };
      trackLeg(pipeline, call, leg);
      call.log.event({ event: 'rungFindMe', channelId, userId });
      // The race may have settled while this attempt was being originated, the call ringing on
      // for its next target by now (a `noAnswer` forward to another user): never a leg of that.
      if (pipeline.pendingRing.get(call.id) !== ring) {
        hangupLeg(pipeline, leg).catch(() => undefined);
      }
    },
    ringing: channelId => ringingLeg(channelId) !== null,
    retire: channelId => {
      const leg = ringingLeg(channelId);
      if (leg !== null) {
        endLeg(pipeline, channelId, leg);
        call.legs.delete(channelId);
      }
    },
    end: (channelId, cause) => {
      const leg = ringingLeg(channelId);
      if (leg !== null) {
        endRingingLeg(pipeline, call, leg, cause);
      }
    }
  };
}

/** One find-me entry's leg, dialled through the normal outbound resolution as `userId`'s own call
 * (§10.1 step 4, §9.4 "Outbound routing"), unless the ring race is already over. */
async function originateFindMeLeg(
  pipeline: Pipeline,
  call: Call,
  userId: string,
  entry: FindMeEntry
): Promise<void> {
  const ring = pipeline.pendingRing.get(call.id);
  if (ring === undefined) {
    return;
  }
  await ringExternalLeg(
    pipeline,
    call,
    { number: entry.number, asUser: userId },
    findMeOwner(pipeline, call, userId, ring)
  );
}

/** Whether one of `callId`'s find-me legs is still to come: its `delayS` not yet elapsed, or its
 * originate still under way. Such a leg keeps the ring race open (§10.1 step 4, "every leg has
 * ended"); `pipeline.findMeTimers` holds exactly those entries' timers. */
export function findMeLegsPending(pipeline: Pipeline, callId: string): boolean {
  return (pipeline.findMeTimers.get(callId)?.length ?? 0) > 0;
}

/** A find-me entry's leg is out of the "still to come" set: ringing, ended or never routed. The
 * last of them settles a race whose other legs have all ended already. */
function settleFindMeEntry(
  pipeline: Pipeline,
  call: Call,
  timer: ReturnType<typeof setTimeout>
): void {
  const timers = pipeline.findMeTimers.get(call.id);
  // A race already settled cleared its entry; a later ring of the call holds timers of its own.
  const index = timers?.indexOf(timer) ?? -1;
  if (timers === undefined || index === -1) {
    return;
  }
  timers.splice(index, 1);
  const stillRinging = [...call.legs.values()].some(
    leg => leg.state === 'ringing'
  );
  if (timers.length === 0 && !stillRinging) {
    concludeRing(pipeline, call);
  }
}

export function scheduleFindMeLegs(
  pipeline: Pipeline,
  call: Call,
  userId: string,
  entries: FindMeEntry[]
): void {
  const timers = entries.map(entry => {
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      originateFindMeLeg(pipeline, call, userId, entry)
        .catch(() => undefined)
        .finally(() => {
          settleFindMeEntry(pipeline, call, timer);
        });
    }, entry.delayS * MS_PER_SECOND);
    timer.unref();
    return timer;
  });
  pipeline.findMeTimers.set(call.id, timers);
}

/**
 * The find-me accept prompt (§10.1 step 4: "hears a short prompt and presses `1` to accept"),
 * played in the channel's language, which the leg was originated with (§9.1). The accept window
 * opens once the prompt has played out; a key pressed while it still plays counts already
 * (`legs.ts`'s `handleDtmf`).
 */
export function beginFindMeAccept(
  pipeline: Pipeline,
  call: Call,
  leg: Leg
): void {
  const wait: FindMeAcceptWait = { call, leg, timer: undefined };
  pipeline.pendingFindMeAccept.set(leg.channelId, wait);
  playAndWait(
    pipeline.deps.ari,
    leg.channelId,
    defaultPrompt('findMeAccept'),
    `${leg.channelId}:findMeAccept`
  )
    .then(() => {
      if (pipeline.pendingFindMeAccept.get(leg.channelId) !== wait) {
        return;
      }
      wait.timer = setTimeout(() => {
        if (leg.state === 'ringing') {
          hangupLeg(pipeline, leg).catch(() => undefined);
        }
      }, FIND_ME_ACCEPT_TIMEOUT_MS);
      wait.timer.unref();
    })
    .catch(() => undefined);
}
