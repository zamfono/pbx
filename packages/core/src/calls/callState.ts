/**
 * The live view of a call: `StateStore.calls`, which `GET /internal/state` serves (§3.1), and the
 * `call.state` events `/events` subscribers and webhooks receive (§10.6). Both track the same
 * three moments, so both are written here and cannot drift apart. Whose call it is changes in
 * between, as legs start and stop ringing: the live view reads its users from the `Call` each time
 * it is served, and `callPartiesChanged` tells the users the call starts or stops being theirs.
 */
import type { LiveCall } from '@zamfono/shared';

import type { EventBus, StateStore } from '../internal/server.js';
import type { Call } from './call.js';
import { presentCallerUserId } from './callLookup.js';

/** The two collaborators the live view needs, so `CdrWriter` can publish the end as well. */
export type CallStateDeps = { state: StateStore; bus: EventBus };

/** The users each call's last `call.state` event reached, so the ones it no longer reaches get
 * their `ended`. */
const notified = new WeakMap<Call, ReadonlySet<string>>();

/**
 * Every user whose call this is to see (§10.3 "Live calls", §10.6 "own calls"): the caller, the
 * callee, the answerer, the user whose channel holds the caller's place after an attended
 * transfer, and every user with a leg ringing or up right now, of the call's own legs or of the
 * ring-group batch ringing it. A user whose own leg ended, another member having answered or
 * their ring having stopped, is not one, as in the history.
 */
function participants(call: Call): string[] {
  const ids = new Set<string>();
  for (const id of [
    call.callerUserId,
    presentCallerUserId(call),
    call.calleeUserId,
    call.answeredByUserId
  ]) {
    if (id !== null) {
      ids.add(id);
    }
  }
  for (const leg of [
    ...call.legs.values(),
    ...(call.batchLegs?.values() ?? [])
  ]) {
    if (leg.userId !== null && leg.state !== 'ended') {
      ids.add(leg.userId);
    }
  }
  return [...ids];
}

/** The users who may end or transfer the call (§10.3 "Live calls"): the caller while their own
 * channel is in it, and every user with a leg up in it, whose channel `transfers.ts`'s
 * transferrer then is. A caller who parked the other party, or whose place an attended transfer
 * handed over, is no longer one; the user whose channel took that place is. */
function connected(call: Call): string[] {
  const ids = new Set<string>();
  const caller = presentCallerUserId(call);
  if (caller !== null) {
    ids.add(caller);
  }
  for (const leg of call.legs.values()) {
    if (leg.userId !== null && leg.state === 'up') {
      ids.add(leg.userId);
    }
  }
  return [...ids];
}

/**
 * §10.6's `peer`: the other end as the subscriber sees it. An inbound call's peer is the caller,
 * an outbound one's the number dialled.
 */
function peerOf(call: Call): string {
  return call.direction === 'inbound' ? call.from : call.to;
}

function liveCall(call: Call, state: LiveCall['state']): LiveCall {
  return {
    callId: call.id,
    direction: call.direction,
    from: call.from,
    to: call.to,
    state,
    startedAt: call.startedAt,
    ringGroupId: call.ringGroupId,
    // Read when served, so a leg that starts or stops ringing counts from that moment.
    get userIds() {
      return participants(call);
    },
    get connectedUserIds() {
      return connected(call);
    }
  };
}

function emit(
  deps: CallStateDeps,
  call: Call,
  state: 'ringing' | 'up' | 'ended',
  userIds: string[],
  usersOnly: boolean
): void {
  deps.bus.emit({
    type: 'call.state',
    callId: call.id,
    state,
    peer: peerOf(call),
    ringGroupId: call.ringGroupId,
    userId: call.answeredByUserId ?? call.calleeUserId,
    // §10.6 "a user receives events about ... own calls": every participant, the caller too, whom
    // `userId` (the answerer, else the callee) leaves out.
    userIds,
    ...(usersOnly ? { usersOnly: true as const } : {})
  });
}

/** The users `call`'s last event reached that are not among `current`. */
function leftSince(call: Call, current: string[]): string[] {
  return [...(notified.get(call) ?? [])].filter(id => !current.includes(id));
}

function publish(
  deps: CallStateDeps,
  call: Call,
  state: 'ringing' | 'up' | 'ended'
): void {
  const current = participants(call);
  const left = leftSince(call, current);
  if (state === 'ended') {
    notified.delete(call);
    emit(deps, call, state, [...current, ...left], false);
    return;
  }
  if (left.length > 0) {
    emit(deps, call, 'ended', left, true);
  }
  notified.set(call, new Set(current));
  emit(deps, call, state, current, false);
}

/**
 * The call's users changed while its state did not: a leg started or stopped ringing, or left.
 * A user it is no longer the call of receives `ended`, one it now is the call of its state, each
 * as a `usersOnly` event; nothing for a call not in the live view.
 */
export function callPartiesChanged(deps: CallStateDeps, call: Call): void {
  const live = deps.state.calls.get(call.id);
  if (live === undefined) {
    return;
  }
  const before = notified.get(call) ?? new Set<string>();
  const current = participants(call);
  const left = leftSince(call, current);
  const joined = current.filter(id => !before.has(id));
  notified.set(call, new Set(current));
  if (left.length > 0) {
    emit(deps, call, 'ended', left, true);
  }
  if (joined.length > 0) {
    emit(deps, call, live.state, joined, true);
  }
}

/** The call has started ringing a target; repeated as the target changes down a forward chain. */
export function callRinging(deps: CallStateDeps, call: Call): void {
  deps.state.calls.set(call.id, liveCall(call, 'ringing'));
  publish(deps, call, 'ringing');
}

/** The call is answered and bridged. */
export function callUp(deps: CallStateDeps, call: Call): void {
  deps.state.calls.set(call.id, liveCall(call, 'up'));
  publish(deps, call, 'up');
}

/** The call is over, however it ended; the live view drops it. */
export function callEnded(deps: CallStateDeps, call: Call): void {
  deps.state.calls.delete(call.id);
  publish(deps, call, 'ended');
}
