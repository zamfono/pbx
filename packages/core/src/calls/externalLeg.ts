/**
 * A ring race's external leg (§10.1 step 4's find-me legs, step 5's member forwarded to an external
 * number), dialled "through the normal outbound resolution": the route cursor
 * (`externalLegRoutes.ts`) and the attempts (`externalAttempt.ts`) of every outbound dial. Unlike
 * `originateExternalLeg` it never
 * waits for an answer, since the leg rings alongside the race's other legs and the race decides who
 * wins or hangs it up. Route fallthrough and `ip`-host failover (§9.4) still apply: an attempt that
 * fails before alerting is replaced by the next one, and the race sees one leg throughout, ringing
 * on whichever attempt's channel is current.
 */
import { isE164 } from '@zamfono/shared';

import { logFailure, logUnlessGone } from '../ari/failures.js';
import { userById } from '../internal/snapshot.js';
import type { AttemptFailure } from '../routing/trunk.js';
import type { Call } from './call.js';
import {
  placeAttempt,
  PLACEMENT_FAILED,
  type Attempt
} from './externalAttempt.js';
import {
  nextCandidate,
  nextRoute,
  openCursor,
  routeWays,
  trunkWay,
  type Candidate,
  type RouteCursor
} from './externalLegRoutes.js';
import type { ForwardLeg } from './forwardContext.js';
import type { Pipeline } from './pipeline.js';

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

/** A leg's route cursor (`externalLegRoutes.ts`) and the race that holds it. */
export type ExternalLeg = RouteCursor & { owner: ExternalLegOwner };

/** How a failed attempt of a leg its race still rings goes on: `failure` for the route
 * fallthrough to judge, `cause` the Q.850 cause its channel ended with. */
type AttemptFailed = (failure: AttemptFailure, cause: number | null) => void;

/** What a race leg dials: `number` as `asUser`'s call through the matching routes, or, with
 * `trunkId`, a SIP target's user part over that trunk alone (§9.4 "SIP targets"). */
type ExternalLegTarget = {
  number: string;
  asUser: string | null;
  trunkId?: string;
  forward?: ForwardLeg;
};

/** Whether an attempt was placed, and the channel holding the leg for the race now. */
type LegPlacement = { placed: boolean; holder: string | null };

/** As `channelId`'s INVITE is sent, it takes the leg over from `holder`, the channel that held it
 * so far (`null` for the first), unless the race hung the leg up or settled meanwhile. */
function takeOver(
  owner: ExternalLegOwner,
  channelId: string,
  holder: string | null
): boolean {
  if (holder !== null && !owner.ringing(holder)) {
    return false;
  }
  if (!owner.track(channelId)) {
    return false;
  }
  if (holder !== null) {
    owner.retire(holder);
  }
  return true;
}

/** The end of `attempt`, placed and rung: while its race still rings the leg it failed, and
 * `onFailed` hands the failure on (§9.4 "Route fallthrough"); any other channel had been hung up
 * by the race, or had answered. */
function followAttempt(
  leg: ExternalLeg,
  attempt: Attempt,
  onFailed: AttemptFailed
): void {
  attempt.ended
    .then(({ failure, cause }) => {
      if (!leg.owner.ringing(attempt.channelId)) {
        attempt.trace('hungUp');
        return;
      }
      attempt.trace(failure.kind === 'final' ? failure.code : failure.kind);
      onFailed(failure, cause);
    })
    .catch(logFailure(leg.pipeline.deps.logger, 'route fallthrough'));
}

/** Places `candidate`'s attempt, its channel tracked by the race from before its create, and
 * hands it the leg as it is dialled (`takeOver`). One placed after the race hung the leg up is
 * hung up at once; a failed one is traced, the leg still held by whichever channel holds it.
 * `failover` is how the attempt goes on should its channel fail later. */
async function placeLegAttempt(
  leg: ExternalLeg,
  candidate: Candidate,
  holder: string | null,
  failover: (channelId: string) => AttemptFailed
): Promise<LegPlacement> {
  const { pipeline, owner } = leg;
  // Set as the INVITE is sent, while the placement is still under way.
  const taken = { over: false };
  let channelId = '';
  const { attempt, trunkLeg } = await placeAttempt(
    leg,
    candidate,
    placed => {
      channelId = placed;
      owner.place(placed);
    },
    () => {
      taken.over = takeOver(owner, channelId, holder);
    }
  );
  const rang = taken.over;
  if (trunkLeg === undefined) {
    if (!rang) {
      owner.retire(channelId);
    }
    return { placed: false, holder: rang ? channelId : holder };
  }
  followAttempt(leg, attempt, failover(channelId));
  if (!rang) {
    owner.retire(channelId);
    pipeline.deps.ari.channels
      .hangup(channelId)
      .catch(logUnlessGone(pipeline.deps.logger, 'unrung attempt hangup'));
    return { placed: true, holder };
  }
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
    const placement = await placeLegAttempt(leg, candidate, holder, failover);
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
  if (!dialable) {
    call.log.event({ event: 'externalLegUnrouted', number: target.number });
    return;
  }
  const snapshot = await pipeline.deps.cache.get();
  const leg: ExternalLeg = {
    ...openCursor(
      {
        pipeline,
        trunkState,
        call,
        snapshot,
        number: target.number,
        callerUser: userById(snapshot, target.asUser),
        clirPerCall: null,
        forward: target.forward
      },
      target.trunkId === undefined
        ? routeWays(snapshot, target.number, target.asUser)
        : [trunkWay(snapshot, target.trunkId)]
    ),
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
