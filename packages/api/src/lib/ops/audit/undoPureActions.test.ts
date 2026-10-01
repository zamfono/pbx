import { describe, expect, it } from 'vitest';

import { newId, nowIso, type Db } from '@zamfono/shared';

import { makeTestDb } from '#lib/testDb.js';

import type { MailTemplateWire } from '../mailTemplates/_shared.js';
import { runOperation, type RunInput } from '../runner.js';
import { type Actor } from '../types.js';

import '../devices/index.js';
import '../mailTemplates/index.js';
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

/** Seeds the tenant `settings` singleton, required by extension assignment and test sends. */
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

async function undo(db: Db, id: string): Promise<void> {
  await runOperation(db, 'audit.undo', { id }, asRun());
}

const RESET_EN = { kind: 'reset', language: 'en' } as const;

async function putResetTemplate(db: Db, subject: string): Promise<void> {
  await runOperation(
    db,
    'mailTemplates.put',
    { ...RESET_EN, subject, bodyText: 'Use {{link}}.', bodyHtml: null },
    asRun()
  );
}

/** A user with one device, and the device's label changed once: the entry the tests undo. */
async function relabelledDevice(db: Db): Promise<string> {
  const { user } = await runOperation<unknown, { user: { id: string } }>(
    db,
    'users.create',
    { name: 'Anna Huber', email: 'anna@x.test', extension: '101' },
    asRun()
  );
  const { device } = await runOperation<unknown, { device: { id: string } }>(
    db,
    'devices.create',
    { userId: user.id, label: 'Desk phone', kind: 'manual' },
    asRun()
  );
  await runOperation(
    db,
    'devices.update',
    { id: device.id, label: 'Reception' },
    asRun()
  );
  return device.id;
}

async function deviceLabel(db: Db, id: string): Promise<string | null> {
  const row = await db
    .selectFrom('devices')
    .select('label')
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
  return row.label;
}

describe('audit.undo past pure actions (§5.8)', () => {
  it('undoes a template put that a later test send followed', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    await putResetTemplate(db, 'Reset your password');
    const put = await latestEntry(db, 'mailTemplates.put');
    await runOperation(db, 'mailTemplates.test', { kind: 'reset' }, asRun());

    await undo(db, put);

    const read = await runOperation<unknown, MailTemplateWire>(
      db,
      'mailTemplates.get',
      RESET_EN,
      asRun()
    );
    expect(read.source).toBe('builtin');
  });

  it('still refuses behind a later put, naming it and not the test send', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    await putResetTemplate(db, 'First');
    const first = await latestEntry(db, 'mailTemplates.put');
    await runOperation(db, 'mailTemplates.test', { kind: 'reset' }, asRun());
    await putResetTemplate(db, 'Second');
    const second = await latestEntry(db, 'mailTemplates.put');

    await expect(undo(db, first)).rejects.toMatchObject({
      status: 409,
      detail: { references: [{ kind: 'auditLog', id: second }] }
    });
  });

  it('undoes a device change that a later credential reveal followed', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    const deviceId = await relabelledDevice(db);
    const update = await latestEntry(db, 'devices.update');
    await runOperation(
      db,
      'devices.revealCredentials',
      { id: deviceId },
      asRun()
    );

    await undo(db, update);

    expect(await deviceLabel(db, deviceId)).toBe('Desk phone');
  });

  it('undoes a user change that a later password-reset mail followed', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    const { user } = await runOperation<unknown, { user: { id: string } }>(
      db,
      'users.create',
      { name: 'Anna Huber', email: 'anna@x.test', extension: '101' },
      asRun()
    );
    await runOperation(
      db,
      'users.update',
      { id: user.id, name: 'Anna Berger' },
      asRun()
    );
    const update = await latestEntry(db, 'users.update');
    await runOperation(db, 'users.resetPassword', { id: user.id }, asRun());

    await undo(db, update);

    const row = await db
      .selectFrom('users')
      .select('name')
      .where('id', '=', user.id)
      .executeTakeFirstOrThrow();
    expect(row.name).toBe('Anna Huber');
  });

  it('still refuses behind a later secret rotation, a non-undoable change', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    const deviceId = await relabelledDevice(db);
    const update = await latestEntry(db, 'devices.update');
    await runOperation(db, 'devices.rotate', { id: deviceId }, asRun());
    const rotate = await latestEntry(db, 'devices.rotate');

    await expect(undo(db, update)).rejects.toMatchObject({
      status: 409,
      detail: { references: [{ kind: 'auditLog', id: rotate }] }
    });
    expect(await deviceLabel(db, deviceId)).toBe('Reception');
  });
});
