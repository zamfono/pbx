import { describe, expect, it } from 'vitest';

import type { Db } from '@zamfono/shared';
import { seedSettings } from '@zamfono/shared/testDb.js';

import { asConfirmedRun, asRun, makeTestDb } from '#testing/testDb.js';

import { runOperation } from '../runner.js';
import { type Actor } from '../types.js';

import '../audit/index.js';
import './index.js';

const owner: Actor = { id: 'owner-1', name: 'Owner', role: 'owner' };
const admin: Actor = { id: 'admin-1', name: 'Admin', role: 'admin' };

async function seededDb(): Promise<Db> {
  const db = await makeTestDb();
  await seedSettings(db);
  return db;
}

const update = (
  db: Db,
  patch: Record<string, unknown>,
  actor: Actor = owner
): Promise<unknown> =>
  runOperation(db, 'settings.update', patch, asRun({ actor }));

describe('settings: smtpCheckIntervalS (§10.2 "Relay check", §11.4)', () => {
  it('reads 900 by default', async () => {
    const db = await seededDb();
    await expect(
      runOperation(db, 'settings.get', {}, asRun())
    ).resolves.toMatchObject({ smtpCheckIntervalS: 900 });
  });

  it.each([[60], [86_400], [null]])(
    'lets the owner set %j',
    async smtpCheckIntervalS => {
      const db = await seededDb();
      await expect(update(db, { smtpCheckIntervalS })).resolves.toMatchObject({
        smtpCheckIntervalS
      });
    }
  );

  it.each([[59], [86_401], [60.5], ['900']])(
    'refuses %j with 422',
    async smtpCheckIntervalS => {
      const db = await seededDb();
      await expect(update(db, { smtpCheckIntervalS })).rejects.toMatchObject({
        status: 422
      });
    }
  );

  it('refuses an admin with 403', async () => {
    const db = await seededDb();
    await expect(
      update(db, { smtpCheckIntervalS: 60 }, admin)
    ).rejects.toMatchObject({ status: 403 });
  });

  it('audits a change and undoes it', async () => {
    const db = await seededDb();
    await update(db, { smtpCheckIntervalS: null });
    const entry = await db
      .selectFrom('auditLog')
      .select(['id', 'changesJson'])
      .where('operation', '=', 'settings.update')
      .executeTakeFirstOrThrow();
    expect(JSON.parse(entry.changesJson)).toEqual([
      { field: 'smtpCheckIntervalS', from: 900, to: null }
    ]);
    await runOperation(db, 'audit.undo', { id: entry.id }, asConfirmedRun());
    await expect(
      runOperation(db, 'settings.get', {}, asRun())
    ).resolves.toMatchObject({ smtpCheckIntervalS: 900 });
  });
});
