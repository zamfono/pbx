import * as privateEnv from '$app/env/private';
import { afterEach, describe, expect, it } from 'vitest';

import { newId, nowIso, type Db } from '@zamfono/shared';

import { setPropagationPending } from '#lib/server/propagationPending.js';
import {
  installRingotelFake,
  type RingotelFake
} from '#lib/server/provisioning/ringotelFake.js';
import { encrypt, keyringFromEnv } from '#lib/server/secretbox.js';
import { makeTestDb, seedSettings } from '#lib/server/testDb.js';

import { runOperation, type RunInput } from '../runner.js';
import { oweDevicePushesAtStart } from './_ringotelPush.js';

import '../index.js';

const kr = keyringFromEnv(privateEnv);

const admin: RunInput = {
  actor: { id: 'admin', name: 'Admin', role: 'admin' },
  channel: 'mcp',
  requestId: 'req-1',
  confirm: true
};

const installed: { fake?: RingotelFake } = {};

afterEach(() => {
  installed.fake?.restore();
  delete installed.fake;
});

/** A user with extension `ext`, and its `ringotel` device unless `device` is false. */
async function seedUser(db: Db, ext: string, device = true): Promise<string> {
  const userId = newId();
  await db
    .insertInto('users')
    .values({
      id: userId,
      name: `User ${ext}`,
      email: `${ext}@example.com`,
      role: 'user',
      createdAt: nowIso()
    })
    .execute();
  await db.insertInto('extensions').values({ ext, userId }).execute();
  if (device) {
    await db
      .insertInto('devices')
      .values({
        id: `device-${ext}`,
        userId,
        label: 'App',
        kind: 'ringotel',
        sipUsername: `e${ext}`,
        sipPasswordEnc: encrypt(kr, `password-${ext}`),
        createdAt: nowIso()
      })
      .execute();
  }
  return userId;
}

/**
 * A stack set up with Ringotel whose `api` restarted while a propagation was owed: 998's device
 * reached Ringotel with a password since rotated, and 997's never did, both pushes having waited
 * in the `api` before this one.
 */
async function seed(db: Db): Promise<RingotelFake> {
  await seedSettings(db, {
    ringotelApiTokenEnc: encrypt(kr, 'ringotel-key'),
    ringotelOrgId: 'org-1',
    ringotelBranchId: 'branch-1'
  });
  await seedUser(db, '998');
  await seedUser(db, '997');
  const fake = installRingotelFake();
  installed.fake = fake;
  fake.users.push({
    id: 'remote-998',
    extension: '998',
    username: 'e998',
    authname: 'e998',
    name: 'User 998',
    email: '998@example.com',
    password: 'the password before the rotation'
  });
  return fake;
}

/** Every `ringotel.push` row's device and trigger, oldest first. */
async function pushes(
  db: Db
): Promise<{ device: string | null; trigger: unknown }[]> {
  const rows = await db
    .selectFrom('auditLog')
    .select(['entityId', 'changesJson'])
    .where('operation', '=', 'ringotel.push')
    .orderBy('id')
    .execute();
  return rows.map(row => ({
    device: row.entityId,
    trigger: (
      JSON.parse(row.changesJson) as { field: string; to: unknown }[]
    ).find(change => change.field === 'trigger')?.to
  }));
}

// §3.1 "Config propagation": what an `api` restart drops of the steps held for an owed
// propagation is pushed again once one succeeds.
describe('an api that starts while a propagation is owed', () => {
  it('pushes every ringotel device once, after the first write that propagates', async () => {
    const db = await makeTestDb();
    const fake = await seed(db);
    await setPropagationPending(db, true);
    await oweDevicePushesAtStart(db);
    const userId = await seedUser(db, '996', false);

    const created = (await runOperation(
      db,
      'devices.create',
      { userId, label: 'App', kind: 'ringotel' },
      admin
    )) as { device: { id: string } };
    await runOperation(db, 'devices.rotate', { id: 'device-998' }, admin);

    // The write's own push goes first, so the push of every device finds its user.
    expect((await pushes(db)).slice(0, 4)).toEqual([
      { device: created.device.id, trigger: 'devices.create' },
      { device: 'device-998', trigger: 'api.start' },
      { device: 'device-997', trigger: 'api.start' },
      { device: created.device.id, trigger: 'api.start' }
    ]);
    expect((await pushes(db)).slice(4)).toEqual([
      { device: 'device-998', trigger: 'devices.rotate' }
    ]);
    expect(fake.users.map(user => user.extension).sort()).toEqual([
      '996',
      '997',
      '998'
    ]);
    expect(fake.users.find(user => user.extension === '997')?.password).toBe(
      'password-997'
    );
  });

  it('pushes nothing more when no propagation was owed at its start', async () => {
    const db = await makeTestDb();
    await seed(db);
    await oweDevicePushesAtStart(db);

    await runOperation(db, 'devices.rotate', { id: 'device-997' }, admin);

    expect(await pushes(db)).toEqual([
      { device: 'device-997', trigger: 'devices.rotate' }
    ]);
  });
});
