import * as privateEnv from '$app/env/private';
import { afterEach, describe, expect, it } from 'vitest';

import { newId, nowIso, type Db } from '@zamfono/shared';

import { encrypt, keyringFromEnv } from '#lib/server/secretbox.js';
import { asRun, makeTestDb, seedSettings } from '#testing/testDb.js';

import { runOperation } from '../runner.js';

import './index.js';

/** Seeds the tenant `settings` singleton and one live user with extension `101`. */
async function seedUser(db: Db): Promise<string> {
  await seedSettings(db);
  const userId = newId();
  await db
    .insertInto('users')
    .values({
      id: userId,
      name: 'Anna Huber',
      email: 'anna@x.test',
      role: 'user',
      createdAt: nowIso()
    })
    .execute();
  await db.insertInto('extensions').values({ ext: '101', userId }).execute();
  return userId;
}

type CreateOutput = {
  device: { id: string; sipUsername: string };
  connectionSettings: { password: string };
};

/** Marks the tenant as already provisioned with Ringotel, so `activeRingotelProvider` pushes. */
async function enableRingotel(db: Db): Promise<void> {
  await db
    .updateTable('settings')
    .set({
      ringotelOrgId: 'org-1',
      ringotelBranchId: 'branch-1',
      ringotelApiTokenEnc: encrypt(keyringFromEnv(privateEnv), 'ringotel-key')
    })
    .where('id', '=', 1)
    .execute();
}

type FetchCall = { method: string; params?: Record<string, unknown> };

/**
 * Stubs `globalThis.fetch` to record every Ringotel RPC call (§10.4), as `ops/provisioning`;
 * `createUser` answers with the new user's id, as the Admin API does.
 */
