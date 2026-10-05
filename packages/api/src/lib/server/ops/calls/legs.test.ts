import { afterEach, describe, expect, it, vi } from 'vitest';

import { nowIso, type LiveCall, type StateResponse } from '@zamfono/shared';

import { getCoreClient } from '#lib/server/coreClient.js';
import { stubCoreClient } from '#testing/coreClientStub.js';
import { makeTestDb } from '#testing/testDb.js';

import { runOperation } from '../runner.js';
import { OpError, type Actor } from '../types.js';

import './index.js';

// §10.3 "Live calls": the legs the live calls list, and the actions that name one (`legId`).

const admin: Actor = { id: 'admin', name: 'Admin', role: 'admin' };
const anna: Actor = { id: 'anna', name: 'Anna', role: 'user' };

// A DID forwarded to a SIP target: no user in it.
const SIP_FORWARD: LiveCall = {
  callId: 'sip',
  direction: 'inbound',
  from: '+491701234567',
  to: '+4930123456',
  state: 'up',
  startedAt: nowIso(),
  ringGroupId: null,
  userIds: [],
  connectedUserIds: [],
  legs: [
    { id: 'leg-caller', role: 'caller', state: 'up', trunkId: 'trunk-1' },
    {
      id: 'leg-sip',
      role: 'callee',
      state: 'up',
      trunkId: 'trunk-2',
      target: 'sip:desk@example.com'
    }
  ]
};
const ANNAS: LiveCall = {
  ...SIP_FORWARD,
  callId: 'annas',
  userIds: ['anna'],
  connectedUserIds: ['anna'],
  legs: [
    { id: 'leg-anna', role: 'caller', state: 'up', userId: 'anna' },
    { id: 'leg-far', role: 'callee', state: 'up', trunkId: 'trunk-1' }
  ]
};

function core(): string[] {
  const requests: string[] = [];
  const state: StateResponse = {
    calls: [SIP_FORWARD, ANNAS],
    trunks: {},
    trunkChannels: {},
    presence: {},
    registeredDevices: 0,
    recordingMixFailures: 0,
    asteriskChannels: 0,
    recordingsInProgress: 0
  };
  const record =
    (action: string) =>
    (callId: string, req: object): Promise<void> => {
      requests.push(`${action} ${callId} ${JSON.stringify(req)}`);
      return Promise.resolve();
    };
  vi.mocked(getCoreClient).mockReturnValue(
    stubCoreClient({
      state: () => Promise.resolve(state),
      transfer: record('transfer'),
      hangup: record('hangup')
    })
  );
  return requests;
}

async function run(
  actor: Actor,
  name: string,
  input: Record<string, unknown>
): Promise<unknown> {
  return runOperation(await makeTestDb(), name, input, {
    actor,
    channel: 'rest',
    requestId: 'req-1'
  });
}

afterEach(() => {
  vi.mocked(getCoreClient).mockReset();
});

describe('live legs over the API (§10.3 "Live calls")', () => {
  it('lists every call’s legs, a call with no user in it included', async () => {
    core();
    const listed = (await run(admin, 'calls.list', { live: true })) as {
      items: { callId: string; legs: unknown }[];
    };
    expect(listed.items.map(({ callId, legs }) => ({ callId, legs }))).toEqual([
      { callId: 'sip', legs: SIP_FORWARD.legs },
      { callId: 'annas', legs: ANNAS.legs }
    ]);
  });

  it('transfers the leg an admin names in a call with no user, and refuses one naming none', async () => {
    const requests = core();
    await expect(
      run(admin, 'calls.transfer', { id: 'sip', target: '101' })
    ).rejects.toMatchObject({ status: 422 });
    await run(admin, 'calls.transfer', {
      id: 'sip',
      target: '101',
      legId: 'leg-caller'
    });
    expect(requests).toEqual([
      'transfer sip {"target":"101","actorUserId":"admin","legId":"leg-caller"}'
    ]);
  });

  it('lets a user name a leg of their own call only, and hang up that leg alone', async () => {
    const requests = core();
    await expect(
      run(anna, 'calls.transfer', {
        id: 'sip',
        target: '101',
        legId: 'leg-caller'
      })
    ).rejects.toMatchObject({ status: 403 });
    await run(anna, 'calls.hangup', { id: 'annas', legId: 'leg-far' });
    expect(requests).toEqual([
      'hangup annas {"actorUserId":"anna","legId":"leg-far"}'
    ]);
  });

  it('answers core’s refusal of an unknown leg as its 404', async () => {
    core();
    vi.mocked(getCoreClient).mockReturnValue({
      ...getCoreClient(),
      transfer: () =>
        Promise.reject(new OpError(404, 'no such leg', 'legNotFound'))
    });
    await expect(
      run(admin, 'calls.transfer', { id: 'sip', target: '101', legId: 'x' })
    ).rejects.toMatchObject({ status: 404, detail: 'legNotFound' });
  });
});
