/**
 * One attempt of an external leg (`externalLeg.ts`) while its channel lives: the listener that
 * notes the far end alerting, answering or ending, the 8-second no-response budget (§9.4 "Route
 * fallthrough"), the attempt's trace line, and the trunk's channel count (§9.4 "Channels"). The
 * attempt's own channel ending is handled here alone, whichever race holds the leg: a leg the
 * race still rings fails over to its next attempt or ends (`onFailed`), any other channel had
 * been hung up by the race or had answered.
 */
import { logFailure, logUnlessGone } from '../ari/failures.js';
import type { AriEvent, Channel } from '../ari/types.js';
import {
  ATTEMPT_NO_RESPONSE_MS,
  type AttemptFailure
} from '../routing/trunk.js';
import type { ExternalLeg } from './externalLeg.js';
import type { Candidate } from './externalLegRoutes.js';
import { alertsOn, provisionalArrived, type TrunkLeg } from './provisional.js';
import { endedSipStatus } from './trunkDial.js';

/** How a failed attempt of a leg its race still rings goes on: `failure` for the route
 * fallthrough to judge, `cause` the Q.850 cause its channel ended with. */
export type AttemptFailed = (
  failure: AttemptFailure,
  cause: number | null
) => void;

/** One attempt's channel; `dialled` once its INVITE is sent, before which its events are its
 * placement's (`legOriginate.ts`), `alerted` once the far end sent 180/183 or answered, `closed`
 * once its channel is gone. */
export type Attempt = {
  leg: ExternalLeg;
  candidate: Candidate;
  channelId: string;
  dialled: boolean;
  alerted: boolean;
  noResponse: boolean;
  logged: boolean;
  closed: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  onEvent: ((event: AriEvent) => void) | null;
  onFailed: AttemptFailed;
};

/** The attempt's one routing-trace line, naming route, trunk and cause (§9.4 "Route fallthrough"). */
function logAttempt(attempt: Attempt, cause: string | number): void {
  if (attempt.logged) {
    return;
  }
  attempt.logged = true;
  attempt.leg.call.log.event({
    event: 'attempt',
    routeId: attempt.candidate.route?.id ?? null,
    trunkId: attempt.candidate.trunk.id,
    endpoint: attempt.candidate.endpoint,
    cause
  });
}

/** Stops watching the attempt and counts its channel off the trunk (§9.4 "Channels"). */
function closeAttempt(attempt: Attempt): void {
  attempt.closed = true;
  if (attempt.timer !== null) {
    clearTimeout(attempt.timer);
  }
  if (attempt.onEvent !== null) {
    attempt.leg.pipeline.deps.ari.off('event', attempt.onEvent);
  }
  attempt.leg.trunkState.noteAttemptEnded(attempt.channelId);
}

/** Ends the 8-second no-response budget: a provisional response arrived (§9.4 "Route fallthrough"). */
function stopBudget(attempt: Attempt): void {
  if (attempt.timer !== null) {
    clearTimeout(attempt.timer);
    attempt.timer = null;
  }
}

/**
 * The attempt's channel ended: while its race still rings the leg, the attempt failed, and how
 * (§9.4 "Route fallthrough": no response within the budget, else the final status and whether it
 * had alerted) is handed on; any other channel had been hung up by the race, or had answered.
 */
function attemptEnded(attempt: Attempt, destroyed: AriEvent): void {
  if (!attempt.leg.owner.ringing(attempt.channelId)) {
    logAttempt(attempt, 'hungUp');
    closeAttempt(attempt);
    return;
  }
  const failure: AttemptFailure = attempt.noResponse
    ? { kind: 'noResponse' }
    : {
        kind: 'final',
        code: endedSipStatus(destroyed),
        alerted: attempt.alerted
      };
  logAttempt(attempt, failure.kind === 'final' ? failure.code : failure.kind);
  closeAttempt(attempt);
  attempt.onFailed(
    failure,
    typeof destroyed.cause === 'number' ? destroyed.cause : null
  );
}

function onAttemptEvent(attempt: Attempt, event: AriEvent): void {
  if (!attempt.dialled) {
    return;
  }
  if (alertsOn(event, attempt.channelId)) {
    // The no-response budget covers only the interval before the first provisional response.
    attempt.alerted = true;
    stopBudget(attempt);
    return;
  }
  const channel = event.channel as Channel | undefined;
  if (channel?.id !== attempt.channelId) {
    return;
  }
  if (event.type === 'ChannelStateChange' && channel.state === 'Up') {
    attempt.alerted = true;
    stopBudget(attempt);
    logAttempt(attempt, 'answered');
    return;
  }
  if (event.type === 'ChannelDestroyed') {
    attemptEnded(attempt, event);
  }
}

/** Watches the attempt's channel `channelId` from before its create: its outcome listener, which
 * acts once `dialled` is set; `onFailed` once it fails while its race still rings the leg. */
export function watchAttempt(
  leg: ExternalLeg,
  candidate: Candidate,
  channelId: string,
  onFailed: AttemptFailed
): Attempt {
  const attempt: Attempt = {
    leg,
    candidate,
    channelId,
    dialled: false,
    alerted: false,
    noResponse: false,
    logged: false,
    closed: false,
    timer: null,
    onEvent: null,
    onFailed
  };
  attempt.onEvent = event => {
    onAttemptEvent(attempt, event);
  };
  leg.pipeline.deps.ari.on('event', attempt.onEvent);
  return attempt;
}

/** Stops watching an attempt that could not be placed; its placement counts it off the trunk. */
export function unwatchAttempt(attempt: Attempt): void {
  if (attempt.onEvent !== null) {
    attempt.leg.pipeline.deps.ari.off('event', attempt.onEvent);
  }
}

/** Starts the placed attempt's 8-second no-response budget (§9.4 "Route fallthrough"), unless the
 * far end alerted, or the channel ended, while it was being placed. */
export function startBudget(attempt: Attempt, trunkLeg: TrunkLeg): void {
  if (attempt.alerted || attempt.closed) {
    return;
  }
  const { ari } = attempt.leg.pipeline.deps;
  attempt.timer = setTimeout(() => {
    attempt.timer = null;
    // A `100 Trying` ends the budget too, though no event says so; only its absence hangs up. An
    // answer landing while the read is under way ends it as well: the answered leg is the race's.
    provisionalArrived(ari, trunkLeg)
      .then(arrived => {
        if (!arrived && !attempt.alerted && !attempt.closed) {
          attempt.noResponse = true;
          ari.channels
            .hangup(attempt.channelId)
            .catch(
              logUnlessGone(
                attempt.leg.pipeline.deps.logger,
                'no-response hangup'
              )
            );
        }
      })
      .catch(
        logFailure(
          attempt.leg.pipeline.deps.logger,
          'provisional response read'
        )
      );
  }, ATTEMPT_NO_RESPONSE_MS);
  attempt.timer.unref();
}
