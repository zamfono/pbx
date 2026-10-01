import { afterEach, describe, expect, it } from 'vitest';

import { newId, nowIso, type Db } from '@zamfono/shared';

import {
  installRingotelFake,
  type RingotelFake
} from '$lib/server/provisioning/ringotelFake.js';
import { encrypt, keyringFromEnv } from '$lib/server/secretbox.js';
import { makeTestDb } from '$lib/server/testDb.js';

import { onPropagate } from '../propagationHooks.js';
import { runOperation, type RunInput } from '../runner.js';

import '../index.js';

process.env.SECRETBOX_KEY ??= `1:${Buffer.alloc(32, 7).toString('base64')}`;
process.env.ORIGIN = 'https://pbx.example.com';

const admin: RunInput = {
  actor: { id: 'admin', name: 'Admin', role: 'admin' },
  channel: 'mcp',
  requestId: 'req-1',
  confirm: true
};

// What happened, in order: the configuration reaching Asterisk, and each Ringotel call.
const events: string[] = [];
onPropagate(() => {
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
  const targetId = newId();
  const didId = newId();
  await db
    .insertInto('forwardTargets')
    .values({ id: targetId, external: '+490000000' })
    .execute();
  await db
    .insertInto('dids')
    .values({ id: didId, number: '+490000000', targetId, createdAt: nowIso() })
    .execute();
  await db
    .insertInto('settings')
    .values({
      id: 1,
      companyName: 'Test Co',
      country: 'DE',
      language: 'de',
      emergencyNumbersJson: '["112"]',
      mainDidId: didId,
      ringotelApiTokenEnc: encrypt(keyringFromEnv(process.env), 'ringotel-key'),
      ringotelOrgId: 'org-1',
      ringotelBranchId: 'branch-1'
    })
    .execute();
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

    const output = await runOperation<unknown, { warnings?: string[] }>(
      db,
      'devices.create',
      { userId, label: 'Phone', kind: 'ringotel' },
      admin
    );

    expect(events).toEqual(['propagated', 'createUser']);
    expect(fake.users.map(user => user.extension)).toEqual(['998']);
    expect(output.warnings).toBeUndefined();
  });

  it('stands, with a warning naming the reason, when Ringotel refuses the user', async () => {
    const db = await makeTestDb();
    const userId = await seed(db);
    const fake = install();
    fake.failing.add('createUser');

    const output = await runOperation<
      unknown,
      { device: { id: string }; warnings?: string[] }
    >(
      db,
      'devices.create',
      { userId, label: 'Phone', kind: 'ringotel' },
      admin
    );

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
    const created = await runOperation<unknown, { device: { id: string } }>(
      db,
      'devices.create',
      { userId, label: 'Phone', kind: 'ringotel' },
      admin
    );
    events.length = 0;

    await runOperation(db, 'devices.rotate', { id: created.device.id }, admin);

    expect(events[0]).toBe('propagated');
    expect(events).toContain('updateUser');
  });

  it('records each push outcome as a ringotel.push audit row on the device (§5.7)', async () => {
    const db = await makeTestDb();
    const userId = await seed(db);
    const fake = install();
    const created = await runOperation<unknown, { device: { id: string } }>(
      db,
      'devices.create',
      { userId, label: 'Phone', kind: 'ringotel' },
      admin
    );
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

  it('warns and audits a skip when Ringotel is not set up', async () => {
    const db = await makeTestDb();
    const userId = await seed(db);
    await db
      .updateTable('settings')
      .set({ ringotelOrgId: null, ringotelBranchId: null })
      .execute();

    const output = await runOperation<
      unknown,
      { device: { id: string }; warnings?: string[] }
    >(
      db,
      'devices.create',
      { userId, label: 'Phone', kind: 'ringotel' },
      admin
    );

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
    const created = await runOperation<unknown, { device: { id: string } }>(
      db,
      'devices.create',
      { userId, label: 'Phone', kind: 'ringotel' },
      admin
    );
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
