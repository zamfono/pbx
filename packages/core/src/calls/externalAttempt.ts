/**
 * One outbound attempt while its channel lives (§9.4 "Route fallthrough", "Channels"), for both
 * the dial that waits for its outcome (`dialAttempt.ts`) and a ring race's external leg
 * (`externalLeg.ts`): the placement of its INVITE, the watch that notes the far end alerting,
 * answering or ending, the 8-second no-response budget, the attempt's one trace line, and the
 * trunk's channel count, which the attempt's end counts off again.
 */
import { newId } from '@zamfono/shared';

import { isEvent } from '../ari/events.js';
import { logFailure, logUnlessGone } from '../ari/failures.js';
import {
  ATTEMPT_NO_RESPONSE_MS,
  type AttemptFailure
} from '../routing/trunk.js';
import { SIP_SERVER_ERROR } from '../sipCodes.js';
import { waitForEvent, type EventWait } from './ariWaits.js';
import type { Candidate, RouteCursor } from './externalLegRoutes.js';
import { alertsOn, provisionalArrived, type TrunkLeg } from './provisional.js';
import { endedSipStatus, originateTrunkLeg } from './trunkDial.js';

// An attempt Asterisk would not place (its create or dial refused, `legOriginate.ts`) fails as a
// 500 before alerting would: the next host, then the next route, is tried (§9.4 "Route fallthrough").
export const PLACEMENT_FAILED: AttemptFailure = {
  kind: 'final',
  code: SIP_SERVER_ERROR,
  alerted: false
};

/** How an attempt ended: `failure` for the route fallthrough to judge, `cause` the Q.850 cause its
 * channel ended with, `null` for one the core hung up itself or never placed. */
export type AttemptEnd = { failure: AttemptFailure; cause: number | null };

/** One attempt's channel, watched from before its create. */
export type Attempt = {
  channelId: string;
  /** Resolves once the far end answers. */
  answered: Promise<void>;
  /** Resolves once the attempt is over: its channel ended, the budget ran out, or it was never
   * placed. Its channel is counted off the trunk then (§9.4 "Channels"). */
  ended: Promise<AttemptEnd>;
  /** Writes the attempt's one trace line, naming route, trunk, caller ID and `cause`; later calls
   * do nothing. */
  trace: (cause: string | number) => void;
};

/** A placed attempt and its originated channel, or `trunkLeg` `undefined` for one that was not
 * placed (traced, and over). */
export type Placement = { attempt: Attempt; trunkLeg: TrunkLeg | undefined };

/** The attempt's one trace line, naming route, trunk, caller ID and cause (§9.4 "Route
 * fallthrough"): the first call writes it, later ones do nothing. */
function attemptTracer(
  call: RouteCursor['call'],
  candidate: Candidate
): (cause: string | number) => void {
  let logged = false;
  return cause => {
    if (logged) {
      return;
    }
    logged = true;
    call.log.event({
      event: 'attempt',
      routeId: candidate.route?.id ?? null,
      trunkId: candidate.trunk.id,
      endpoint: candidate.endpoint,
      // The caller ID the INVITE presented: the number as formatted for the trunk, the format and
      // header(s) the trunk takes it in, and whether it was withheld (§9.4 "Caller ID", CLIR).
      callerId: {
        number: candidate.identity.number,
        format: candidate.trunk.callerIdFormat,
        header: candidate.trunk.callerIdHeader,
        withheld: candidate.identity.withhold
      },
      cause
    });
  };
}

/** Arms the attempt's 8-second no-response budget (§9.4 "Route fallthrough") on `wait`: once it
 * runs out with no provisional response, the attempt ends with `noResponse` and its channel is
 * hung up. */
