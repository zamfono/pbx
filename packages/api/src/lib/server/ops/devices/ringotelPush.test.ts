import * as privateEnv from '$app/env/private';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { newId, nowIso, type Db } from '@zamfono/shared';

import { propagateConfig } from '#lib/server/propagation.js';
import {
  installRingotelFake,
  type RingotelFake
} from '#lib/server/provisioning/ringotelFake.js';
import { encrypt, keyringFromEnv } from '#lib/server/secretbox.js';
import { makeTestDb, seedSettings } from '#lib/server/testDb.js';

import { runOperation, type RunInput } from '../runner.js';

import '../index.js';

process.env.FQDN = 'pbx.example.com';

const admin: RunInput = {
  actor: { id: 'admin', name: 'Admin', role: 'admin' },
  channel: 'mcp',
  requestId: 'req-1',
  confirm: true
};

// What happened, in order: the configuration reaching Asterisk, and each Ringotel call.
const events: string[] = [];
vi.mocked(propagateConfig).mockImplementation(() => {
  events.push('propagated');
  return Promise.resolve();
});

const installed: { fake?: RingotelFake } = {};

function install(): RingotelFake {
  installed.fake = installRingotelFake();
  const record = installed.fake;
  const recordedFetch = globalThis.fetch;
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    events.push(
      (JSON.parse(init?.body as string) as { method: string }).method
    );
    return recordedFetch(url, init);
  }) as typeof fetch;
  return record;
}

afterEach(() => {
  installed.fake?.restore();
  delete installed.fake;
  events.length = 0;
});

/** A stack set up with Ringotel (`org-1`, the fake's), and user 998 with an e-mail address. */
async function seed(db: Db): Promise<string> {
  await seedSettings(db, {
    language: 'de',
    ringotelApiTokenEnc: encrypt(keyringFromEnv(privateEnv), 'ringotel-key'),
    ringotelOrgId: 'org-1',
    ringotelBranchId: 'branch-1'
  });
  const userId = newId();
  await db
    .insertInto('users')
    .values({
      id: userId,
      name: 'Test',
      email: 'test@example.com',
      role: 'user',
      createdAt: nowIso()
    })
    .execute();
  await db.insertInto('extensions').values({ ext: '998', userId }).execute();
  return userId;
}

/** The device's `ringotel.push` audit rows, oldest first. */
async function pushRows(db: Db, deviceId: string) {
  return db
    .selectFrom('auditLog')
    .selectAll()
    .where('operation', '=', 'ringotel.push')
    .where('entityId', '=', deviceId)
    .orderBy('id')
    .execute();
}

