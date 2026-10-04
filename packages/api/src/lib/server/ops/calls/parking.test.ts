import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  nowIso,
  type LiveCall,
  type ParkedCall,
  type StateResponse
} from '@zamfono/shared';

import { createCoreClient, getCoreClient } from '#lib/server/coreClient.js';
import { handleRest } from '#lib/server/rest.js';
import { stubCoreClient } from '#testing/coreClientStub.js';
import { makeTestDb } from '#testing/testDb.js';

import '../parking/index.js';

import { runOperation } from '../runner.js';
import { type Actor } from '../types.js';

import './index.js';

// `calls.park`, `parking.list` and what `calls.transfer`'s `voicemail` and `calls.originate`'s
// `clir` hand to `core` (§10.2 "Call parking", §9.3 `*97<ext>`, §9.4 "Anonymous calls (CLIR)").

function user(id: string): Actor {
  return { id, name: id, role: 'user' };
}

const admin: Actor = { id: 'admin', name: 'Admin', role: 'admin' };

// A call `anna` answered and `ben` only rang for, and a parked one nobody is connected in.
const CALLS: LiveCall[] = [
  {
    callId: 'answered',
    direction: 'inbound',
    from: '+491701234567',
    to: '101',
    state: 'up',
    startedAt: nowIso(),
    ringGroupId: null,
    userIds: ['anna', 'ben'],
    connectedUserIds: ['anna']
  },
  {
    callId: 'parked',
    direction: 'inbound',
    from: '+491701234567',
    to: '101',
    state: 'up',
    startedAt: nowIso(),
    ringGroupId: null,
    userIds: ['anna'],
    connectedUserIds: []
  }
];

const PARKED: ParkedCall[] = [
  {
    slot: '701',
    callId: 'parked',
    caller: null,
    parkedAt: nowIso(),
    parkedByUserId: 'anna'
  }
];

/** A `core` that knows `CALLS` and `PARKED` and records every request a call action makes. */
function core(): unknown[] {
  const requests: unknown[] = [];
  const state: StateResponse = {
    calls: CALLS,
    trunks: {},
    trunkChannels: {},
    presence: {},
    registeredDevices: 0,
    recordingMixFailures: 0,
    asteriskChannels: 0,
    recordingsInProgress: 0
  };
  const client = stubCoreClient({
    state: () => Promise.resolve(state),
    park: (callId, req) => {
      requests.push({ park: callId, ...req });
      return Promise.resolve({ slot: '702' });
    },
    parked: () => Promise.resolve({ parked: PARKED }),
    hangup: callId => {
      requests.push({ hangup: callId });
      return Promise.resolve();
    },
    transfer: (callId, req) => {
      requests.push({ transfer: callId, ...req });
      return Promise.resolve();
    },
    originate: req => {
      requests.push({ originate: req.target, ...req });
      return Promise.resolve({ callId: 'new' });
    }
  });
  vi.mocked(getCoreClient).mockReturnValue(client);
  return requests;
}

async function run(
  actor: Actor,
  operation: string,
  input: unknown
): Promise<unknown> {
  return runOperation(await makeTestDb(), operation, input, {
    actor,
    channel: 'rest',
    requestId: 'req-1'
  });
}

/** A `core` that refuses every request as `internal/actionRoutes.ts` does. */
function coreRefusing(status: number, title: string, reason: string): void {
  const fetchFn = (() =>
    Promise.resolve(
      new Response(
        JSON.stringify({ type: 'about:blank', title, status, detail: reason }),
        { status, headers: { 'content-type': 'application/problem+json' } }
      )
    )) as typeof fetch;
  vi.mocked(getCoreClient).mockReturnValue(
    createCoreClient('http://core.test', fetchFn)
  );
}

