import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { newId, nowIso, type Db } from '@zamfono/shared';

import { makeTestDb } from '../../testDb.js';
import type { HoursWire } from '../hours/get.js';
import { runOperation, type RunInput } from '../runner.js';
import { type Actor } from '../types.js';
import { refuseUniqueViolation } from './_uniqueViolation.js';

import '../devices/index.js';
import '../hours/index.js';
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

function undo(db: Db, id: string): Promise<unknown> {
  return runOperation(db, 'audit.undo', { id }, asRun());
}

async function createTrunk(db: Db, name: string): Promise<string> {
  const { trunk } = await runOperation<unknown, { trunk: { id: string } }>(
    db,
    'trunks.create',
    { name, authMode: 'ip', hosts: [{ host: 'sip.provider.example' }] },
    asRun()
  );
  return trunk.id;
}

async function createUser(db: Db, email: string, ext: string): Promise<string> {
  const { user } = await runOperation<unknown, { user: { id: string } }>(
    db,
    'users.create',
    { name: 'Anna Huber', email, extension: ext },
    asRun()
  );
  return user.id;
}

async function createDevice(
  db: Db,
  userId: string,
  label: string,
  kind: 'manual' | 'ringotel'
): Promise<{ id: string; sipUsername: string }> {
  const { device } = await runOperation<
    unknown,
    { device: { id: string; sipUsername: string } }
  >(db, 'devices.create', { userId, label, kind }, asRun());
  return device;
}

async function setHours(db: Db, scope: unknown): Promise<string> {
  const hours = await runOperation<unknown, HoursWire>(
    db,
    'hours.set',
    {
      scope,
      closedTarget: { kind: 'external', external: '+491234567' },
      intervals: [{ weekday: 1, opens: '09:00', closes: '17:00' }]
    },
    asRun()
  );
  return hours.id;
}

describe('audit.undo refuses a revival that would break a uniqueness rule (§5.8)', () => {
  it("names the trunk created since on the deleted trunk's priority", async () => {
    const db = await makeTestDb();
    await createTrunk(db, 'Provider A');
    const second = await createTrunk(db, 'Provider B');
    await runOperation(db, 'trunks.delete', { id: second }, asRun());
    const deletion = await latestEntry(db, 'trunks.delete');
    const third = await createTrunk(db, 'Provider C');

    await expect(undo(db, deletion)).rejects.toMatchObject({
      status: 409,
      references: [{ kind: 'trunk', id: third, label: 'Provider C' }]
    });
  });

  it("names the trunk a reorder moved onto the deleted trunk's priority", async () => {
    const db = await makeTestDb();
    const first = await createTrunk(db, 'Provider A');
    const second = await createTrunk(db, 'Provider B');
    const third = await createTrunk(db, 'Provider C');
    await runOperation(db, 'trunks.delete', { id: second }, asRun());
    const deletion = await latestEntry(db, 'trunks.delete');
    await runOperation(
      db,
      'trunks.setOrder',
      { trunkIds: [third, first] },
      asRun()
    );

    await expect(undo(db, deletion)).rejects.toMatchObject({
      status: 409,
      references: [{ kind: 'trunk', id: first, label: 'Provider A' }]
    });
  });

  it('names the tenant schedule set since the deleted one', async () => {
    const db = await makeTestDb();
    await setHours(db, { kind: 'tenant' });
    await runOperation(
      db,
      'hours.delete',
      { scope: { kind: 'tenant' } },
      asRun()
    );
    const deletion = await latestEntry(db, 'hours.delete');
    const newer = await setHours(db, { kind: 'tenant' });

    await expect(undo(db, deletion)).rejects.toMatchObject({
      status: 409,
      references: [{ kind: 'openingHours', id: newer }]
    });
  });

  it("names the user's schedule set since the deleted one", async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    const userId = await createUser(db, 'anna@x.test', '101');
    const scope = { kind: 'user', id: userId };
    await setHours(db, scope);
    await runOperation(db, 'hours.delete', { scope }, asRun());
    const deletion = await latestEntry(db, 'hours.delete');
    const newer = await setHours(db, scope);

    await expect(undo(db, deletion)).rejects.toMatchObject({
      status: 409,
      references: [{ kind: 'openingHours', id: newer }]
    });
  });

  it("names the user's Ringotel device created since the deleted one", async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    const userId = await createUser(db, 'anna@x.test', '101');
    const old = await createDevice(db, userId, 'App', 'ringotel');
    await runOperation(db, 'devices.delete', { id: old.id }, asRun());
    const deletion = await latestEntry(db, 'devices.delete');
    const newer = await createDevice(db, userId, 'New App', 'ringotel');

    await expect(undo(db, deletion)).rejects.toMatchObject({
      status: 409,
      references: [{ kind: 'device', id: newer.id, label: 'New App' }]
    });
  });

  it("names the live device holding a revived user's device's SIP username", async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    const userId = await createUser(db, 'anna@x.test', '101');
    const device = await createDevice(db, userId, 'Desk', 'manual');
    await runOperation(db, 'users.delete', { id: userId }, asRun());
    const deletion = await latestEntry(db, 'users.delete');
    const otherUser = await createUser(db, 'bea@x.test', '102');
    const taker = newId();
    await db
      .insertInto('devices')
      .values({
        id: taker,
        userId: otherUser,
        label: 'Taker',
        kind: 'manual',
        sipUsername: device.sipUsername,
        sipPasswordEnc: Buffer.from('x'),
        createdAt: nowIso()
      })
      .execute();

    await expect(undo(db, deletion)).rejects.toMatchObject({
      status: 409,
      references: [{ kind: 'device', id: taker, label: 'Taker' }]
    });
  });
});

describe('refuseUniqueViolation', () => {
  it('answers a uniqueness violation the reuse checks missed with a 409', async () => {
    const raw = new Database(':memory:');
    raw.exec('create table t (v text unique); insert into t values (1)');

    await expect(
      refuseUniqueViolation(() => {
        raw.exec('insert into t values (1)');
        return Promise.resolve();
      })
    ).rejects.toMatchObject({ status: 409 });
  });

  it('passes any other error through', async () => {
    const failure = new Error('boom');

    await expect(
      refuseUniqueViolation(() => Promise.reject(failure))
    ).rejects.toBe(failure);
  });
});
