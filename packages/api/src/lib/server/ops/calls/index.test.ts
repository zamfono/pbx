import { describe, expect, it, vi } from 'vitest';

import {
  newId,
  nowIso,
  type Db,
  type LiveCall,
  type StateResponse
} from '@zamfono/shared';

import { getCoreClient } from '#lib/server/coreClient.js';
import { stubCoreClient } from '#lib/server/coreClientStub.js';
import { handleRest } from '#lib/server/rest.js';
import { makeTestDb, seedTenantTimeZone } from '#lib/server/testDb.js';

import { runOperation, type RunInput } from '../runner.js';
import { type Actor } from '../types.js';

import './index.js';

const owner: Actor = { id: 'owner', name: 'Owner', role: 'owner' };
const anna: Actor = { id: 'u1', name: 'Anna', role: 'user' };

function asRun(overrides: Partial<RunInput> = {}): RunInput {
  return { actor: owner, channel: 'rest', requestId: 'req-1', ...overrides };
}

async function seedUser(db: Db, id: string): Promise<void> {
  await db
    .insertInto('users')
    .values({
      id,
      name: id,
      email: `${id}@x.test`,
      role: 'user',
      createdAt: nowIso()
    })
    .execute();
}

async function seedCall(
  db: Db,
  fields: {
    callerUserId?: string;
    calleeUserId?: string;
    answeredByUserId?: string;
    inProgress?: boolean;
  }
): Promise<string> {
  const id = newId();
  await db
    .insertInto('calls')
    .values({
      id,
      direction: 'internal',
      fromUri: '101',
      toUri: '102',
      // A call in progress keeps core's placeholder row: no end yet (cdr.ts `open()`).
      status: fields.inProgress === true ? 'interrupted' : 'answered',
      startedAt: nowIso(),
      endedAt: fields.inProgress === true ? null : nowIso(),
      callerUserId: fields.callerUserId ?? null,
      calleeUserId: fields.calleeUserId ?? null,
      answeredByUserId: fields.answeredByUserId ?? null
    })
    .execute();
  return id;
}

