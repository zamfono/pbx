/**
 * A ring race's external leg (§10.1 step 4's find-me legs, step 5's member forwarded to an external
 * number), dialled "through the normal outbound resolution": `routeSelection.ts`'s route match,
 * pre-checks and caller identity, `trunkDial.ts`'s INVITE. Unlike `originateExternalLeg` it never
 * waits for an answer, since the leg rings alongside the race's other legs and the race decides who
 * wins or hangs it up. Route fallthrough and `ip`-host failover (§9.4) still apply: an attempt that
 * fails before alerting is replaced by the next one, and the race sees one leg throughout, ringing
 * on whichever attempt's channel is current.
 */
import { isE164, newId } from '@zamfono/shared';

import { ignoreGone, logFailure } from '../ari/failures.js';
import type { AttemptFailure } from '../routing/trunk.js';
import type { Call } from './call.js';
import {
  startBudget,
  unwatchAttempt,
  watchAttempt,
  type Attempt,
  type AttemptFailed
} from './externalAttempt.js';
import {
  nextCandidate,
  nextRoute,
  openCursor,
  type Candidate,
  type RouteCursor
} from './externalLegRoutes.js';
import type { ForwardLeg } from './forwardContext.js';
import type { Pipeline } from './pipeline.js';
import { originateTrunkLeg } from './trunkDial.js';

const SIP_SERVER_ERROR = 500;

// An attempt Asterisk would not place (its create or dial refused, `legOriginate.ts`) fails as a
// 500 before alerting would: the next host, then the next route, is tried (§9.4 "Route fallthrough").
const PLACEMENT_FAILED: AttemptFailure = {
  kind: 'final',
  code: SIP_SERVER_ERROR,
  alerted: false
};

/** How the race that owns the leg holds it; every channel id named here is one attempt's. */
export type ExternalLegOwner = {
  /** Tracks an attempt's channel, before its create, as one of the leg's still being placed. */
  place: (channelId: string) => void;
  /** Takes the attempt's channel, as its INVITE is sent, as the leg's ringing one; false once the
   * race is over, the channel then hung up as soon as it is placed. */
  track: (channelId: string) => boolean;
  /** Whether the race still rings `channelId`: false once it hung the leg up or settled. */
  ringing: (channelId: string) => boolean;
  /** Forgets `channelId` without counting it as the leg ending: superseded by the next attempt,
   * or never ringing at all. */
  retire: (channelId: string) => void;
  /** Ends the leg on `channelId` for good, as though that channel had ended with `cause`. */
  end: (channelId: string, cause: number | null) => void;
};

/** A leg's route cursor (`externalLegRoutes.ts`), with the number it dials, the race that holds
 * it and, for a forward target, the hops that led to it (§9.4 "Forwarded calls"). */
export type ExternalLeg = RouteCursor & {
  number: string;
  owner: ExternalLegOwner;
  forward: ForwardLeg | undefined;
};

/** What a race leg dials: `number` as `asUser`'s call through the matching routes, or, with
 * `trunkId`, a SIP target's user part over that trunk alone (§9.4 "SIP targets"). */
export type ExternalLegTarget = {
  number: string;
  asUser: string | null;
  trunkId?: string;
  forward?: ForwardLeg;
};

/** Whether an attempt was placed, and the channel holding the leg for the race now. */
type Placement = { placed: boolean; holder: string | null };

/** As `attempt`'s INVITE is sent, its channel takes the leg over from `holder`, the channel that
 * held it so far (`null` for the first), unless the race hung the leg up or settled meanwhile. */
function takeOver(attempt: Attempt, holder: string | null): boolean {
  const { owner } = attempt.leg;
  attempt.dialled = true;
  if (holder !== null && !owner.ringing(holder)) {
    return false;
  }
  if (!owner.track(attempt.channelId)) {
    return false;
  }
  if (holder !== null) {
    owner.retire(holder);
  }
  return true;
}

/** Places `candidate`'s attempt, its channel tracked by the race from before its create, and
 * hands it the leg as it is dialled (`takeOver`). One placed after the race hung the leg up is
 * hung up at once; a failed one is traced, the leg still held by whichever channel holds it.
 * `failover` is how the attempt goes on should its channel fail later. */
