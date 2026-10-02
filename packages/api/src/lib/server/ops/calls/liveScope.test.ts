import { afterEach, describe, expect, it } from 'vitest';

import { nowIso, type LiveCall, type StateResponse } from '@zamfono/shared';

import { createCoreClient, type CoreClient } from '#lib/server/coreClient.js';
import { makeTestDb } from '#lib/server/testDb.js';

import { runOperation } from '../runner.js';
import { type Actor } from '../types.js';
import { setCoreClientForTest } from './_shared.js';

import './index.js';

function user(id: string): Actor {
  return { id, name: id, role: 'user' };
}

const admin: Actor = { id: 'admin', name: 'Admin', role: 'admin' };

function liveCall(
  callId: string,
  state: LiveCall['state'],
  users: { userIds: string[]; connectedUserIds: string[] }
): LiveCall {
  return {
    callId,
    direction: 'inbound',
    from: '+491701234567',
    to: '+4930123456',
    state,
    startedAt: nowIso(),
    ringGroupId: null,
    ...users
  };
}

// As `core` reports them (`calls/callState.ts`): a ring-group call `answerer` took while `loser`
// rang too, one still ringing `ringing`, and one `forwarder` forwarded to `target`, who answered.
const CALLS: LiveCall[] = [
  liveCall('answered', 'up', {
    userIds: ['caller', 'answerer'],
    connectedUserIds: ['caller', 'answerer']
  }),
  liveCall('ringing', 'ringing', {
    userIds: ['caller', 'ringing'],
    connectedUserIds: ['caller']
  }),
  liveCall('forwarded', 'up', {
    userIds: ['forwarder', 'target'],
    connectedUserIds: ['target']
  })
];

function coreWith(calls: LiveCall[]): string[] {
  const actions: string[] = [];
  const state: StateResponse = {
    calls,
    trunks: {},
    trunkChannels: {},
    presence: {},
    registeredDevices: 0,
    recordingMixFailures: 0,
    asteriskChannels: 0,
    recordingsInProgress: 0
  };
  const client: CoreClient = {
    ...createCoreClient('http://core.test'),
    state: () => Promise.resolve(state),
    hangup: callId => {
      actions.push(`hangup ${callId}`);
      return Promise.resolve();
    },
    transfer: callId => {
      actions.push(`transfer ${callId}`);
      return Promise.resolve();
    }
  };
  setCoreClientForTest(client);
  return actions;
}

async function act(
  actor: Actor,
  action: 'hangup' | 'transfer',
  id: string
): Promise<unknown> {
  const input = action === 'hangup' ? { id } : { id, target: '102' };
  return runOperation(await makeTestDb(), `calls.${action}`, input, {
    actor,
    channel: 'rest',
    requestId: 'req-1'
  });
}

async function liveIds(actor: Actor): Promise<string[]> {
  const result = await runOperation<unknown, { items: LiveCall[] }>(
    await makeTestDb(),
    'calls.list',
    { live: true },
    { actor, channel: 'rest', requestId: 'req-1' }
  );
  return result.items.map(item => item.callId);
}

afterEach(() => {
  setCoreClientForTest(createCoreClient());
});

describe('who may see and control a live call (§10.3 "Live calls")', () => {
  it('leaves a call out for a member whose leg no longer rings, and refuses them control', async () => {
    coreWith(CALLS);
    const loser = user('loser');
    await expect(liveIds(loser)).resolves.toEqual([]);
    await expect(act(loser, 'hangup', 'answered')).rejects.toMatchObject({
      status: 403
    });
    await expect(act(loser, 'transfer', 'answered')).rejects.toMatchObject({
      status: 403
    });
  });

  it('shows a ringing member the call, but does not let them end it', async () => {
    coreWith(CALLS);
    const ringing = user('ringing');
    await expect(liveIds(ringing)).resolves.toEqual(['ringing']);
    await expect(act(ringing, 'hangup', 'ringing')).rejects.toMatchObject({
      status: 403
    });
  });

  it('shows a callee the call they forwarded, but does not let them control it', async () => {
    coreWith(CALLS);
    const forwarder = user('forwarder');
    await expect(liveIds(forwarder)).resolves.toEqual(['forwarded']);
    await expect(act(forwarder, 'hangup', 'forwarded')).rejects.toMatchObject({
      status: 403
    });
    await expect(act(forwarder, 'transfer', 'forwarded')).rejects.toMatchObject(
      { status: 403 }
    );
  });

  it('lets the caller and whoever answered end or transfer it', async () => {
    const actions = coreWith(CALLS);
    await act(user('caller'), 'hangup', 'ringing');
    await act(user('answerer'), 'transfer', 'answered');
    await act(user('target'), 'hangup', 'forwarded');
    expect(actions).toEqual([
      'hangup ringing',
      'transfer answered',
      'hangup forwarded'
    ]);
  });

  it('lets an admin control any call', async () => {
    const actions = coreWith(CALLS);
    await act(admin, 'hangup', 'forwarded');
    await act(admin, 'transfer', 'answered');
    expect(actions).toEqual(['hangup forwarded', 'transfer answered']);
  });

  it('lists a live call without who may control it', async () => {
    coreWith(CALLS);
    const result = await runOperation<unknown, { items: object[] }>(
      await makeTestDb(),
      'calls.list',
      { live: true },
      { actor: admin, channel: 'rest', requestId: 'req-1' }
    );
    expect(result.items).toHaveLength(CALLS.length);
    for (const item of result.items) {
      expect(item).not.toHaveProperty('connectedUserIds');
      expect(item).toHaveProperty('userIds');
    }
  });
});
