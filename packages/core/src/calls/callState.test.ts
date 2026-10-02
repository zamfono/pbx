import { beforeEach, describe, expect, it } from 'vitest';

import { newId, nowIso, type Envelope } from '@zamfono/shared';

import { EventBus } from '../internal/eventBus.js';
import { StateStore } from '../internal/stateStore.js';
import { onEvents } from '../testing/busEvents.js';
import { newCall, type Call, type Leg } from './call.js';
import {
  callEnded,
  callPartiesChanged,
  callRinging,
  callUp,
  liveView,
  type CallStateDeps
} from './callState.js';
import type { GroupLeg } from './groupLegs.js';
import { endLeg, trackLeg } from './legs.js';
import type { Pipeline } from './pipeline.js';

type CallStateEvent = Extract<Envelope, { type: 'call.state' }>;

function leg(userId: string, state: Leg['state']): Leg {
  return {
    channelId: newId(),
    kind: 'device',
    userId,
    state,
    endCause: null
  };
}

function groupLeg(userId: string, state: GroupLeg['state']): GroupLeg {
  return { channelId: newId(), userId, memberKey: userId, state };
}

/** The parts of a `Pipeline` that `trackLeg` and `endLeg` touch. */
function fakePipeline(deps: CallStateDeps): Pipeline {
  return {
    deps,
    callByChannel: new Map<string, Call>(),
    pendingFindMeAccept: new Map()
  } as unknown as Pipeline;
}

describe('a live call’s users (§10.3 "Live calls", §10.6)', () => {
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let deps: CallStateDeps;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let call: Call;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let events: CallStateEvent[];

  beforeEach(() => {
    deps = { state: new StateStore(), bus: new EventBus() };
    events = [];
    onEvents(deps.bus, envelope => {
      if (envelope.type === 'call.state') {
        events.push(envelope);
      }
    });
    call = newCall({
      id: newId(),
      direction: 'internal',
      callerChannelId: newId(),
      from: '101',
      to: '102',
      startedAt: nowIso(),
      logLevel: 'events',
      callLogMaxBytes: 1_048_576
    });
    call.callerUserId = 'caller';
    call.calleeUserId = 'callee';
  });

  function live(): { userIds: string[]; connectedUserIds: string[] } {
    const view = liveView(
      deps.state.calls.get(call.id) ?? expect.unreachable()
    );
    return {
      userIds: [...view.userIds].sort(),
      connectedUserIds: [...view.connectedUserIds].sort()
    };
  }

  it('counts ringing and up legs, not ended ones; only the caller and up legs control', () => {
    for (const entry of [
      leg('ringing', 'ringing'),
      leg('up', 'up'),
      leg('ended', 'ended')
    ]) {
      call.legs.set(entry.channelId, entry);
    }
    call.batchLegs = new Map(
      [groupLeg('member', 'ringing'), groupLeg('declined', 'ended')].map(
        entry => [entry.channelId, entry]
      )
    );
    call.answeredByUserId = 'up';
    callUp(deps, call);

    expect(live()).toEqual({
      userIds: ['callee', 'caller', 'member', 'ringing', 'up'],
      connectedUserIds: ['caller', 'up']
    });
  });

  it('no longer counts a caller whose channel left as controlling: parked, or handed over', () => {
    const answered = leg('callee', 'up');
    call.legs.set(answered.channelId, answered);
    callUp(deps, call);
    // The caller parked the other party: their channel left the call for good.
    call.callerEnded = true;
    expect(live().connectedUserIds).toEqual(['callee']);
    expect(live().userIds).toContain('caller');

    // An attended transfer handed the caller's place to the transferee's channel.
    delete call.callerEnded;
    call.callerChannelUserId = 'transferee';
    expect(live()).toEqual({
      userIds: ['callee', 'caller', 'transferee'],
      connectedUserIds: ['callee', 'transferee']
    });
    expect(call.callerUserId).toBe('caller');
  });

  it('serves the users as they are now, not as they were at the last transition', () => {
    const ringing = leg('member', 'ringing');
    call.legs.set(ringing.channelId, ringing);
    callRinging(deps, call);
    expect(live().userIds).toContain('member');

    ringing.state = 'ended';
    expect(live().userIds).not.toContain('member');
    const served = JSON.parse(JSON.stringify(deps.state.snapshot())) as {
      calls: { userIds: string[]; connectedUserIds: string[] }[];
    };
    expect(served.calls[0]?.userIds.sort()).toEqual(['callee', 'caller']);
    expect(served.calls[0]?.connectedUserIds).toEqual(['caller']);
  });

  it('sends ended to a user whose leg stops ringing, and nothing after', () => {
    const pipeline = fakePipeline(deps);
    const ringing = leg('member', 'ringing');
    trackLeg(pipeline, call, ringing);
    callRinging(deps, call);
    expect(events.at(-1)?.userIds).toContain('member');

    endLeg(pipeline, ringing.channelId, ringing);
    expect(events.at(-1)).toMatchObject({
      state: 'ended',
      userIds: ['member'],
      usersOnly: true
    });
    expect(deps.state.calls.get(call.id)?.state).toBe('ringing');

    callUp(deps, call);
    callEnded(deps, call);
    for (const event of events.slice(-2)) {
      expect(event.userIds).not.toContain('member');
      expect(event.usersOnly).toBeUndefined();
    }
  });

  it('sends a user whose leg starts ringing the call’s state, to them alone', () => {
    const pipeline = fakePipeline(deps);
    callRinging(deps, call);
    trackLeg(pipeline, call, leg('findMe', 'ringing'));

    expect(events.at(-1)).toMatchObject({
      state: 'ringing',
      userIds: ['findMe'],
      usersOnly: true
    });
  });

  it('reaches a losing member with the up event, then ended (§10.6)', () => {
    const winner = leg('winner', 'ringing');
    const loser = leg('loser', 'ringing');
    for (const entry of [winner, loser]) {
      call.legs.set(entry.channelId, entry);
    }
    callRinging(deps, call);
    winner.state = 'up';
    call.answeredByUserId = 'winner';
    callUp(deps, call);
    expect(events.at(-1)).toMatchObject({ state: 'up', userId: 'winner' });
    expect(events.at(-1)?.userIds).toContain('loser');

    loser.state = 'ended';
    callPartiesChanged(deps, call);
    expect(events.at(-1)).toMatchObject({
      state: 'ended',
      userIds: ['loser'],
      usersOnly: true
    });
    expect(live().userIds).toEqual(['callee', 'caller', 'winner']);
  });

  it('sends the end to a user whose leg ended without an event of its own', () => {
    const answered = leg('answerer', 'up');
    call.legs.set(answered.channelId, answered);
    callUp(deps, call);
    answered.state = 'ended';
    callEnded(deps, call);

    expect(events.at(-1)?.state).toBe('ended');
    expect(events.at(-1)?.userIds.sort()).toEqual([
      'answerer',
      'callee',
      'caller'
    ]);
    expect(deps.state.calls.has(call.id)).toBe(false);
  });

  it('tells nobody of a call not in the live view', () => {
    call.legs.set('x', leg('member', 'ringing'));
    callPartiesChanged(deps, call);
    expect(events).toEqual([]);
  });
});
