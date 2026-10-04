/** Emergency calls (§10.1 "Emergency calls"): the tenant's emergency trunks in priority order,
 * bypassing outbound routing entirely. */
import type { CallLogLevel } from '@zamfono/shared';

import { effectiveLevel } from '../callLog.js';
import { userById, type Snapshot } from '../internal/snapshot.js';
import { emergencyTrunks } from '../routing/trunk.js';
import { SIP_SERVICE_UNAVAILABLE } from '../sipCodes.js';
import { settleAnswered } from './answer.js';
import { type Call } from './call.js';
import { resolveAttemptIdentity, type UserRow } from './callerIdentity.js';
import { dialCause, dialRoutes, type DialResult } from './dialAttempt.js';
import { openCursor } from './externalLegRoutes.js';
import type { Pipeline } from './pipeline.js';
import { release } from './release.js';
import type { TrunkState } from './trunkState.js';

/** An emergency call's routing trace is kept at level `events` whatever the tenant default
 * (§10.1 "Emergency calls"). */
export function emergencyLogLevel(
  configured: CallLogLevel,
  nowIso: string
): CallLogLevel {
  return effectiveLevel(
    configured,
    [{ level: 'events', expiresAt: null }],
    nowIso
  );
}

/** One emergency trunk's dial (§10.1 "Emergency calls"): its hosts in turn with the emergency
 * caller identity and no pre-checks, traced at its end; `undefined` for a trunk that is gone or
 * cannot present the call. */
async function attemptEmergencyTrunk(params: {
  pipeline: Pipeline;
  trunkState: TrunkState;
  call: Call;
  trunkId: string;
  number: string;
  callerUser: UserRow | null;
  snapshot: Snapshot;
}): Promise<DialResult | undefined> {
  const { call, trunkId, callerUser, snapshot } = params;
  const trunk = snapshot.trunks.find(row => row.id === trunkId);
  if (!trunk) {
    return undefined;
  }
  const identity = resolveAttemptIdentity({
    route: null,
    trunk,
    callerUser,
    clirPerCall: null,
    emergency: true,
    snapshot
  });
  if (!identity.ok) {
    return undefined;
  }
  const result = await dialRoutes(
    openCursor({ ...params, clirPerCall: null, forward: undefined }, [
      { route: null, trunk, identity: identity.identity }
    ])
  );
  call.log.event({
    event: 'emergencyAttempt',
    trunkId,
    cause: dialCause(result)
  });
  return result;
}

/** Whether any of the tenant's emergency trunks is live, anything but `unreachable` (§9.4 "Trunk
 * order", "Emergency trunks"), the same view `emergencyTrunks` dials from. */
function anyLiveEmergencyTrunk(
  pipeline: Pipeline,
  snapshot: Snapshot
): boolean {
  return snapshot.trunks.some(
    row =>
      row.emergency === 1 &&
      pipeline.deps.state.trunks.get(row.id)?.status !== 'unreachable'
  );
}

/**
 * Emergency calls (§10.1 "Emergency calls"): the tenant's emergency trunks in priority order, no
 * route, caller list, CLIR or cap, failing over to the next live one on any non-answer and only
 * failing the call once none remains; a trunk without `trunks.emergency` is never tried, and none
 * once the caller has hung up. The answer joins `call.joinBridgeId`, if set — `*5`'s added leg
 * joining the running conversation (§10.2 "Three-way calls") — else a bridge of its own.
 */
export async function dialEmergency(
  pipeline: Pipeline,
  trunkState: TrunkState,
  call: Call,
  number: string,
  asUser: string | null
): Promise<void> {
  const snapshot = await pipeline.deps.cache.get();
  const callerUser = userById(snapshot, asUser);
  const trunkIds = emergencyTrunks(
    snapshot.trunks.map(row => ({
      id: row.id,
      priority: row.priority,
      emergency: row.emergency === 1,
      status: pipeline.deps.state.trunks.get(row.id)?.status ?? 'unknown'
    }))
  );
  for (const trunkId of trunkIds) {
    // eslint-disable-next-line no-await-in-loop -- trunks are tried one at a time, in priority order, until one succeeds
    const outcome = await attemptEmergencyTrunk({
      pipeline,
      trunkState,
      call,
      trunkId,
      number,
      callerUser,
      snapshot
    });
    if (outcome?.kind === 'answered') {
      // eslint-disable-next-line no-await-in-loop -- the loop returns right after, so this is the loop's last iteration
      await settleAnswered(pipeline, call, outcome.channelId);
      return;
    }
    // A caller who hung up is no failed emergency call: nothing more is dialled or released.
    if (outcome?.kind === 'final' && outcome.failure.kind === 'callerGone') {
      return;
    }
  }
  call.log.event({ event: 'emergencyFailed' });
  // §10.1 "Emergency calls": an ERROR log line "only while no live emergency trunk exists",
  // alongside the routing-trace line above; live emergency trunks that were tried and failed are
  // no such outage. Statuses are read at the failure, the moment the line reports on.
  if (!anyLiveEmergencyTrunk(pipeline, snapshot)) {
    pipeline.deps.logger.error(
      { callId: call.id, number },
      'emergency call failed: no live emergency trunk'
    );
  }
  await release(pipeline, call, SIP_SERVICE_UNAVAILABLE, 'failed');
}
