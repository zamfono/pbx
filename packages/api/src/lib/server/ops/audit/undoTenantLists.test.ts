import { describe, expect, it } from 'vitest';

import { newId, nowIso, type Db } from '@zamfono/shared';

import { makeTestDb } from '#lib/server/testDb.js';

import { runOperation, type RunInput } from '../runner.js';
import { type Actor } from '../types.js';

import '../devices/index.js';
import '../mailTemplates/index.js';
import '../outboundRoutes/index.js';
import '../parking/index.js';
import '../trunks/index.js';
import '../users/index.js';
import './index.js';

process.env.SECRETBOX_KEY ??= `1:${Buffer.alloc(32, 7).toString('base64')}`;
process.env.ORIGIN ??= 'https://pbx.example.test';

const owner: Actor = { id: 'owner', name: 'Owner', role: 'owner' };

function asRun(overrides: Partial<RunInput> = {}): RunInput {
  return {
    actor: owner,
    channel: 'rest',
    requestId: 'req-1',
    confirm: true,
    ...overrides
  };
}

/** Seeds the tenant `settings` singleton, required by extension assignment. */
async function seedTenant(db: Db): Promise<void> {
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
      mainDidId: didId
    })
    .execute();
}

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
  await runOperation(db, 'audit.undo', { id }, asRun());
}

async function createTrunk(db: Db, name: string): Promise<string> {
  const { trunk } = await runOperation<unknown, { trunk: { id: string } }>(
    db,
    'trunks.create',
    {
      name,
      emergency: true,
      authMode: 'ip',
      hosts: [{ host: 'sip.provider.example' }]
    },
    asRun()
  );
  return trunk.id;
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
    const trunkId = await createTrunk(db, 'Provider A');
    const before = await runOperation<unknown, Routes>(
      db,
      'outboundRoutes.list',
      {},
      asRun()
    );
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
      asRun()
    );

    await undoLatest(db, 'outboundRoutes.replace');

    const after = await runOperation<unknown, Routes>(
      db,
      'outboundRoutes.list',
      {},
      asRun()
    );
    expect(after.items).toEqual(before.items);
  });

  it('restores the trunk order', async () => {
    const db = await makeTestDb();
    const first = await createTrunk(db, 'Provider A');
    const second = await createTrunk(db, 'Provider B');
    await runOperation(
      db,
      'trunks.setOrder',
      { trunkIds: [second, first] },
      asRun()
    );

    await undoLatest(db, 'trunks.setOrder');

    expect(await liveTrunkOrder(db)).toEqual([first, second]);
  });

  it('refuses to restore a trunk order once another trunk exists, naming it', async () => {
    const db = await makeTestDb();
    const first = await createTrunk(db, 'Provider A');
    const second = await createTrunk(db, 'Provider B');
    await runOperation(
      db,
      'trunks.setOrder',
      { trunkIds: [second, first] },
      asRun()
    );
    const third = await createTrunk(db, 'Provider C');
    const id = await latestEntry(db, 'trunks.setOrder');

    await expect(
      runOperation(db, 'audit.undo', { id }, asRun())
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
    await seedTenant(db);
    await runOperation(db, 'parking.set', { slots: ['701'] }, asRun());
    const { user } = await runOperation<unknown, { user: { id: string } }>(
      db,
      'users.create',
      { name: 'Anna', email: 'anna@x.test', extension: '101' },
      asRun()
    );
    const { device } = await runOperation<unknown, { device: { id: string } }>(
      db,
      'devices.create',
      { userId: user.id, label: 'App', kind: 'ringotel' },
      asRun()
    );
    await runOperation(
      db,
      'devices.setBlf',
      { id: device.id, keys: ['701'] },
      asRun()
    );
    await runOperation(db, 'parking.set', { slots: [] }, asRun());

    await undoLatest(db, 'parking.set');

    const slots = await runOperation<unknown, { slots: string[] }>(
      db,
      'parking.get',
      {},
      asRun()
    );
    expect(slots.slots).toEqual(['701']);
    const blf = await runOperation<unknown, { keys: string[] }>(
      db,
      'devices.getBlf',
      { id: device.id },
      asRun()
    );
    expect(blf.keys).toEqual(['701']);
  });

  it('takes a mail-template override back to the one before, then to none', async () => {
    const db = await makeTestDb();
    const key = { kind: 'reset', language: 'en' };
    const first = { subject: 'First', bodyText: 'Reset: {{link}}' };
    await runOperation(db, 'mailTemplates.put', { ...key, ...first }, asRun());
    await runOperation(
      db,
      'mailTemplates.put',
      { ...key, subject: 'Second', bodyText: 'Again: {{link}}' },
      asRun()
    );

    await undoLatest(db, 'mailTemplates.put');
    const restored = await runOperation<unknown, { source: string }>(
      db,
      'mailTemplates.get',
      key,
      asRun()
    );
    expect(restored).toMatchObject({ ...first, source: 'tenant' });

    // The live first `put` created the override: its undo removes it.
    const firstPut = await db
      .selectFrom('auditLog')
      .select('id')
      .where('operation', '=', 'mailTemplates.put')
      .where('undoneAt', 'is', null)
      .executeTakeFirstOrThrow();
    await runOperation(db, 'audit.undo', { id: firstPut.id }, asRun());
    const builtin = await runOperation<unknown, { source: string }>(
      db,
      'mailTemplates.get',
      key,
      asRun()
    );
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
      asRun()
    );
    await runOperation(db, 'mailTemplates.delete', key, asRun());

    await undoLatest(db, 'mailTemplates.delete');

    const read = await runOperation<unknown, { source: string }>(
      db,
      'mailTemplates.get',
      key,
      asRun()
    );
    expect(read).toMatchObject({ ...override, source: 'tenant' });
  });
});
