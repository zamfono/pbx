/**
 * A ring race's external leg (§10.1 step 4's find-me legs, step 5's member forwarded to an external
 * number), dialled "through the normal outbound resolution": `routeSelection.ts`'s route match,
 * pre-checks and caller identity, `trunkDial.ts`'s INVITE. Unlike `originateExternalLeg` it never
 * waits for an answer, since the leg rings alongside the race's other legs and the race decides who
 * wins or hangs it up. Route fallthrough and `ip`-host failover (§9.4) still apply: an attempt that
 * fails before alerting is replaced by the next one, and the race sees one leg throughout, ringing
 * on whichever attempt's channel is current.
 */
import { isE164 } from '@zamfono/shared';

import type { AriEvent } from '../ari/types.js';
import type { Call } from './call.js';
import { recordEvents, redeliverEarlyEvents } from './earlyEvents.js';
import { endAttempt, watchAttempt } from './externalAttempt.js';
import {
  nextCandidate,
  nextRoute,
  openCursor,
  type Candidate,
  type RouteCursor
} from './externalLegRoutes.js';
import type { Pipeline } from './pipeline.js';
import type { TrunkLeg } from './provisional.js';
import { originateTrunkLeg } from './trunkDial.js';

const SIP_SERVER_ERROR = 500;

/** How the race that owns the leg holds it; every channel id named here is one attempt's. */
export type ExternalLegOwner = {
  /** Tracks a newly originated attempt as the leg's ringing channel. */
  track: (channelId: string) => void;
  /** Whether the race still rings `channelId`: false once it hung the leg up or settled. */
  ringing: (channelId: string) => boolean;
  /** Forgets `channelId`, superseded by the next attempt, without counting it as the leg ending. */
  retire: (channelId: string) => void;
  /** Ends the leg on `channelId` for good, as though that channel had ended with `cause`. */
  end: (channelId: string, cause: number | null) => void;
};

/** A leg's route cursor (`externalLegRoutes.ts`), with the number it dials and the race that holds it. */
export type ExternalLeg = RouteCursor & {
  number: string;
  owner: ExternalLegOwner;
};

/** Watches the newly originated `trunkLeg` and hands it to the race in place of `previous`, or
 * hangs it up when the race hung the leg up, or settled, while it was being originated. */
function takeOver(
  leg: ExternalLeg,
  candidate: Candidate,
  trunkLeg: TrunkLeg,
  previous: string | null
): void {
  const { pipeline, owner } = leg;
  const channelId = trunkLeg.id;
  watchAttempt(leg, candidate, trunkLeg);
  if (previous !== null && !owner.ringing(previous)) {
    pipeline.deps.ari.channels.hangup(channelId).catch(() => undefined);
    return;
  }
  owner.track(channelId);
  if (previous !== null) {
    owner.retire(previous);
  }
}

/** Originates `candidate`'s attempt, or the next ones should originating fail, and hands the
 * channel to the race in place of `previous`, the attempt it replaces (`null` for the first). */
async function dialFrom(
  leg: ExternalLeg,
  first: Candidate,
  previous: string | null
): Promise<void> {
  const { pipeline, trunkState, call, number, owner } = leg;
  for (
    let candidate: Candidate | null = first;
    candidate !== null;
    candidate = nextCandidate(leg, {
      kind: 'final',
      code: SIP_SERVER_ERROR,
      alerted: false
    })
  ) {
    const { trunk, identity, endpoint } = candidate;
    const early = recordEvents(pipeline.deps.ari);
    // eslint-disable-next-line no-await-in-loop -- attempts are dialled one at a time, in fallthrough order
    const trunkLeg = await originateTrunkLeg(
      { pipeline, call, trunkState, trunk, number, identity },
      endpoint
    ).catch(() => null);
    if (trunkLeg !== null) {
      takeOver(leg, candidate, trunkLeg, previous);
      redeliverEarlyEvents(pipeline.deps.ari, early, trunkLeg.id);
      return;
    }
    early.stop();
    call.log.event({
      event: 'attempt',
      routeId: candidate.route.id,
      trunkId: trunk.id,
      endpoint,
      cause: 'placementFailed'
    });
  }
  if (previous !== null) {
    owner.end(previous, null);
  }
}

/**
 * For the race's own `ChannelDestroyed` of a leg it still rings: whether the leg dials on, because
 * the attempt failed before alerting in a way §9.4 "Route fallthrough" or "Hosts" retries and a
 * next host or route remains; the race then keeps the leg ringing rather than counting it ended.
 * Any other end — after alerting, on the callee's own condition, the routes exhausted — is the
 * leg's own, for the race to handle as it would a device's.
 */
export function externalAttemptDialsOn(
  pipeline: Pipeline,
  channelId: string,
  destroyed: AriEvent
): boolean {
  const ended = endAttempt(pipeline, channelId, destroyed);
  if (ended === null) {
    return false;
  }
  const next = nextCandidate(ended.leg, ended.failure);
  if (next === null) {
    return false;
  }
  dialFrom(ended.leg, next, channelId).catch(() => undefined);
  return true;
}

/**
 * Rings `target.number` as one of the race's legs: dialled as `target.asUser`'s own call (§9.4
 * "Outbound routing": a user's forwards and find-me legs count as that user's calls), which picks
 * the routes, the presented number and the CLIR level. A number no route carries is not rung,
 * with a line at level `events`, and the race rings on without it.
 */
export async function ringExternalLeg(
  pipeline: Pipeline,
  call: Call,
  target: { number: string; asUser: string | null },
  owner: ExternalLegOwner
): Promise<void> {
  const { trunkState } = pipeline.deps;
  if (trunkState === null || !isE164(target.number)) {
    call.log.event({ event: 'externalLegUnrouted', number: target.number });
    return;
  }
  const snapshot = await pipeline.deps.cache.get();
  const leg: ExternalLeg = {
    ...openCursor({ pipeline, trunkState, call, snapshot }, target),
    number: target.number,
    owner
  };
  const first = nextRoute(leg);
  if (first === null) {
    call.log.event({
      event: 'externalLegUnrouted',
      number: target.number,
      cause: leg.lastFailureKind ?? 'noRoute'
    });
    return;
  }
  await dialFrom(leg, first, null);
}
