/**
 * The live view of a call: `StateStore.calls`, which `GET /internal/state` serves (§3.1), and the
 * `call.state` events `/events` subscribers and webhooks receive (§10.6). Both track the same
 * three moments, so both are written here and cannot drift apart.
 */
import type { LiveCall } from '@zamfono/shared';

import type { EventBus, StateStore } from '../internal/server.js';
import type { Call } from './call.js';

/** The two collaborators the live view needs, so `CdrWriter` can publish the end as well. */
export type CallStateDeps = { state: StateStore; bus: EventBus };

/** Every user a subscriber may recognise this call by: the caller, the callee, the answerer. */
function participants(call: Call): string[] {
  const ids = new Set<string>();
  for (const id of [
    call.callerUserId,
    call.calleeUserId,
    call.answeredByUserId
  ]) {
    if (id !== null) {
      ids.add(id);
    }
  }
  for (const leg of call.legs.values()) {
    if (leg.userId !== null) {
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
    userIds: participants(call)
  };
}

function publish(
  deps: CallStateDeps,
  call: Call,
  state: 'ringing' | 'up' | 'ended'
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
    userIds: participants(call)
  });
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
