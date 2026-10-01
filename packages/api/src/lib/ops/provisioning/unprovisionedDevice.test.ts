import { afterEach, describe, expect, it, vi } from 'vitest';

import { newId, nowIso, type Db } from '@zamfono/shared';

import { ringotelLog } from '#lib/provisioning/ringotelBranchHooks.js';
import { installRingotelFake } from '#lib/provisioning/ringotelFake.js';
import { encrypt, keyringFromEnv } from '#lib/secretbox.js';
import { makeTestDb } from '#lib/testDb.js';

import { runOperation, type RunInput } from '../runner.js';
import { type Actor } from '../types.js';

import '../devices/index.js';
import '../users/index.js';
import './index.js';

process.env.SECRETBOX_KEY ??= `1:${Buffer.alloc(32, 7).toString('base64')}`;
process.env.ORIGIN ??= 'https://pbx.example.com';

const owner: Actor = { id: 'owner', name: 'Owner', role: 'owner' };

function asRun(): RunInput {
  return { actor: owner, channel: 'rest', requestId: 'req-1', confirm: true };
}

/** Seeds `settings` with a Ringotel API token and no organization/connection yet. */
async function seedSettings(db: Db): Promise<void> {
  const targetId = newId();
  await db
    .insertInto('forwardTargets')
    .values({ id: targetId, external: '+490000000' })
    .execute();
  const didId = newId();
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
      emergencyNumbersJson: '["112"]',
      mainDidId: didId,
      ringotelApiTokenEnc: encrypt(keyringFromEnv(process.env), 'ringotel-key')
    })
    .execute();
}

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

type Created = { device: { id: string } };

/** Anna (101) with a `ringotel` device, created before `provisioning.ringotelSetup` ran. */
async function deviceBeforeSetup(
  db: Db
): Promise<{ userId: string; device: Created }> {
  const { user } = await runOperation<unknown, { user: { id: string } }>(
    db,
    'users.create',
    { name: 'Anna', email: 'anna@x.test', extension: '101' },
    asRun()
  );
  // No provider exists yet, so no `createUser` runs for this device.
  const device = await runOperation<unknown, Created>(
    db,
    'devices.create',
    { userId: user.id, label: 'App', kind: 'ringotel' },
    asRun()
  );
  return { userId: user.id, device };
}

async function setup(db: Db): Promise<void> {
  await runOperation(
    db,
    'provisioning.ringotelSetup',
    { domain: 'testco', region: '3', packageid: 1 },
    asRun()
  );
}

/** The device's `ringotel.push` rows' changes, oldest first. */
async function pushTrail(db: Db, deviceId: string): Promise<unknown[]> {
  const rows = await db
    .selectFrom('auditLog')
    .select('changesJson')
    .where('operation', '=', 'ringotel.push')
    .where('entityId', '=', deviceId)
    .orderBy('createdAt')
    .orderBy('id')
    .execute();
  return rows.map(row => JSON.parse(row.changesJson) as unknown);
}

describe('a ringotel device created before provisioning.ringotelSetup (§10.4)', () => {
  it('is provisioned by the setup, with its stored credentials', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const ringotel = installRingotelFake([]);
    const { userId, device } = await deviceBeforeSetup(db);
    expect(ringotel.users).toEqual([]);

    await setup(db);

    const { sipPassword } = await runOperation<
      unknown,
      { sipPassword: string }
    >(db, 'devices.revealCredentials', { id: device.device.id }, asRun());
    expect(ringotel.users).toMatchObject([
      { extension: '101', name: 'Anna', password: sipPassword }
    ]);
    // The roster push then finds that user and moves it with the rename.
    await runOperation(
      db,
      'users.update',
      { id: userId, extension: '102' },
      asRun()
    );
    expect(ringotel.users).toMatchObject([{ extension: '102' }]);
  });

  it('pushes its stored BLF panel at setup', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const ringotel = installRingotelFake([]);
    const { device } = await deviceBeforeSetup(db);
    await runOperation(
      db,
      'devices.setBlf',
      { id: device.device.id, keys: ['101'] },
      asRun()
    );

    await setup(db);

    const blfPush = ringotel.calls.find(
      call => call.method === 'updateUser' && call.params.options !== undefined
    );
    expect(blfPush?.params.options).toEqual({
      blfs: [{ number: '101', title: 'Anna' }]
    });
  });
  it('ends its ringotel.push trail with what the setup pushed (§5.7)', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const ringotel = installRingotelFake([]);
    const { device } = await deviceBeforeSetup(db);

    await setup(db);

    const rows = await pushTrail(db, device.device.id);
    expect(rows.at(-1)).toEqual([
      { field: 'outcome', from: null, to: 'pushed' },
      { field: 'trigger', from: null, to: 'provisioning.ringotelSetup' },
      { field: 'ringotelUserId', from: null, to: ringotel.users[0]?.id }
    ]);
  });

  it('stands when Ringotel refuses the device, with a warning and a refused row', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const ringotel = installRingotelFake([]);
    const { device } = await deviceBeforeSetup(db);
    ringotel.failing.add('createUser');

    const output = await runOperation<
      unknown,
      { ringotelOrgId: string; warnings?: string[] }
    >(
      db,
      'provisioning.ringotelSetup',
      { domain: 'testco', region: '3', packageid: 1 },
      asRun()
    );

    expect(output.ringotelOrgId).toBeTruthy();
    expect(output.warnings).toEqual([
      expect.stringMatching(
        /has no Ringotel user yet, but Ringotel refused it .*devices[.]rotate/u
      )
    ]);
    const rows = await pushTrail(db, device.device.id);
    expect(rows.at(-1)).toEqual([
      { field: 'outcome', from: null, to: 'refused' },
      { field: 'trigger', from: null, to: 'provisioning.ringotelSetup' },
      { field: 'reason', from: null, to: expect.any(String) as unknown }
    ]);
  });
});

describe('a ringotel device whose Ringotel user is missing (§10.4, §5.2)', () => {
  /** A provisioned device whose Ringotel user was then removed in the Ringotel Shell. */
  async function orphanedDevice(
    db: Db
  ): Promise<{ ringotel: ReturnType<typeof installRingotelFake>; id: string }> {
    await seedSettings(db);
    const ringotel = installRingotelFake([]);
    await setup(db);
    const { device } = await deviceBeforeSetup(db);
    ringotel.users = [];
    return { ringotel, id: device.device.id };
  }

  it('rotate provisions it with the new password', async () => {
    const db = await makeTestDb();
    const { ringotel, id } = await orphanedDevice(db);

    const out = await runOperation<unknown, { sipPassword: string }>(
      db,
      'devices.rotate',
      { id },
      asRun()
    );

    expect(ringotel.users).toMatchObject([
      { extension: '101', password: out.sipPassword }
    ]);
  });

  it('setBlf provisions it before pushing the panel', async () => {
    const db = await makeTestDb();
    const { ringotel, id } = await orphanedDevice(db);

    await runOperation(db, 'devices.setBlf', { id, keys: ['101'] }, asRun());

    expect(ringotel.users).toMatchObject([{ extension: '101' }]);
  });

  it('delete succeeds with a logged warning, since nothing is left to free', async () => {
    const db = await makeTestDb();
    const { id } = await orphanedDevice(db);
    const warn = vi.spyOn(ringotelLog, 'warn');

    await runOperation(db, 'devices.delete', { id }, asRun());

    expect(warn).toHaveBeenCalledTimes(1);
    const row = await db
      .selectFrom('devices')
      .select('deletedAt')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row.deletedAt).not.toBeNull();
  });
});
