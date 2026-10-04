/**
 * The dial that waits for its outcome (§9.4 "Route fallthrough", "Hosts"): a route cursor's
 * attempts one at a time, each awaited, until one answers or the cursor has none left. Used by
 * `outboundExternal.ts`'s routes and `emergency.ts`'s trunks; the attempt itself is
 * `externalAttempt.ts`, the cursor `externalLegRoutes.ts`, the terminal outcomes `answer.ts` and
 * `conclude.ts`.
 */
import { shouldFallThrough, type AttemptFailure } from '../routing/trunk.js';
import type { Leg } from './call.js';
import { callRinging } from './callState.js';
import { placeAttempt } from './externalAttempt.js';
import {
  nextCandidate,
  nextRoute,
  type Candidate,
  type RouteCursor
} from './externalLegRoutes.js';

type AttemptOutcome =
  | { kind: 'answered'; channelId: string }
  | { kind: 'failure'; failure: AttemptFailure };

/** A waiting dial's result: an answered leg, a final (non-fallthrough) failure, or the cursor
 * exhausted. */
export type DialResult =
  | { kind: 'answered'; channelId: string }
  | { kind: 'final'; failure: AttemptFailure }
  | { kind: 'exhausted'; lastFailureKind: AttemptFailure['kind'] | null };

const CALLER_GONE: AttemptFailure = { kind: 'callerGone' };

/** A waiting dial's result as its trace lines name it. */
export function dialCause(result: DialResult): string | null {
  if (result.kind === 'answered') {
    return 'answered';
  }
  return result.kind === 'final' ? result.failure.kind : result.lastFailureKind;
}

/** One INVITE to `candidate`: placed and tracked as a `trunk` leg of the call, its outcome awaited
 * (§9.4). A caller who hung up ended the leg (`legsEnded.ts`, `legOriginate.ts`): its end is no
 * failure of the far end's. */
async function attemptOnce(
  cursor: RouteCursor,
  candidate: Candidate
): Promise<AttemptOutcome> {
  const { pipeline, call } = cursor;
  let leg: Leg | undefined;
  const { attempt, trunkLeg } = await placeAttempt(
    cursor,
    candidate,
    channelId => {
      leg = {
        channelId,
        kind: 'trunk',
        userId: null,
        state: 'placing',
        endCause: null,
        trunkId: candidate.trunk.id
      };
      call.legs.set(channelId, leg);
    },
    () => {
      if (leg) {
        leg.state = 'ringing';
      }
    }
  );
  if (trunkLeg === undefined) {
    call.legs.delete(attempt.channelId);
    const { failure } = await attempt.ended;
    return {
      kind: 'failure',
      failure: call.callerEnded === true ? CALLER_GONE : failure
    };
  }
  // The live view (§10.6) shows the call ringing its external target from the first INVITE on.
  callRinging(pipeline.deps, call);
  const outcome = await Promise.race([
    attempt.answered.then((): AttemptOutcome => ({
      kind: 'answered',
      channelId: attempt.channelId
    })),
    attempt.ended.then(({ failure }): AttemptOutcome => ({
      kind: 'failure',
      failure: call.callerEnded === true ? CALLER_GONE : failure
    }))
  ]);
  const tracked = call.legs.get(attempt.channelId);
  if (outcome.kind === 'answered') {
    if (tracked) {
      tracked.state = 'up';
    }
    return outcome;
  }
  attempt.trace(
    outcome.failure.kind === 'final'
      ? outcome.failure.code
      : outcome.failure.kind
  );
  if (tracked) {
    tracked.state = 'ended';
  }
  return outcome;
}

/** Dials `cursor`'s attempts in turn (§9.4 "Route fallthrough", "Hosts") until one answers, a
 * failure does not fall through, or none is left; none once the caller has hung up. */
export async function dialRoutes(cursor: RouteCursor): Promise<DialResult> {
  let failure: AttemptFailure | null = null;
  let candidate = nextRoute(cursor);
  while (candidate !== null) {
    if (cursor.call.callerEnded === true) {
      return { kind: 'final', failure: CALLER_GONE };
    }
    // eslint-disable-next-line no-await-in-loop -- attempts are dialled one at a time, in fallthrough order, by design
    const outcome = await attemptOnce(cursor, candidate);
    if (outcome.kind === 'answered') {
      return outcome;
    }
    ({ failure } = outcome);
    candidate = nextCandidate(cursor, failure);
  }
  if (failure !== null && !shouldFallThrough(failure)) {
    return { kind: 'final', failure };
  }
  return { kind: 'exhausted', lastFailureKind: cursor.lastFailureKind };
}
