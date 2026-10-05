/**
 * The dial that waits for its outcome (§9.4 "Route fallthrough", "Hosts"): a route cursor's
 * attempts one at a time, each awaited, until one answers or the cursor has none left. Used by
 * `outboundExternal.ts`'s routes and `emergency.ts`'s trunks; the attempt itself is
 * `externalAttempt.ts`, the cursor `externalLegRoutes.ts`, the terminal outcomes `answer.ts` and
 * `conclude.ts`.
 */
import type { AriClient } from '../ari/client.js';
import { ignoreGone, logUnlessGone } from '../ari/failures.js';
import { shouldFallThrough, type AttemptFailure } from '../routing/trunk.js';
import { takeEarlyBridge, type Call, type Leg } from './call.js';
import { callRinging } from './callState.js';
import { placeAttempt, type Attempt } from './externalAttempt.js';
import {
  nextCandidate,
  nextRoute,
  type Candidate,
  type RouteCursor
} from './externalLegRoutes.js';
import type { Pipeline } from './pipeline.js';

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

/** Indicates progress to the caller and bridges them with `legId`, kept as the call's early
 * bridge once both are in it; a bridge left half-built is destroyed again. */
async function earlyBridge(
  ari: AriClient,
  call: Call,
  callerId: string,
  legId: string
): Promise<void> {
  await ari.channels.progress(callerId);
  const { id } = await ari.bridges.create({ type: 'mixing' });
  try {
    await ari.bridges.addChannel(id, callerId);
    await ari.bridges.addChannel(id, legId);
  } catch (error) {
    await ari.bridges.destroy(id).catch(ignoreGone);
    throw error;
  }
  call.earlyBridgeId = id;
}

/**
 * What the caller hears while `attempt` is out (§10.1 "Outbound"): ringing once the far end
 * alerts, and its early media once it answers 183, through an early bridge of the caller and the
 * leg that the answer keeps (`answer.ts`). A call whose answer joins another bridge (`*5`) only
 * rings; one without a caller channel hears nothing. Returns a read of the early bridge's setup,
 * awaited before the attempt's outcome is acted on.
 */
function followAlerts(
  pipeline: Pipeline,
  call: Call,
  attempt: Attempt
): () => Promise<void> {
  const callerId = call.callerChannelId;
  if (callerId === null) {
    return () => Promise.resolve();
  }
  const { ari, logger } = pipeline.deps;
  const rung = attempt.alerted
    .then(() => ari.channels.ring(callerId))
    .catch(ignoreGone);
  // Set as the 183 arrives, which is before the attempt's answer or end is acted on.
  let progressed = false;
  const bridged = attempt.progressed
    .then(async () => {
      progressed = true;
      await rung;
      if (call.joinBridgeId === undefined) {
        await earlyBridge(ari, call, callerId, attempt.channelId);
      }
    })
    .catch(logUnlessGone(logger, 'early bridge', { callId: call.id }));
  return () => (progressed ? bridged : Promise.resolve());
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
  const earlySetup = followAlerts(pipeline, call, attempt);
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
  await earlySetup();
  const tracked = call.legs.get(attempt.channelId);
  if (outcome.kind === 'answered') {
    if (tracked) {
      tracked.state = 'up';
    }
    return outcome;
  }
  const early = takeEarlyBridge(call);
  if (early !== null) {
    await pipeline.deps.ari.bridges.destroy(early).catch(
      logUnlessGone(pipeline.deps.logger, 'early bridge destroy', {
        callId: call.id
      })
    );
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
