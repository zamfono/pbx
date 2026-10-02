import { describe, expect, it } from 'vitest';

import { newId, nowIso, type Db } from '@zamfono/shared';

import { makeTestDb } from '#lib/server/testDb.js';

import { runOperation, type RunInput } from '../runner.js';
import { Conflict, type Actor } from '../types.js';

import './index.js';

const owner: Actor = { id: 'owner', name: 'Owner', role: 'owner' };

function asRun(overrides: Partial<RunInput> = {}): RunInput {
  return { actor: owner, channel: 'rest', requestId: 'req-1', ...overrides };
}

/** Inserts a live `dids` row and the `settings` singleton, with `extLength` when given (default 3). */
async function seedSettings(db: Db, extLength?: number): Promise<void> {
  const targetId = newId();
  await db
    .insertInto('forwardTargets')
    .values({
      id: targetId,
      userId: null,
      ringGroupId: null,
      external: '+490000000',
      mailboxUserId: null,
      mailboxRingGroupId: null,
      announcementAudioId: null,
      menuId: null
    })
    .execute();
  const mainDidId = newId();
  await db
    .insertInto('dids')
    .values({
      id: mainDidId,
      number: '+490000000',
      label: null,
      targetId,
      createdAt: nowIso()
    })
    .execute();
  await db
    .insertInto('settings')
    .values({
      id: 1,
      companyName: 'Test Co',
      country: 'DE',
      emergencyNumbersJson: '["112"]',
      mainDidId,
      ...(extLength === undefined ? {} : { extLength })
    })
    .execute();
}

describe('parking', () => {
  it('replaces the slot set as a whole', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const result = await runOperation<unknown, { slots: string[] }>(
      db,
      'parking.set',
      { slots: ['701', '702'] },
      asRun()
    );
    expect(result.slots).toEqual(['701', '702']);
    const read = await runOperation<unknown, { slots: string[] }>(
      db,
      'parking.get',
      {},
      asRun()
    );
    expect(read.slots).toEqual(['701', '702']);
  });

  it('refuses a slot whose length does not match settings.ext_length', async () => {
    const db = await makeTestDb();
    await seedSettings(db, 4);
    await expect(
      runOperation(db, 'parking.set', { slots: ['701'] }, asRun())
    ).rejects.toMatchObject({ status: 422 });
    await runOperation(db, 'parking.set', { slots: ['7001'] }, asRun());
    const read = await runOperation<unknown, { slots: string[] }>(
      db,
      'parking.get',
      {},
      asRun()
    );
    expect(read.slots).toEqual(['7001']);
  });

  it('refuses a slot that collides with a user extension', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    await db
      .insertInto('extensions')
      .values({
        ext: '101',
        userId: 'owner',
        ringGroupId: null,
        isParkingSlot: 0
      })
      .execute();
    await expect(
      runOperation(db, 'parking.set', { slots: ['101'] }, asRun())
    ).rejects.toThrow(Conflict);
  });

  it("drops a removed slot's BLF keys through the FK", async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    await runOperation(db, 'parking.set', { slots: ['701', '702'] }, asRun());
    const deviceId = newId();
    await db
      .insertInto('devices')
      .values({
        id: deviceId,
        userId: 'owner',
        label: 'Desk',
        kind: 'manual',
        transport: 'tls',
        allowedIpsJson: null,
        sipUsername: 'dev1',
        sipPasswordEnc: Buffer.from('x'),
        createdAt: nowIso()
      })
      .execute();
    await db
      .insertInto('deviceBlfKeys')
      .values({ deviceId, ext: '701', position: 1 })
      .execute();
    await runOperation(db, 'parking.set', { slots: ['702'] }, asRun());
    const keys = await db.selectFrom('deviceBlfKeys').selectAll().execute();
    expect(keys).toHaveLength(0);
  });
});