async function post(path: string, body: unknown): Promise<Response> {
  return handleRest(
    new Request(`http://pbx.test/api/v1${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }),
    admin,
    { db: await makeTestDb(), requestId: 'req-1' }
  );
}

afterEach(() => {
  vi.mocked(getCoreClient).mockReset();
});

describe('calls.park', () => {
  it('lets the user connected in the call park it, and returns the slot', async () => {
    const requests = core();
    await expect(
      run(user('anna'), 'calls.park', { id: 'answered' })
    ).resolves.toEqual({ id: 'answered', slot: '702' });
    expect(requests).toEqual([
      { park: 'answered', userId: 'anna', actorUserId: 'anna' }
    ]);
  });

  it('refuses a user not connected in the call, and a user parking for someone else', async () => {
    const requests = core();
    await expect(
      run(user('ben'), 'calls.park', { id: 'answered' })
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      run(user('anna'), 'calls.park', { id: 'answered', userId: 'ben' })
    ).rejects.toMatchObject({ status: 403 });
    expect(requests).toEqual([]);
  });

  it('lets an admin park on behalf of the user in the call', async () => {
    const requests = core();
    await run(admin, 'calls.park', { id: 'answered', userId: 'anna' });
    expect(requests).toEqual([
      { park: 'answered', userId: 'anna', actorUserId: 'admin' }
    ]);
  });

  it('answers a park with every slot taken with 409 noFreeSlot', async () => {
    coreRefusing(409, 'no parking slot is free', 'noFreeSlot');
    const response = await post('/calls/answered/park', {});
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      title: 'no parking slot is free',
      detail: 'noFreeSlot'
    });
  });
});

describe('a parked call (§10.2 "Call parking")', () => {
  it('is listed for every user, its withheld caller without a number', async () => {
    core();
    await expect(run(user('ben'), 'parking.list', {})).resolves.toEqual({
      items: PARKED,
      nextCursor: null
    });
    await expect(
      run(user('ben'), 'parking.list', { limit: 1 })
    ).resolves.toMatchObject({ items: PARKED.slice(0, 1) });
  });

  it('is hung up by an admin only, nobody being connected in it', async () => {
    const requests = core();
    await expect(
      run(user('anna'), 'calls.hangup', { id: 'parked' })
    ).rejects.toMatchObject({ status: 403 });
    await run(admin, 'calls.hangup', { id: 'parked' });
    expect(requests).toEqual([{ hangup: 'parked' }]);
  });
});

describe('calls.transfer with voicemail', () => {
  it('hands the flag to core with the target whose mailbox takes the call', async () => {
    const requests = core();
    await run(user('anna'), 'calls.transfer', {
      id: 'answered',
      target: '102',
      voicemail: true
    });
    await run(user('anna'), 'calls.transfer', {
      id: 'answered',
      target: '103'
    });
    expect(requests).toEqual([
      {
        transfer: 'answered',
        target: '102',
        actorUserId: 'anna',
        voicemail: true
      },
      { transfer: 'answered', target: '103', actorUserId: 'anna' }
    ]);
  });

  it('refuses a user not connected in the call', async () => {
    core();
    await expect(
      run(user('ben'), 'calls.transfer', {
        id: 'answered',
        target: '102',
        voicemail: true
      })
    ).rejects.toMatchObject({ status: 403 });
  });

  it('answers a target that owns no mailbox with 422 noMailbox', async () => {
    coreRefusing(422, 'the target owns no mailbox', 'noMailbox');
    const response = await post('/calls/answered/transfer', {
      target: '999',
      voicemail: true
    });
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      detail: 'noMailbox'
    });
  });
});

describe('calls.originate with clir', () => {
  it("hands the call's own CLIR to core, and nothing when left out", async () => {
    const requests = core();
    await run(user('anna'), 'calls.originate', {
      target: '+4930123456',
      clir: true
    });
    await run(user('anna'), 'calls.originate', { target: '102' });
    expect(requests).toEqual([
      {
        originate: '+4930123456',
        userId: 'anna',
        target: '+4930123456',
        actorUserId: 'anna',
        requestId: 'req-1',
        clir: true
      },
      {
        originate: '102',
        userId: 'anna',
        target: '102',
        actorUserId: 'anna',
        requestId: 'req-1'
      }
    ]);
  });
});
