import { describe, expect, it } from 'vitest';

import { newId, nowIso } from '@zamfono/shared';

import { asRun, makeTestDb, seedSettings } from '#lib/server/testDb.js';

import { runOperation } from '../runner.js';
import { Conflict } from '../types.js';

import './index.js';

describe('parking', () => {
  it('replaces the slot set as a whole', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const result = (await runOperation(
      db,
      'parking.set',
      { slots: ['701', '702'] },
      asRun()
    )) as { slots: string[] };
    expect(result.slots).toEqual(['701', '702']);
    const read = (await runOperation(db, 'parking.get', {}, asRun())) as {
      slots: string[];
    };
    expect(read.slots).toEqual(['701', '702']);
  });

  it('refuses a slot whose length does not match settings.ext_length', async () => {
    const db = await makeTestDb();
    await seedSettings(db, { extLength: 4 });
    await expect(
      runOperation(db, 'parking.set', { slots: ['701'] }, asRun())
    ).rejects.toMatchObject({ status: 422 });
    await runOperation(db, 'parking.set', { slots: ['7001'] }, asRun());
    const read = (await runOperation(db, 'parking.get', {}, asRun())) as {
      slots: string[];
    };
    expect(read.slots).toEqual(['7001']);
  });

  it('refuses an emergency number as a slot (§9.4 "Dial-plan resolution")', async () => {
    const db = await makeTestDb();
    await seedSettings(db, { emergencyNumbersJson: '["110","112"]' });
    await expect(
      runOperation(db, 'parking.set', { slots: ['110'] }, asRun())
    ).rejects.toMatchObject({ status: 422, message: /emergency/u });
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