describe('calls', () => {
  it("calls.list as user excludes other users' calls", async () => {
    const db = await makeTestDb();
    await seedTenantTimeZone(db, null);
    await seedUser(db, 'u1');
    await seedUser(db, 'u2');
    await seedUser(db, 'u3');
    const asCaller = await seedCall(db, { callerUserId: 'u1' });
    const asCallee = await seedCall(db, { calleeUserId: 'u1' });
    const asAnswerer = await seedCall(db, { answeredByUserId: 'u1' });
    await seedCall(db, { callerUserId: 'u2', calleeUserId: 'u3' });

    const result = await runOperation<unknown, { items: { id: string }[] }>(
      db,
      'calls.list',
      {},
      asRun({ actor: anna })
    );
    expect(new Set(result.items.map(item => item.id))).toEqual(
      new Set([asCaller, asCallee, asAnswerer])
    );
  });

  it('calls.list and calls.get leave out a call still in progress (§10.1 "Call aggregate")', async () => {
    const db = await makeTestDb();
    await seedTenantTimeZone(db, null);
    const ended = await seedCall(db, {});
    const live = await seedCall(db, { inProgress: true });

    const result = await runOperation<unknown, { items: { id: string }[] }>(
      db,
      'calls.list',
      {},
      asRun()
    );
    const attempt = runOperation(db, 'calls.get', { id: live }, asRun());

    expect(result.items.map(item => item.id)).toEqual([ended]);
    await expect(attempt).rejects.toMatchObject({ status: 404 });
  });

  it('calls.list compares `from` with an offset as the instant it names, and `to` without one in the tenant zone', async () => {
    const db = await makeTestDb();
    await seedTenantTimeZone(db, 'Europe/Berlin');
    const ids = [newId(), newId(), newId()];
    const starts = [
      '2026-10-01T09:59:59.999Z',
      '2026-10-01T10:00:00.000Z',
      '2026-10-01T10:30:00.000Z'
    ];
    await db
      .insertInto('calls')
      .values(
        ids.map((id, index) => ({
          id,
          direction: 'internal',
          fromUri: '101',
          toUri: '102',
          status: 'answered',
          startedAt: starts[index] ?? '',
          endedAt: '2026-10-01T11:00:00.000Z'
        }))
      )
      .execute();

    const result = await runOperation<unknown, { items: { id: string }[] }>(
      db,
      'calls.list',
      { from: '2026-10-01T12:00:00+02:00', to: '2026-10-01T12:30:00' },
      asRun()
    );

    expect(result.items.map(item => item.id).sort()).toEqual(
      [ids[1], ids[2]].sort()
    );
  });

  it('live: true returns the core snapshot, filtered to own calls for a user', async () => {
    const db = await makeTestDb();
    const ownCall: LiveCall = {
      callId: 'call-1',
      direction: 'internal',
      from: '101',
      to: '102',
      state: 'up',
      startedAt: nowIso(),
      ringGroupId: null,
      userIds: ['u1'],
      connectedUserIds: ['u1']
    };
    const otherCall: LiveCall = {
      callId: 'call-2',
      direction: 'internal',
      from: '103',
      to: '104',
      state: 'up',
      startedAt: nowIso(),
      ringGroupId: null,
      userIds: ['u2'],
      connectedUserIds: ['u2']
    };
    const state: StateResponse = {
      calls: [ownCall, otherCall],
      trunks: {},
      trunkChannels: {},
      registeredDevices: 0,
      recordingMixFailures: 0,
      asteriskChannels: 0,
      recordingsInProgress: 0,
      presence: {}
    };
    vi.mocked(getCoreClient).mockReturnValue(
      stubCoreClient({ state: () => Promise.resolve(state) })
    );

    const asOwner = await runOperation<unknown, { items: LiveCall[] }>(
      db,
      'calls.list',
      { live: true },
      asRun()
    );
    expect(asOwner.items.map(item => item.callId).sort()).toEqual([
      'call-1',
      'call-2'
    ]);

    const asUser = await runOperation<unknown, { items: LiveCall[] }>(
      db,
      'calls.list',
      { live: true },
      asRun({ actor: anna })
    );
    expect(asUser.items.map(item => item.callId)).toEqual(['call-1']);
  });

  it('calls.originate by a user for another user is refused', async () => {
    const db = await makeTestDb();
    await expect(
      runOperation(
        db,
        'calls.originate',
        { target: '101', userId: 'someone-else' },
        asRun({ actor: anna })
      )
    ).rejects.toMatchObject({ status: 403 });
  });

  it('calls.originate proxies to core and reports a missing device as 409', async () => {
    const db = await makeTestDb();
    vi.mocked(getCoreClient).mockReturnValue(
      stubCoreClient({
        originate: () => Promise.resolve({ error: 'noRegisteredDevice' })
      })
    );
    await expect(
      runOperation(
        db,
        'calls.originate',
        { target: '101' },
        asRun({ actor: anna })
      )
    ).rejects.toMatchObject({ status: 409, detail: 'noRegisteredDevice' });
  });

  it('POST /calls answers a missing device as a problem whose detail names the cause (§10.2)', async () => {
    const db = await makeTestDb();
    vi.mocked(getCoreClient).mockReturnValue(
      stubCoreClient({
        originate: () => Promise.resolve({ error: 'noRegisteredDevice' })
      })
    );
    const response = await handleRest(
      new Request('http://pbx.test/api/v1/calls', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ target: '101' })
      }),
      anna,
      { db, requestId: 'req-1' }
    );
    expect(response.status).toBe(409);
    expect(response.headers.get('content-type')).toBe(
      'application/problem+json'
    );
    await expect(response.json()).resolves.toEqual({
      type: 'about:blank',
      title: 'no device is registered for this user',
      status: 409,
      detail: 'noRegisteredDevice'
    });
  });
  it('calls.get carries the call log and its QoS rows (§7)', async () => {
    const db = await makeTestDb();
    await seedUser(db, anna.id);
    const callId = await seedCall(db, { callerUserId: anna.id });
    await db
      .updateTable('calls')
      .set({ log: '{"event":"didMatch"}' })
      .where('id', '=', callId)
      .execute();
    await db
      .insertInto('callQos')
      .values([
        {
          callId,
          channelId: 'PJSIP/trunk-1',
          role: 'caller',
          jitterMs: 4,
          lossPct: 0.5,
          rttMs: 21,
          rxPackets: 1500,
          txPackets: 1490
        },
        // A device whose audio never reached the stack: nothing measured, no packet received.
        {
          callId,
          channelId: 'PJSIP/u1-dev',
          role: 'callee',
          jitterMs: null,
          lossPct: null,
          rttMs: null,
          rxPackets: 0,
          txPackets: 1480
        }
      ])
      .execute();

    const call = await runOperation<
      unknown,
      {
        id: string;
        log: string | null;
        qos: {
          channelId: string;
          role: string;
          jitterMs: number | null;
          lossPct: number | null;
          rttMs: number | null;
          rxPackets: number | null;
          txPackets: number | null;
        }[];
      }
    >(db, 'calls.get', { id: callId }, asRun());

    expect(call.id).toBe(callId);
    expect(call.log).toBe('{"event":"didMatch"}');
    expect(call.qos).toEqual([
      {
        channelId: 'PJSIP/trunk-1',
        role: 'caller',
        jitterMs: 4,
        lossPct: 0.5,
        rttMs: 21,
        rxPackets: 1500,
        txPackets: 1490
      },
      {
        channelId: 'PJSIP/u1-dev',
        role: 'callee',
        jitterMs: null,
        lossPct: null,
        rttMs: null,
        rxPackets: 0,
        txPackets: 1480
      }
    ]);
  });

  it("calls.get refuses a user another user's call, with 403", async () => {
    const db = await makeTestDb();
    await seedUser(db, anna.id);
    await seedUser(db, 'u2');
    const callId = await seedCall(db, { callerUserId: 'u2' });

    const attempt = runOperation(
      db,
      'calls.get',
      { id: callId },
      asRun({ actor: anna })
    );

    await expect(attempt).rejects.toMatchObject({ status: 403 });
  });

  it('calls.get answers 404 for an unknown call', async () => {
    const db = await makeTestDb();

    const attempt = runOperation(db, 'calls.get', { id: 'nope' }, asRun());

    await expect(attempt).rejects.toMatchObject({ status: 404 });
  });
});
