import { afterEach, describe, expect, it, vi } from 'vitest';

import { nowIso, type LiveCall, type StateResponse } from '@zamfono/shared';

import { getCoreClient } from '#lib/server/coreClient.js';
import { stubCoreClient } from '#lib/server/coreClientStub.js';
import { CoreRequestError } from '#lib/server/coreHttp.js';
import { makeTestDb } from '#lib/server/testDb.js';

import { runOperation } from '../runner.js';
import { type Actor } from '../types.js';

import './index.js';

function user(id: string): Actor {
  return { id, name: id, role: 'user' };
}

const admin: Actor = { id: 'admin', name: 'Admin', role: 'admin' };

function liveCall(callId: string, connectedUserIds: string[]): LiveCall {
  return {
    callId,
    direction: 'inbound',
    from: '+491701234567',
    to: '+4930123456',
    state: 'up',
    startedAt: nowIso(),
    ringGroupId: null,
    userIds: [...connectedUserIds, 'ringing'],
    connectedUserIds
  };
}

// As `core` reports them: a call `answerer` took, and the consultation they started from it,
// which `target` answered.
const CALLS: LiveCall[] = [
  liveCall('answered', ['caller', 'answerer']),
  liveCall('consultation', ['answerer', 'target']),
  liveCall('other', ['someone'])
];

/** Core doubles recording each call-control request as `<action> <callId> <body>`. */
function coreWith(calls: LiveCall[]): string[] {
  const requests: string[] = [];
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
  const record =
    (action: string) =>
    (callId: string, req: object): Promise<void> => {
      requests.push(`${action} ${callId} ${JSON.stringify(req)}`);
      return Promise.resolve();
    };
  const started =
    (action: string) =>
    (callId: string, req: object): Promise<{ callId: string }> => {
      requests.push(`${action} ${callId} ${JSON.stringify(req)}`);
      return Promise.resolve({ callId: `${action}-call` });
    };
  vi.mocked(getCoreClient).mockReturnValue(
    stubCoreClient({
      state: () => Promise.resolve(state),
      transfer: record('transfer'),
      addParty: started('addParty'),
      consult: started('consult'),
      attendedTransfer: record('attendedTransfer'),
      hold: record('hold'),
      resume: record('resume'),
      decline: record('decline')
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

describe('call control over the API (§10.3 "Live calls")', () => {
  it('lets whoever controls the call consult, add a party, hold and resume it, as themselves', async () => {
    const requests = coreWith(CALLS);
    const answerer = user('answerer');
    await expect(
      run(answerer, 'calls.consult', { id: 'answered', target: '102' })
    ).resolves.toEqual({ id: 'answered', callId: 'consult-call' });
    await expect(
      run(user('caller'), 'calls.addParty', { id: 'answered', target: '103' })
    ).resolves.toEqual({ id: 'answered', callId: 'addParty-call' });
    await run(answerer, 'calls.hold', { id: 'answered' });
    await run(answerer, 'calls.resume', { id: 'answered' });
    expect(requests).toEqual([
      'consult answered {"target":"102","actorUserId":"answerer"}',
      'addParty answered {"target":"103","actorUserId":"caller"}',
      'hold answered {"actorUserId":"answerer"}',
      'resume answered {"actorUserId":"answerer"}'
    ]);
  });

  it('refuses another user with 403, and lets an admin control any call', async () => {
    const requests = coreWith(CALLS);
    const stranger = user('stranger');
    for (const [name, input] of [
      ['calls.consult', { id: 'answered', target: '102' }],
      ['calls.addParty', { id: 'answered', target: '102' }],
      ['calls.hold', { id: 'answered' }],
      ['calls.resume', { id: 'answered' }],
      ['calls.transfer', { id: 'answered', toCallId: 'consultation' }]
    ] as const) {
      // eslint-disable-next-line no-await-in-loop -- one refusal at a time, each its own case
      await expect(run(stranger, name, input)).rejects.toMatchObject({
        status: 403
      });
    }
    expect(requests).toEqual([]);
    await run(admin, 'calls.hold', { id: 'other' });
    expect(requests).toEqual(['hold other {"actorUserId":"admin"}']);
  });

  it('transfers to the consultation only for one who controls both calls', async () => {
    const requests = coreWith(CALLS);
    await run(user('answerer'), 'calls.transfer', {
      id: 'answered',
      toCallId: 'consultation'
    });
    await expect(
      run(user('caller'), 'calls.transfer', {
        id: 'answered',
        toCallId: 'consultation'
      })
    ).rejects.toMatchObject({ status: 403 });
    expect(requests).toEqual([
      'attendedTransfer answered {"toCallId":"consultation","actorUserId":"answerer"}'
    ]);
  });

  it('takes either a target or a consultation to transfer to, not both or neither', async () => {
    coreWith(CALLS);
    for (const input of [
      { id: 'answered' },
      { id: 'answered', target: '102', toCallId: 'consultation' }
    ]) {
      // eslint-disable-next-line no-await-in-loop -- one refusal at a time, each its own case
      await expect(
        run(user('answerer'), 'calls.transfer', input)
      ).rejects.toMatchObject({ status: 422 });
    }
  });

  it('declines only the caller’s own ring, needing no control of the call', async () => {
    const requests = coreWith(CALLS);
    await run(user('ringing'), 'calls.decline', { id: 'answered' });
    await expect(
      run(user('ringing'), 'calls.decline', { id: 'answered', userId: 'x' })
    ).rejects.toMatchObject({ status: 422 });
    expect(requests).toEqual(['decline answered {"actorUserId":"ringing"}']);
  });

  it('answers core’s refusals as their problems, 422 for a target nobody answers on', async () => {
    coreWith(CALLS);
    vi.mocked(getCoreClient).mockReturnValue({
      ...getCoreClient(),
      addParty: () =>
        Promise.reject(
          new CoreRequestError('http://core.test', 422, {
            title: 'no party answers on this target',
            detail: 'invalidTarget'
          })
        ),
      decline: () =>
        Promise.reject(
          new CoreRequestError('http://core.test', 409, {
            title: 'nothing of yours is ringing for this call',
            detail: 'notRinging'
          })
        )
    });
    await expect(
      run(admin, 'calls.addParty', { id: 'answered', target: '799' })
    ).rejects.toMatchObject({ status: 422, detail: 'invalidTarget' });
    await expect(
      run(user('nobody'), 'calls.decline', { id: 'answered' })
    ).rejects.toMatchObject({ status: 409, detail: 'notRinging' });
  });
});
