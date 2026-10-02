/**
 * Routing pipeline step 4, "Target user" (§10.1): the Entry-time decision for a user target —
 * ring, forward, mailbox or release — and, once `ringUser`'s race ends without an answer, the
 * busy or noAnswer outcome. A forward is the user's own rule, so an external target is dialled as
 * their call (§10.1 step 7).
 */
import type { Snapshot } from '../internal/snapshot.js';
import {
  userEntryCondition,
  userEntryDecision,
  userOutcomeDecision
} from '../routing/user.js';
import { buildUserRules, raiseLogLevel, release, type Call } from './call.js';
import { CONDITION_REASONS, diversionFor } from './forwardContext.js';
import type { Pipeline } from './pipeline.js';
import { ringUser } from './ringUser.js';
import { runTarget } from './runTarget.js';
import { registeredDevices } from './userDevices.js';
import { deposit } from './voicemail.js';

const RELEASE_CODE_UNAVAILABLE = 480;
/** After `ringUser`'s race concludes without an answer: forward, mailbox, or release (§10.1 step 4). */
export async function applyRingOutcome(
  pipeline: Pipeline,
  call: Call,
  snapshot: Snapshot,
  user: { id: string; mailboxEnabled: number },
  outcome: 'busy' | 'noAnswer'
): Promise<void> {
  const decision = userOutcomeDecision(
    { id: user.id, mailboxEnabled: user.mailboxEnabled === 1 },
    buildUserRules(snapshot, user.id),
    outcome
  );
  call.log.event({ event: 'ringOutcome', outcome, decision: decision.kind });
  // A call with no caller channel only rings: its forward, mailbox or release has nobody to act on.
  if (call.callerChannelId === null) {
    return;
  }
  if (decision.kind === 'forward') {
    // §10.1 step 7: the user's own busy or noAnswer rule, so an external target is dialled as
    // their call, and a hop of theirs.
    const diversion = diversionFor(
      snapshot,
      call,
      { userId: user.id },
      CONDITION_REASONS[outcome]
    );
    await runTarget(pipeline, call, decision.target, user.id, diversion);
    return;
  }
  if (decision.kind === 'mailbox') {
    await deposit(pipeline, call, { userId: decision.userId }, outcome);
    return;
  }
  if (decision.kind === 'release') {
    const status =
      decision.code === RELEASE_CODE_UNAVAILABLE ? 'missed' : 'busy';
    await release(pipeline, call, decision.code, status);
  }
}
const RELEASE_CODE_BUSY = 486;
/** Step 4 "Target user": the Entry-time decision, then its outcome (ring/forward/mailbox/release). */
export async function runUserStep(
  pipeline: Pipeline,
  call: Call,
  snapshot: Snapshot,
  userId: string
): Promise<void> {
  const user = snapshot.users.find(row => row.id === userId);
  if (user === undefined) {
    await release(pipeline, call, RELEASE_CODE_UNAVAILABLE, 'failed');
    return;
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
    await ringUser(pipeline, call, userId);
    return;
  }
  if (call.callerChannelId === null) {
    return;
  }
  if (decision.kind === 'forward') {
    // §10.1 step 7: the user's own unconditional, dnd or offline rule, so an external target is
    // dialled as their call, and a hop of theirs.
    const diversion =
      reason === null
        ? null
        : diversionFor(snapshot, call, { userId }, CONDITION_REASONS[reason]);
    await runTarget(pipeline, call, decision.target, userId, diversion);
    return;
  }
  if (decision.kind === 'mailbox') {
    // A mailbox at Entry is DND's or `offline`'s implicit default (§10.1 step 4).
    await deposit(
      pipeline,
      call,
      { userId: decision.userId },
      reason === 'dnd' ? 'dnd' : 'offline'
    );
    return;
  }
  const status = decision.code === RELEASE_CODE_BUSY ? 'busy' : 'missed';
  await release(pipeline, call, decision.code, status);
}
