/**
 * Routing pipeline step 4, "Target user" (§10.1): the Entry-time decision for a user target —
 * ring, forward, mailbox or release — and, once `ringUser`'s race ends without an answer, the
 * busy or noAnswer outcome. A forward is the user's own rule, so an external target is dialled as
 * their call (§10.1 step 7).
 */
import type { Snapshot } from '../internal/snapshot.js';
import type { ForwardTarget } from '../routing/targets.js';
import {
  userEntryCondition,
  userEntryDecision,
  userOutcomeDecision
} from '../routing/user.js';
import { SIP_BUSY_HERE, SIP_TEMPORARILY_UNAVAILABLE } from '../sipCodes.js';
import { buildUserRules, raiseLogLevel, release, type Call } from './call.js';
import { CONDITION_REASONS, diversionFor } from './forwardContext.js';
import type { Pipeline } from './pipeline.js';
import { ringUser } from './ringUser.js';
import { runTarget } from './runTarget.js';
import { registeredDevices } from './userDevices.js';
import { deposit, type DepositReason } from './voicemail.js';

/**
 * A user's forward or mailbox decision, with the condition that made it. A call with no caller
 * channel only rings, so it has nobody to apply one to: `runUserStep` hands it back to whoever
 * holds the party it is for (the parking ring-back, §10.2 "Call parking").
 */
export type UnappliedDecision =
  | {
      kind: 'forward';
      userId: string;
      target: ForwardTarget;
      condition: keyof typeof CONDITION_REASONS | null;
    }
  | { kind: 'mailbox'; userId: string; reason: DepositReason };

/** Applies `decision` to `call`'s caller: the forward is the user's own rule, so an external target
 * is dialled as their call, and a hop of theirs (§10.1 step 7); the mailbox takes a message. */
export async function applyUserDecision(
  pipeline: Pipeline,
  call: Call,
  snapshot: Snapshot,
  decision: UnappliedDecision
): Promise<void> {
  const { userId } = decision;
  if (decision.kind === 'mailbox') {
    await deposit(pipeline, call, { userId }, decision.reason);
    return;
  }
  const diversion =
    decision.condition === null
      ? null
      : diversionFor(
          snapshot,
          call,
          { userId },
          CONDITION_REASONS[decision.condition]
        );
  await runTarget(pipeline, call, decision.target, userId, diversion);
}

/** Applies `decision`, or hands it back for a call with no caller channel. */
async function applyOrHandBack(
  pipeline: Pipeline,
  call: Call,
  snapshot: Snapshot,
  decision: UnappliedDecision
): Promise<UnappliedDecision | null> {
  if (call.callerChannelId === null) {
    return decision;
  }
  await applyUserDecision(pipeline, call, snapshot, decision);
  return null;
}

/** After `ringUser`'s race concludes without an answer: forward, mailbox, or release (§10.1 step
 * 4). A forward or mailbox of a call with no caller channel is handed back (`UnappliedDecision`). */
export async function applyRingOutcome(
  pipeline: Pipeline,
  call: Call,
  snapshot: Snapshot,
  user: { id: string; mailboxEnabled: number },
  outcome: 'busy' | 'noAnswer'
): Promise<UnappliedDecision | null> {
  const decision = userOutcomeDecision(
    { id: user.id, mailboxEnabled: user.mailboxEnabled === 1 },
    buildUserRules(snapshot, user.id),
    outcome
  );
  call.log.event({ event: 'ringOutcome', outcome, decision: decision.kind });
  if (decision.kind === 'forward') {
    return applyOrHandBack(pipeline, call, snapshot, {
      kind: 'forward',
      userId: user.id,
      target: decision.target,
      condition: outcome
    });
  }
  if (decision.kind === 'mailbox') {
    return applyOrHandBack(pipeline, call, snapshot, {
      kind: 'mailbox',
      userId: decision.userId,
      reason: outcome
    });
  }
  // A call with no caller channel has nobody to release.
  if (decision.kind === 'release' && call.callerChannelId !== null) {
    const status =
      decision.code === SIP_TEMPORARILY_UNAVAILABLE ? 'missed' : 'busy';
    await release(pipeline, call, decision.code, status);
  }
  return null;
}
/** Step 4 "Target user": the Entry-time decision, then its outcome (ring/forward/mailbox/release).
 * A forward or mailbox of a call with no caller channel, at Entry or after its ring, is handed
 * back (`UnappliedDecision`). */
export async function runUserStep(
  pipeline: Pipeline,
  call: Call,
  snapshot: Snapshot,
  userId: string
): Promise<UnappliedDecision | null> {
  const user = snapshot.users.find(row => row.id === userId);
  if (user === undefined) {
    await release(pipeline, call, SIP_TEMPORARILY_UNAVAILABLE, 'failed');
    return null;
  }
  // §7: the target user's diagnostics override counts toward the call's level.
  raiseLogLevel(call.log, user, pipeline.deps.now());
  // §10.1 step 4 "no registered device": the devices `ringUser` would ring, not every configured
  // one, so a user whose phones are all off meets `offline` at once rather than `noAnswer` later.
  const entryUser = {
    id: user.id,
    dnd: user.dnd === 1,
    mailboxEnabled: user.mailboxEnabled === 1,
    findMe: user.findMe,
    registeredDevices: registeredDevices(pipeline, snapshot, userId).length
  };
  const rules = buildUserRules(snapshot, userId);
  const decision = userEntryDecision(entryUser, rules);
  const reason = userEntryCondition(entryUser, rules);
  // §7 "fallback taken": what the user step decided and why, with the device count `offline`
  // reads, so a call that never rang a phone says whether any was registered.
  call.log.event({
    event: 'user',
    userId,
    decision: decision.kind,
    ...(reason === null ? {} : { reason }),
    registeredDevices: entryUser.registeredDevices
  });
  if (decision.kind === 'ring') {
    return ringUser(pipeline, call, userId);
  }
  if (decision.kind === 'forward') {
    // The user's own unconditional, dnd or offline rule.
    return applyOrHandBack(pipeline, call, snapshot, {
      kind: 'forward',
      userId,
      target: decision.target,
      condition: reason
    });
  }
  if (decision.kind === 'mailbox') {
    // A mailbox at Entry is DND's or `offline`'s implicit default (§10.1 step 4).
    return applyOrHandBack(pipeline, call, snapshot, {
      kind: 'mailbox',
      userId: decision.userId,
      reason: reason === 'dnd' ? 'dnd' : 'offline'
    });
  }
  if (call.callerChannelId !== null) {
    const status = decision.code === SIP_BUSY_HERE ? 'busy' : 'missed';
    await release(pipeline, call, decision.code, status);
  }
  return null;
}