async function placeAttempt(
  leg: ExternalLeg,
  candidate: Candidate,
  holder: string | null,
  failover: (channelId: string) => AttemptFailed
): Promise<Placement> {
  const { pipeline, trunkState, call, number, owner, forward } = leg;
  const { trunk, identity, endpoint } = candidate;
  const channelId = newId();
  owner.place(channelId);
  const attempt = watchAttempt(leg, candidate, channelId, failover(channelId));
  // Set as the INVITE is sent, while the placement is still under way.
  const taken = { over: false };
  const trunkLeg = await originateTrunkLeg(
    { pipeline, call, trunkState, trunk, number, identity, forward },
    endpoint,
    channelId,
    () => {
      taken.over = takeOver(attempt, holder);
    }
  ).catch(() => null);
  const rang = taken.over;
  if (trunkLeg === null) {
    unwatchAttempt(attempt);
    if (!rang) {
      owner.retire(channelId);
    }
    call.log.event({
      event: 'attempt',
      routeId: candidate.route?.id ?? null,
      trunkId: trunk.id,
      endpoint,
      cause: 'placementFailed'
    });
    return { placed: false, holder: rang ? channelId : holder };
  }
  if (!rang) {
    owner.retire(channelId);
    pipeline.deps.ari.channels
      .hangup(channelId)
      .catch(ignoreGone)
      .catch(logFailure(pipeline.deps.logger, 'unrung attempt hangup'));
    return { placed: true, holder };
  }
  startBudget(attempt, trunkLeg);
  return { placed: true, holder: channelId };
}

/** Places `first`'s attempt, or the next ones should placing fail, to hold the leg in place of
 * `previous`, the attempt it replaces (`null` for the first). A leg none of whose attempts could
 * be placed ends for the race. An attempt that fails while the race rings the leg is replaced by
 * the next one, as §9.4 "Route fallthrough" or "Hosts" retries it, else ends the leg for the race,
 * as a device's end would. */
async function dialFrom(
  leg: ExternalLeg,
  first: Candidate,
  previous: string | null
): Promise<void> {
  const failover =
    (channelId: string): AttemptFailed =>
    (failure, cause) => {
      const next = nextCandidate(leg, failure);
      if (next === null) {
        leg.owner.end(channelId, cause);
        return;
      }
      dialFrom(leg, next, channelId).catch(
        logFailure(leg.pipeline.deps.logger, 'route fallthrough')
      );
    };
  let holder = previous;
  for (
    let candidate: Candidate | null = first;
    candidate !== null;
    candidate = nextCandidate(leg, PLACEMENT_FAILED)
  ) {
    // eslint-disable-next-line no-await-in-loop -- attempts are dialled one at a time, in fallthrough order
    const placement = await placeAttempt(leg, candidate, holder, failover);
    if (placement.placed) {
      return;
    }
    holder = placement.holder;
  }
  if (holder !== null) {
    leg.owner.end(holder, null);
  }
}

/**
 * Rings `target.number` as one of the race's legs: dialled as `target.asUser`'s own call (§9.4
 * "Outbound routing": a user's forwards and find-me legs count as that user's calls), which picks
 * the routes, the presented number and the CLIR level, or a SIP target's user part over its own
 * trunk. A number no route carries is not rung, with a line at level `events`, and the race rings
 * on without it.
 */
export async function ringExternalLeg(
  pipeline: Pipeline,
  call: Call,
  target: ExternalLegTarget,
  owner: ExternalLegOwner
): Promise<void> {
  const { trunkState } = pipeline.deps;
  const dialable = target.trunkId !== undefined || isE164(target.number);
  if (trunkState === null || !dialable) {
    call.log.event({ event: 'externalLegUnrouted', number: target.number });
    return;
  }
  const snapshot = await pipeline.deps.cache.get();
  const leg: ExternalLeg = {
    ...openCursor({ pipeline, trunkState, call, snapshot }, target),
    number: target.number,
    owner,
    forward: target.forward
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
