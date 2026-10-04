import { describe, expect, it } from 'vitest';

import { type Db } from '@zamfono/shared';
import { seedSettings } from '@zamfono/shared/testDb.js';

import { createTrunk } from '#testing/fixtures.js';
import { asConfirmedRun, makeTestDb } from '#testing/testDb.js';

import { runOperation } from '../runner.js';

import '../devices/index.js';
import '../mailTemplates/index.js';
import '../outboundRoutes/index.js';
import '../parking/index.js';
import '../trunks/index.js';
import '../users/index.js';
import './index.js';

/** The latest `operation` entry, the one an undo of that operation reverts. */
async function latestEntry(db: Db, operation: string): Promise<string> {
  const entry = await db
    .selectFrom('auditLog')
    .select('id')
    .where('operation', '=', operation)
    .orderBy('id', 'desc')
    .executeTakeFirstOrThrow();
  return entry.id;
}

async function undoLatest(db: Db, operation: string): Promise<void> {
  const id = await latestEntry(db, operation);
  await runOperation(db, 'audit.undo', { id }, asConfirmedRun());
}

async function liveTrunkOrder(db: Db): Promise<string[]> {
  const rows = await db
    .selectFrom('trunks')
    .select('id')
    .where('deletedAt', 'is', null)
    .orderBy('priority')
    .execute();
  return rows.map(row => row.id);
}

type Routes = { items: { id: string; numbers: { number: string }[] }[] };

describe('audit.undo of a tenant-wide list replace', () => {
  it('restores the outbound routes a replace dropped', async () => {
    const db = await makeTestDb();
    const trunkId = (await createTrunk(db, { name: 'Provider A' })).trunk.id;
    const before = (await runOperation(
      db,
      'outboundRoutes.list',
      {},
      asConfirmedRun()
    )) as Routes;
    await runOperation(
      db,
      'outboundRoutes.replace',
      {
        routes: [
          {
            trunkId,
            users: [],
            userGroups: [],
            numbers: [{ number: '+491701234567' }]
          }
        ]
      },
      asConfirmedRun()
    );

    await undoLatest(db, 'outboundRoutes.replace');

    const after = (await runOperation(
      db,
      'outboundRoutes.list',
      {},
      asConfirmedRun()
    )) as Routes;
    expect(after.items).toEqual(before.items);
  });

  it('restores the trunk order', async () => {
    const db = await makeTestDb();
    const first = (await createTrunk(db, { name: 'Provider A' })).trunk.id;
    const second = (await createTrunk(db, { name: 'Provider B' })).trunk.id;
    await runOperation(
      db,
      'trunks.setOrder',
      { trunkIds: [second, first] },
      asConfirmedRun()
    );

    await undoLatest(db, 'trunks.setOrder');

    expect(await liveTrunkOrder(db)).toEqual([first, second]);
  });

  it('refuses to restore a trunk order once another trunk exists, naming it', async () => {
    const db = await makeTestDb();
    const first = (await createTrunk(db, { name: 'Provider A' })).trunk.id;
    const second = (await createTrunk(db, { name: 'Provider B' })).trunk.id;
    await runOperation(
      db,
      'trunks.setOrder',
      { trunkIds: [second, first] },
      asConfirmedRun()
    );
    const third = (await createTrunk(db, { name: 'Provider C' })).trunk.id;
    const id = await latestEntry(db, 'trunks.setOrder');

    await expect(
      runOperation(db, 'audit.undo', { id }, asConfirmedRun())
    ).rejects.toMatchObject({
      status: 409,
      references: [{ kind: 'trunk', id: third, label: 'Provider C' }]
    });
    expect(await liveTrunkOrder(db)).toEqual([second, first, third]);
  });
});

describe('audit.undo of a parking or mail-template change', () => {
  it('restores a removed parking slot and the BLF key its removal dropped', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    await runOperation(db, 'parking.set', { slots: ['701'] }, asConfirmedRun());
    const { user } = (await runOperation(
      db,
      'users.create',
      { name: 'Anna', email: 'anna@x.test', extension: '101' },
      asConfirmedRun()
    )) as { user: { id: string } };
    const { device } = (await runOperation(
      db,
      'devices.create',
      { userId: user.id, label: 'App', kind: 'ringotel' },
      asConfirmedRun()
    )) as { device: { id: string } };
    await runOperation(
      db,
      'devices.setBlf',
      { id: device.id, keys: ['701'] },
      asConfirmedRun()
    );
    await runOperation(db, 'parking.set', { slots: [] }, asConfirmedRun());

    await undoLatest(db, 'parking.set');

    const slots = (await runOperation(
      db,
      'parking.get',
      {},
      asConfirmedRun()
    )) as {
      slots: string[];
    };
    expect(slots.slots).toEqual(['701']);
    const blf = (await runOperation(
      db,
      'devices.getBlf',
      { id: device.id },
      asConfirmedRun()
    )) as { keys: string[] };
    expect(blf.keys).toEqual(['701']);
  });

  it('takes a mail-template override back to the one before, then to none', async () => {
    const db = await makeTestDb();
    const key = { kind: 'reset', language: 'en' };
    const first = { subject: 'First', bodyText: 'Reset: {{link}}' };
    await runOperation(
      db,
      'mailTemplates.put',
      { ...key, ...first },
      asConfirmedRun()
    );
    await runOperation(
      db,
      'mailTemplates.put',
      { ...key, subject: 'Second', bodyText: 'Again: {{link}}' },
      asConfirmedRun()
    );

    await undoLatest(db, 'mailTemplates.put');
    const restored = (await runOperation(
      db,
      'mailTemplates.get',
      key,
      asConfirmedRun()
    )) as { source: string };
    expect(restored).toMatchObject({ ...first, source: 'tenant' });

    // The live first `put` created the override: its undo removes it.
    const firstPut = await db
      .selectFrom('auditLog')
      .select('id')
      .where('operation', '=', 'mailTemplates.put')
      .where('undoneAt', 'is', null)
      .executeTakeFirstOrThrow();
    await runOperation(db, 'audit.undo', { id: firstPut.id }, asConfirmedRun());
    const builtin = (await runOperation(
      db,
      'mailTemplates.get',
      key,
      asConfirmedRun()
    )) as { source: string };
    expect(builtin.source).toBe('builtin');
  });

  it('re-inserts a deleted mail-template override', async () => {
    const db = await makeTestDb();
    const key = { kind: 'reset', language: 'en' };
    const override = { subject: 'Ours', bodyText: 'Reset: {{link}}' };
    await runOperation(
      db,
      'mailTemplates.put',
      { ...key, ...override },
      asConfirmedRun()
    );
    await runOperation(db, 'mailTemplates.delete', key, asConfirmedRun());

    await undoLatest(db, 'mailTemplates.delete');

    const read = (await runOperation(
      db,
      'mailTemplates.get',
      key,
      asConfirmedRun()
    )) as { source: string };
    expect(read).toMatchObject({ ...override, source: 'tenant' });
  });
});
