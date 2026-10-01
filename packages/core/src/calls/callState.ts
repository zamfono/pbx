/**
 * The live view of a call: `StateStore.calls`, which `GET /internal/state` serves (§3.1), and the
 * `call.state` events `/events` subscribers and webhooks receive (§10.6). Both track the same
 * three moments, so both are written here and cannot drift apart. Whose call it is changes in
 * between, as legs start and stop ringing: `liveView` reads its users from the `Call` each time
 * it is served, and `callPartiesChanged` tells the users the call starts or stops being theirs.
 */
import type { LiveCall } from '@zamfono/shared';

import type { EventBus } from '../internal/eventBus.js';
import type { StateStore } from '../internal/stateStore.js';
import type { Call } from './call.js';
import { presentCallerUserId } from './callLookup.js';

/** The two collaborators the live view needs, so `CdrWriter` can publish the end as well. */
export type CallStateDeps = { state: StateStore; bus: EventBus };

/** A call in the live view (`StateStore.calls`): the call itself, the state it is in, and the
 * users its last `call.state` event reached, so the ones it no longer reaches get their
 * `ended`. */
export type LiveEntry = {
  call: Call;
  state: 'ringing' | 'up';
  notified: ReadonlySet<string>;
};

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

/** What `GET /internal/state` serves of `entry` (§3.1), read from the call when served, so a leg
 * that starts or stops ringing counts from that moment. */
export function liveView(entry: LiveEntry): LiveCall {
  const { call } = entry;
  return {
    callId: call.id,
    direction: call.direction,
    from: call.from,
    to: call.to,
    state: entry.state,
    startedAt: call.startedAt,
    ringGroupId: call.ringGroupId,
    userIds: participants(call),
    connectedUserIds: connected(call)
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

/** The users `entry`'s last event reached that are not among `current`. */
function leftSince(
  entry: LiveEntry | undefined,
  current: readonly string[]
): string[] {
  return [...(entry?.notified ?? [])].filter(id => !current.includes(id));
}

/** `call` is in `state` now: a user it is no longer the call of receives `ended`, as a
 * `usersOnly` event, and every one it is the call of its state. */
function publish(
  deps: CallStateDeps,
  call: Call,
  state: 'ringing' | 'up'
): void {
  const current = participants(call);
  const left = leftSince(deps.state.calls.get(call.id), current);
  deps.state.calls.set(call.id, { call, state, notified: new Set(current) });
  if (left.length > 0) {
    emit(deps, call, 'ended', left, true);
  }
  emit(deps, call, state, current, false);
}

/**
 * The call's users changed while its state did not: a leg started or stopped ringing, or left.
 * A user it is no longer the call of receives `ended`, one it now is the call of its state, each
 * as a `usersOnly` event; nothing for a call not in the live view.
 */
export function callPartiesChanged(deps: CallStateDeps, call: Call): void {
  const entry = deps.state.calls.get(call.id);
  if (entry === undefined) {
    return;
  }
  const current = participants(call);
  const left = leftSince(entry, current);
  const joined = current.filter(id => !entry.notified.has(id));
  deps.state.calls.set(call.id, { ...entry, notified: new Set(current) });
  if (left.length > 0) {
    emit(deps, call, 'ended', left, true);
  }
  if (joined.length > 0) {
    emit(deps, call, entry.state, joined, true);
  }
}

/** The call has started ringing a target; repeated as the target changes down a forward chain. */
export function callRinging(deps: CallStateDeps, call: Call): void {
  publish(deps, call, 'ringing');
}

/** The call is answered and bridged. */
export function callUp(deps: CallStateDeps, call: Call): void {
  publish(deps, call, 'up');
}

/** The call is over, however it ended; the live view drops it, and every user its last event
 * reached receives `ended` with those it is the call of now. */
export function callEnded(deps: CallStateDeps, call: Call): void {
  const entry = deps.state.calls.get(call.id);
  deps.state.calls.delete(call.id);
  const current = participants(call);
  emit(deps, call, 'ended', [...current, ...leftSince(entry, current)], false);
}