function armBudget(
  pipeline: RouteCursor['pipeline'],
  wait: EventWait<AttemptEnd>,
  channelId: string,
  trunkLeg: TrunkLeg,
  alerted: () => boolean
): void {
  const { ari, logger } = pipeline.deps;
  wait.arm(ATTEMPT_NO_RESPONSE_MS, () => {
    // A `100 Trying` ends the budget as any provisional response does, though no event says so;
    // only its absence ends the attempt. An answer landing while the read is under way keeps it.
    provisionalArrived(ari, trunkLeg)
      .then(arrived => {
        if (arrived || alerted()) {
          return;
        }
        wait.settle({ failure: { kind: 'noResponse' }, cause: null });
        ari.channels
          .hangup(channelId)
          .catch(logUnlessGone(logger, 'no-response hangup'));
      })
      .catch(logFailure(logger, 'provisional response read'));
  });
}

/**
 * Watches `channelId` until it ends (§9.4 "Route fallthrough"). Its events count only once
 * `dialled()` says its INVITE is sent: before that they are its placement's (`legOriginate.ts`).
 * `start` begins the no-response budget once the channel is placed; a far end that alerts or
 * answers first never starts it.
 */
function watchAttempt(
  cursor: RouteCursor,
  candidate: Candidate,
  channelId: string
): Attempt & {
  dialled: () => void;
  start: (trunkLeg: TrunkLeg) => void;
  abandon: () => void;
} {
  const { pipeline, trunkState, call } = cursor;
  const { ari } = pipeline.deps;
  let dialled = false;
  let alerted = false;
  const answered = Promise.withResolvers<undefined>();
  const trace = attemptTracer(call, candidate);
  const wait = waitForEvent<AttemptEnd>(ari, (event, waiting) => {
    if (!dialled) {
      return;
    }
    if (alertsOn(event, channelId)) {
      // The no-response budget covers only the interval before the first provisional response.
      alerted = true;
      waiting.disarm();
      return;
    }
    const channel = event.channel;
    if (channel?.id !== channelId) {
      return;
    }
    if (event.type === 'ChannelStateChange' && channel.state === 'Up') {
      alerted = true;
      waiting.disarm();
      trace('answered');
      answered.resolve(undefined);
      return;
    }
    if (isEvent(event, 'ChannelDestroyed')) {
      waiting.settle({
        failure: { kind: 'final', code: endedSipStatus(event), alerted },
        cause: event.cause
      });
    }
  });
  const ended = wait.promise.then(end => {
    trunkState.noteAttemptEnded(channelId);
    return end;
  });
  return {
    channelId,
    answered: answered.promise,
    ended,
    trace,
    dialled: () => {
      dialled = true;
    },
    start: trunkLeg => {
      if (!alerted) {
        armBudget(pipeline, wait, channelId, trunkLeg, () => alerted);
      }
    },
    abandon: () => {
      wait.settle({ failure: PLACEMENT_FAILED, cause: null });
    }
  };
}

/**
 * Places `candidate`'s attempt over `cursor`'s trunk leg context on a fresh channel, watched from
 * before its create, so a far end answering or refusing at once is never missed. `track` runs with
 * the channel's id before the create, `dialling` as its INVITE is sent (`legOriginate.ts`); a
 * placed attempt's budget starts here. One that could not be placed is traced and over.
 */
export async function placeAttempt(
  cursor: RouteCursor,
  candidate: Candidate,
  track: (channelId: string) => void,
  dialling: () => void
): Promise<Placement> {
  const { pipeline, call, trunkState, number, forward } = cursor;
  const { trunk, identity, endpoint } = candidate;
  const channelId = newId();
  track(channelId);
  const attempt = watchAttempt(cursor, candidate, channelId);
  const trunkLeg = await originateTrunkLeg(
    { pipeline, call, trunkState, trunk, number, identity, forward },
    endpoint,
    channelId,
    () => {
      attempt.dialled();
      dialling();
    }
  ).catch(
    logFailure(pipeline.deps.logger, 'trunk attempt placement', {
      callId: call.id,
      trunkId: trunk.id
    })
  );
  if (trunkLeg === undefined) {
    attempt.abandon();
    attempt.trace('placementFailed');
    return { attempt, trunkLeg: undefined };
  }
  attempt.start(trunkLeg);
  return { attempt, trunkLeg };
}
