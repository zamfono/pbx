/** Emergency calls (§10.1 "Emergency calls"): the tenant's trunks in priority order, bypassing
 * outbound routing entirely. */
import { effectiveLevel, type LogLevel } from '../callLog.js';
import type { Snapshot } from '../internal/server.js';
import { emergencyTrunks } from '../routing/trunk.js';
import { settleAnswered } from './answer.js';
import { takeJoinBridge } from './bridgeJoin.js';
import { release, type Call } from './call.js';
import { resolveAttemptIdentity, type UserRow } from './callerIdentity.js';
import { SIP_SERVICE_UNAVAILABLE } from './conclude.js';
import { attemptRoute, type AttemptOutcome } from './dialAttempt.js';
import type { Pipeline } from './pipeline.js';
import type { TrunkState } from './trunkState.js';

/** An emergency call's routing trace is kept at level `events` whatever the tenant default
 * (§10.1 "Emergency calls"). */
export function emergencyLogLevel(
  configured: LogLevel,
  nowIso: string
): LogLevel {
  return effectiveLevel(
    configured,
    [{ level: 'events', expiresAt: null }],
    nowIso
  );
}

async function attemptEmergencyTrunk(params: {
  pipeline: Pipeline;
  trunkState: TrunkState;
  call: Call;
  trunkId: string;
  number: string;
  callerUser: UserRow | null;
  snapshot: Snapshot;
}): Promise<AttemptOutcome | undefined> {
  const { pipeline, trunkState, call, trunkId, number, callerUser, snapshot } =
    params;
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
  const outcome = await attemptRoute(
    {
      pipeline,
      call,
      trunkState,
      route: null,
      trunk,
      number,
      identity: identity.identity
    },
    snapshot
  );
  call.log.event({
    event: 'emergencyAttempt',
    trunkId,
    cause: outcome.kind === 'answered' ? 'answered' : outcome.failure.kind
  });
  return outcome;
}

/** Whether any of the tenant's trunks is live, anything but `unreachable` (§9.4 "Trunk order"), the
 * same view `emergencyTrunks` dials from. */
function anyLiveTrunk(pipeline: Pipeline, snapshot: Snapshot): boolean {
  return snapshot.trunks.some(
    row =>
      row.deletedAt === null &&
      pipeline.deps.state.trunks.get(row.id)?.status !== 'unreachable'
  );
}

/**
 * Emergency calls (§10.1 "Emergency calls"): the tenant's trunks in priority order, no route,
 * caller list, CLIR or cap, failing over to the next live trunk on any non-answer and only
 * failing the call once none remains. The answer joins the bridge `bridgeJoin.ts`'s registry
 * hands over for `call`, if any — `*5`'s added leg joining the running conversation (§10.2
 * "Three-way calls") — else a bridge of its own.
 */
export async function dialEmergency(
  pipeline: Pipeline,
  trunkState: TrunkState,
  call: Call,
  number: string,
  asUser: string | null
): Promise<void> {
  const snapshot = await pipeline.deps.cache.get();
  const callerUser =
    asUser === null
      ? null
      : (snapshot.users.find(row => row.id === asUser) ?? null);
  const trunkIds = emergencyTrunks(
    snapshot.trunks
      .filter(row => row.deletedAt === null)
      .map(row => ({
        id: row.id,
        priority: row.priority,
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
      await settleAnswered(
        pipeline,
        call,
        outcome.channelId,
        takeJoinBridge(pipeline, call.id)
      );
      return;
    }
  }
  call.log.event({ event: 'emergencyFailed' });
  // §10.1 "Emergency calls": an ERROR log line "only while no live trunk exists", alongside the
  // routing-trace line above; live trunks that were tried and failed are no such outage.
  // Statuses are read at the failure, the moment the line reports on.
  if (!anyLiveTrunk(pipeline, snapshot)) {
    pipeline.deps.logger?.error(
      { callId: call.id, number },
      'emergency call failed: no live trunk'
    );
  }
  await release(pipeline, call, SIP_SERVICE_UNAVAILABLE, 'failed');
}