describe('a ringotel device reaches Ringotel once Asterisk holds it (§10.4)', () => {
  it('is created at Ringotel only after its configuration propagated', async () => {
    const db = await makeTestDb();
    const userId = await seed(db);
    const fake = install();

    const output = (await runOperation(
      db,
      'devices.create',
      { userId, label: 'Phone', kind: 'ringotel' },
      admin
    )) as { warnings?: string[] };

    expect(events).toEqual(['propagated', 'createUser']);
    expect(fake.users.map(user => user.extension)).toEqual(['998']);
    expect(output.warnings).toBeUndefined();
  });

  it('stands, with a warning naming the reason, when Ringotel refuses the user', async () => {
    const db = await makeTestDb();
    const userId = await seed(db);
    const fake = install();
    fake.failing.add('createUser');

    const output = (await runOperation(
      db,
      'devices.create',
      { userId, label: 'Phone', kind: 'ringotel' },
      admin
    )) as { device: { id: string }; warnings?: string[] };

    expect(output.warnings).toEqual([
      expect.stringMatching(
        /has no Ringotel user yet, but Ringotel refused it \(ringotel: 'createUser' failed: createUser failed\); devices\.rotate/u
      )
    ]);
    const stored = await db
      .selectFrom('devices')
      .select('id')
      .where('id', '=', output.device.id)
      .executeTakeFirst();
    expect(stored).toBeDefined();
  });

  it('gets its rotated password at Ringotel only after it propagated', async () => {
    const db = await makeTestDb();
    const userId = await seed(db);
    install();
    const created = (await runOperation(
      db,
      'devices.create',
      { userId, label: 'Phone', kind: 'ringotel' },
      admin
    )) as { device: { id: string } };
    events.length = 0;

    await runOperation(db, 'devices.rotate', { id: created.device.id }, admin);

    expect(events[0]).toBe('propagated');
    expect(events).toContain('updateUser');
  });

  it('records each push outcome as a ringotel.push audit row on the device (§5.7)', async () => {
    const db = await makeTestDb();
    const userId = await seed(db);
    const fake = install();
    const created = (await runOperation(
      db,
      'devices.create',
      { userId, label: 'Phone', kind: 'ringotel' },
      admin
    )) as { device: { id: string } };
    fake.failing.add('updateUser');
    await runOperation(db, 'devices.rotate', { id: created.device.id }, admin);

    const rows = await pushRows(db, created.device.id);
    expect(rows.map(row => [row.channel, row.actorUserId])).toEqual([
      ['mcp', 'admin'],
      ['mcp', 'admin']
    ]);
    expect(rows.map(row => row.undoable)).toEqual([0, 0]);
    expect(rows.map(row => JSON.parse(row.changesJson) as unknown)).toEqual([
      [
        { field: 'outcome', from: null, to: 'pushed' },
        { field: 'trigger', from: null, to: 'devices.create' },
        { field: 'ringotelUserId', from: null, to: fake.users[0]?.id }
      ],
      [
        { field: 'outcome', from: null, to: 'refused' },
        { field: 'trigger', from: null, to: 'devices.rotate' },
        {
          field: 'reason',
          from: null,
          to: expect.stringContaining('updateUser') as unknown
        }
      ]
    ]);
  });

  it('audits a Ringotel key it cannot use as a refusal, with a warning', async () => {
    const db = await makeTestDb();
    const userId = await seed(db);
    await db
      .updateTable('settings')
      .set({ ringotelApiTokenEnc: null })
      .execute();

    const output = (await runOperation(
      db,
      'devices.create',
      { userId, label: 'Phone', kind: 'ringotel' },
      admin
    )) as { device: { id: string }; warnings?: string[] };

    expect(output.warnings).toEqual([
      expect.stringMatching(/Ringotel refused it \(ringotel: no API token/u)
    ]);
    const rows = await pushRows(db, output.device.id);
    expect(JSON.parse(rows[0]?.changesJson ?? '[]')).toMatchObject([
      { field: 'outcome', to: 'refused' },
      { field: 'trigger', to: 'devices.create' },
      { field: 'reason', to: expect.stringMatching(/no API token/u) as unknown }
    ]);
  });

  it.each([
    ['devices.rotate', (id: string) => ({ id })],
    ['devices.setBlf', (id: string) => ({ id, keys: ['998'] })]
  ])(
    '%s recovers, rather than recreates, a restored device whose user Ringotel deleted within 24 h',
    async (operation, input) => {
      const db = await makeTestDb();
      const userId = await seed(db);
      const fake = install();
      const created = (await runOperation(
        db,
        'devices.create',
        { userId, label: 'Phone', kind: 'ringotel' },
        admin
      )) as { device: { id: string } };
      const remoteId = fake.users[0]?.id;
      await runOperation(
        db,
        'devices.delete',
        { id: created.device.id },
        admin
      );
      const entry = await db
        .selectFrom('auditLog')
        .select('id')
        .where('operation', '=', 'devices.delete')
        .executeTakeFirstOrThrow();
      // The undo's own push is lost, as to a restart, so the next push finds no Ringotel user.
      fake.failing.add('recoverDeletedUser');
      await runOperation(db, 'audit.undo', { id: entry.id }, admin);
      fake.failing.delete('recoverDeletedUser');
      events.length = 0;

      await runOperation(db, operation, input(created.device.id), admin);

      expect(events).toContain('recoverDeletedUser');
      expect(events).not.toContain('createUser');
      expect(fake.users.map(user => user.id)).toEqual([remoteId]);
    }
  );

  it('warns and audits a skip when Ringotel is not set up', async () => {
    const db = await makeTestDb();
    const userId = await seed(db);
    await db
      .updateTable('settings')
      .set({ ringotelOrgId: null, ringotelBranchId: null })
      .execute();

    const output = (await runOperation(
      db,
      'devices.create',
      { userId, label: 'Phone', kind: 'ringotel' },
      admin
    )) as { device: { id: string }; warnings?: string[] };

    expect(output.warnings).toEqual([
      expect.stringMatching(/Ringotel is not set up/u)
    ]);
    const rows = await pushRows(db, output.device.id);
    expect(JSON.parse(rows[0]?.changesJson ?? '[]')).toEqual([
      { field: 'outcome', from: null, to: 'skipped' },
      { field: 'trigger', from: null, to: 'devices.create' },
      { field: 'reason', from: null, to: 'Ringotel is not set up' }
    ]);
  });

  it('leaves an undo of the creation possible after its push was audited', async () => {
    const db = await makeTestDb();
    const userId = await seed(db);
    install();
    const created = (await runOperation(
      db,
      'devices.create',
      { userId, label: 'Phone', kind: 'ringotel' },
      admin
    )) as { device: { id: string } };
    const entry = await db
      .selectFrom('auditLog')
      .select('id')
      .where('operation', '=', 'devices.create')
      .executeTakeFirstOrThrow();

    await runOperation(db, 'audit.undo', { id: entry.id }, admin);

    const device = await db
      .selectFrom('devices')
      .select('deletedAt')
      .where('id', '=', created.device.id)
      .executeTakeFirstOrThrow();
    expect(device.deletedAt).not.toBeNull();
  });
});