function stubFetch(overrides: Record<string, unknown> = {}): FetchCall[] {
  const results: Record<string, unknown> = {
    createUser: { id: 'ru-new' },
    ...overrides
  };
  const calls: FetchCall[] = [];
  globalThis.fetch = ((_url: string, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string) as FetchCall;
    calls.push(body);
    return Promise.resolve(
      new Response(JSON.stringify({ result: results[body.method] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );
  }) as typeof fetch;
  return calls;
}

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('devices.create/delete/rotate/setBlf: provisioning wiring (§10.4)', () => {
  it('create pushes createUser for a ringotel device once Ringotel is provisioned', async () => {
    const db = await makeTestDb();
    const userId = await seedUser(db);
    await enableRingotel(db);
    const calls = stubFetch();

    (await runOperation(
      db,
      'devices.create',
      { userId, label: 'App', kind: 'ringotel' },
      asRun()
    )) as CreateOutput;

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('createUser');
    expect(calls[0]?.params?.orgid).toBe('org-1');
    expect(calls[0]?.params?.branchid).toBe('branch-1');
    expect(calls[0]?.params?.extension).toBe('101');
    expect(calls[0]?.params?.status).toBe(1);
  });

  it('create returns no SIP credentials for a ringotel device; an admin reveals them (§5.2)', async () => {
    const db = await makeTestDb();
    const userId = await seedUser(db);
    await enableRingotel(db);
    const calls = stubFetch();

    const created = (await runOperation(
      db,
      'devices.create',
      { userId, label: 'App', kind: 'ringotel' },
      asRun()
    )) as Record<string, unknown>;

    expect(Object.keys(created)).toEqual(['device']);
    const revealed = (await runOperation(
      db,
      'devices.revealCredentials',
      { id: (created.device as { id: string }).id },
      asRun()
    )) as { sipPassword: string };
    expect(revealed.sipPassword).toBe(calls[0]?.params?.password);
  });

  it('create pushes nothing for a ringotel device while Ringotel is not provisioned', async () => {
    const db = await makeTestDb();
    const userId = await seedUser(db);
    const calls = stubFetch();

    (await runOperation(
      db,
      'devices.create',
      { userId, label: 'App', kind: 'ringotel' },
      asRun()
    )) as CreateOutput;

    expect(calls).toEqual([]);
  });

  it('delete pushes deleteUser, resolved via getUsers, for a ringotel device', async () => {
    const db = await makeTestDb();
    const userId = await seedUser(db);
    await enableRingotel(db);
    const calls = stubFetch({ getUsers: [{ id: 'ru-1', extension: '101' }] });
    const device = (await runOperation(
      db,
      'devices.create',
      { userId, label: 'App', kind: 'ringotel' },
      asRun()
    )) as CreateOutput;
    const callsBeforeDelete = calls.length;

    await runOperation(
      db,
      'devices.delete',
      { id: device.device.id },
      asRun({ confirm: true })
    );

    expect(calls.slice(callsBeforeDelete)).toEqual([
      { method: 'getUsers', params: { orgid: 'org-1', branchid: 'branch-1' } },
      { method: 'deleteUser', params: { orgid: 'org-1', id: 'ru-1' } }
    ]);
  });

  it('rotate pushes the new password via updateUser for a ringotel device', async () => {
    const db = await makeTestDb();
    const userId = await seedUser(db);
    await enableRingotel(db);
    const calls = stubFetch({ getUsers: [{ id: 'ru-1', extension: '101' }] });
    const device = (await runOperation(
      db,
      'devices.create',
      { userId, label: 'App', kind: 'ringotel' },
      asRun()
    )) as CreateOutput;
    const callsBeforeRotate = calls.length;

    await runOperation(
      db,
      'devices.rotate',
      { id: device.device.id },
      asRun({ confirm: true })
    );

    const rotateCalls = calls.slice(callsBeforeRotate);
    expect(rotateCalls[1]?.method).toBe('updateUser');
    expect(rotateCalls[1]?.params?.password).toBeDefined();
  });

  it('setBlf pushes the panel via updateUser options.blfs for a ringotel device', async () => {
    const db = await makeTestDb();
    const userId = await seedUser(db);
    await db
      .insertInto('extensions')
      .values({ ext: '701', isParkingSlot: 1 })
      .execute();
    await enableRingotel(db);
    const calls = stubFetch({ getUsers: [{ id: 'ru-1', extension: '101' }] });
    const device = (await runOperation(
      db,
      'devices.create',
      { userId, label: 'App', kind: 'ringotel' },
      asRun()
    )) as CreateOutput;
    const callsBeforeSetBlf = calls.length;

    await runOperation(
      db,
      'devices.setBlf',
      { id: device.device.id, keys: ['701'] },
      asRun()
    );

    expect(calls.slice(callsBeforeSetBlf)[1]).toEqual({
      method: 'updateUser',
      params: {
        orgid: 'org-1',
        id: 'ru-1',
        options: { blfs: [{ number: '701', title: 'Parking 701' }] }
      }
    });
  });
});

describe('devices', () => {
  it('create returns a 24-char alphanumeric password and stores only ciphertext', async () => {
    const db = await makeTestDb();
    const userId = await seedUser(db);
    const result = (await runOperation(
      db,
      'devices.create',
      { userId, label: 'Desk', kind: 'manual' },
      asRun()
    )) as CreateOutput;
    expect(result.connectionSettings.password).toMatch(/^[A-Za-z0-9]{24}$/u);
    const row = await db
      .selectFrom('devices')
      .select('sipPasswordEnc')
      .where('id', '=', result.device.id)
      .executeTakeFirstOrThrow();
    expect(Buffer.isBuffer(row.sipPasswordEnc)).toBe(true);
    expect(row.sipPasswordEnc.toString('utf8')).not.toContain(
      result.connectionSettings.password
    );
  });

  it("list answers a user's live devices", async () => {
    const db = await makeTestDb();
    const userId = await seedUser(db);
    const { device } = (await runOperation(
      db,
      'devices.create',
      { userId, label: 'Desk', kind: 'manual' },
      asRun()
    )) as CreateOutput;
    const page = (await runOperation(
      db,
      'devices.list',
      { userId },
      asRun()
    )) as { items: { id: string }[]; nextCursor: string | null };
    expect(page.items.map(item => item.id)).toEqual([device.id]);
    expect(page.nextCursor).toBeNull();
  });

  it('revealCredentials writes an undoable-0 audit row', async () => {
    const db = await makeTestDb();
    const userId = await seedUser(db);
    const device = (await runOperation(
      db,
      'devices.create',
      { userId, label: 'Desk', kind: 'manual' },
      asRun()
    )) as CreateOutput;
    await runOperation(
      db,
      'devices.revealCredentials',
      { id: device.device.id },
      asRun()
    );
    const audit = await db
      .selectFrom('auditLog')
      .select('undoable')
      .where('operation', '=', 'devices.revealCredentials')
      .executeTakeFirstOrThrow();
    expect(audit.undoable).toBe(0);
  });

  it('setBlf accepts a parking-slot extension and refuses an unknown one with 422', async () => {
    const db = await makeTestDb();
    const userId = await seedUser(db);
    await db
      .insertInto('extensions')
      .values({ ext: '701', isParkingSlot: 1 })
      .execute();
    const device = (await runOperation(
      db,
      'devices.create',
      { userId, label: 'App', kind: 'ringotel' },
      asRun()
    )) as CreateOutput;
    await expect(
      runOperation(
        db,
        'devices.setBlf',
        { id: device.device.id, keys: ['701'] },
        asRun()
      )
    ).resolves.toMatchObject({ keys: ['701'] });
    await expect(
      runOperation(
        db,
        'devices.setBlf',
        { id: device.device.id, keys: ['999'] },
        asRun()
      )
    ).rejects.toMatchObject({ status: 422 });
    const audit = await db
      .selectFrom('auditLog')
      .select('undoable')
      .where('operation', '=', 'devices.setBlf')
      .executeTakeFirstOrThrow();
    expect(audit.undoable).toBe(1);
  });

  it('create writes an undoable audit row (no secret-bearing diff field)', async () => {
    const db = await makeTestDb();
    const userId = await seedUser(db);
    (await runOperation(
      db,
      'devices.create',
      { userId, label: 'Desk', kind: 'manual' },
      asRun()
    )) as CreateOutput;
    const audit = await db
      .selectFrom('auditLog')
      .select('undoable')
      .where('operation', '=', 'devices.create')
      .executeTakeFirstOrThrow();
    expect(audit.undoable).toBe(1);
  });

  it('refuses an empty allowedIps on a plain device, on both create and update', async () => {
    const db = await makeTestDb();
    const userId = await seedUser(db);
    await expect(
      runOperation(
        db,
        'devices.create',
        {
          userId,
          label: 'Desk',
          kind: 'manual',
          transport: 'plain',
          allowedIps: []
        },
        asRun()
      )
    ).rejects.toMatchObject({ status: 422 });
    const device = (await runOperation(
      db,
      'devices.create',
      {
        userId,
        label: 'Desk',
        kind: 'manual',
        transport: 'plain',
        allowedIps: ['10.0.0.1']
      },
      asRun()
    )) as CreateOutput;
    await expect(
      runOperation(
        db,
        'devices.update',
        { id: device.device.id, allowedIps: [] },
        asRun()
      )
    ).rejects.toMatchObject({ status: 422 });
  });

  it('refuses allowedIps on a non-plain (default tls) device, with 422', async () => {
    const db = await makeTestDb();
    const userId = await seedUser(db);
    await expect(
      runOperation(
        db,
        'devices.create',
        {
          userId,
          label: 'Desk',
          kind: 'manual',
          allowedIps: ['10.0.0.1']
        },
        asRun()
      )
    ).rejects.toMatchObject({ status: 422 });
  });

  it('refuses a plain device while both plain transports are disabled', async () => {
    const db = await makeTestDb();
    const userId = await seedUser(db);
    const original = {
      udp: process.env.SIP_UDP_ENABLED,
      tcp: process.env.SIP_TCP_ENABLED
    };
    process.env.SIP_UDP_ENABLED = 'false';
    process.env.SIP_TCP_ENABLED = 'false';
    try {
      await expect(
        runOperation(
          db,
          'devices.create',
          {
            userId,
            label: 'Desk phone',
            kind: 'manual',
            transport: 'plain',
            allowedIps: ['10.0.0.1']
          },
          asRun()
        )
      ).rejects.toMatchObject({ status: 422 });
    } finally {
      process.env.SIP_UDP_ENABLED = original.udp;
      process.env.SIP_TCP_ENABLED = original.tcp;
    }
  });

  it('records an allowedIps change as wire arrays, not the stored JSON string', async () => {
    const db = await makeTestDb();
    const userId = await seedUser(db);
    const device = (await runOperation(
      db,
      'devices.create',
      {
        userId,
        label: 'Desk phone',
        kind: 'manual',
        transport: 'plain',
        allowedIps: ['10.0.0.1']
      },
      asRun()
    )) as CreateOutput;
    await runOperation(
      db,
      'devices.update',
      { id: device.device.id, allowedIps: ['10.0.0.2'] },
      asRun()
    );
    const audit = await db
      .selectFrom('auditLog')
      .select('changesJson')
      .where('operation', '=', 'devices.update')
      .where('entityId', '=', device.device.id)
      .executeTakeFirstOrThrow();
    const changes = JSON.parse(audit.changesJson) as {
      field: string;
      from: unknown;
      to: unknown;
    }[];
    expect(changes).toEqual(
      expect.arrayContaining([
        { field: 'allowedIps', from: ['10.0.0.1'], to: ['10.0.0.2'] }
      ])
    );
  });
});
