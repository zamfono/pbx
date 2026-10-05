import { describe, expect, it } from 'vitest';

import type { Db } from '@zamfono/shared';
import { seedSettings } from '@zamfono/shared/testDb.js';

import { asConfirmedRun, asRun, makeTestDb } from '#testing/testDb.js';

import { runOperation } from '../runner.js';
import { type Actor } from '../types.js';

import '../audit/index.js';
import './index.js';

const admin: Actor = { id: 'admin-1', name: 'Admin', role: 'admin' };
const HUNDRED_YEARS_S = 3_153_600_000;

async function seededDb(): Promise<Db> {
  const db = await makeTestDb();
  await seedSettings(db);
  return db;
}

const update = (db: Db, patch: Record<string, unknown>): Promise<unknown> =>
  runOperation(db, 'settings.update', patch, asRun({ actor: admin }));

describe('settings: SIP bans (§5.6, §11.4)', () => {
  it('reads the five SIP ban settings with their defaults', async () => {
    const db = await seededDb();
    await expect(
      runOperation(db, 'settings.get', {}, asRun())
    ).resolves.toMatchObject({
      sipBanFailures: 10,
      sipBanWindowS: 3600,
      sipBanSuccessExemptS: 86_400,
      sipBanLookbackS: 2_592_000,
      sipBanSteps: [86_400, 31_536_000, null]
    });
  });

  it.each([
    [[]],
    [[60]],
    [[null]],
    [[60, 61, HUNDRED_YEARS_S, null]],
    [[86_400, 31_536_000]]
  ])('lets an admin set the steps %j', async sipBanSteps => {
    const db = await seededDb();
    await expect(update(db, { sipBanSteps })).resolves.toMatchObject({
      sipBanSteps
    });
  });

  it.each([
    [[59]],
    [[HUNDRED_YEARS_S + 1]],
    [[60.5]],
    [[3600, 3600]],
    [[86_400, 3600]],
    [[null, 86_400]],
    [[86_400, null, null]],
    ['[86400]'],
    [{ 0: 86_400 }]
  ])('refuses the steps %j with 422', async sipBanSteps => {
    const db = await seededDb();
    await expect(update(db, { sipBanSteps })).rejects.toMatchObject({
      status: 422
    });
  });

  it.each([
    ['sipBanFailures', 1, 0],
    ['sipBanWindowS', 1, 0],
    ['sipBanWindowS', HUNDRED_YEARS_S, HUNDRED_YEARS_S + 1],
    ['sipBanSuccessExemptS', 0, -1],
    ['sipBanSuccessExemptS', HUNDRED_YEARS_S, HUNDRED_YEARS_S + 1],
    ['sipBanLookbackS', 1, 0],
    ['sipBanLookbackS', HUNDRED_YEARS_S, HUNDRED_YEARS_S + 1]
  ])('takes %s = %d and refuses %d with 422', async (field, ok, refused) => {
    const db = await seededDb();
    await expect(update(db, { [field]: ok })).resolves.toMatchObject({
      [field]: ok
    });
    await expect(update(db, { [field]: refused })).rejects.toMatchObject({
      status: 422
    });
  });

  it('audits a change and undoes it', async () => {
    const db = await seededDb();
    await update(db, { sipBanSteps: [3600, null], sipBanFailures: 5 });
    const entry = await db
      .selectFrom('auditLog')
      .select(['id', 'changesJson'])
      .where('operation', '=', 'settings.update')
      .executeTakeFirstOrThrow();
    expect(JSON.parse(entry.changesJson)).toEqual(
      expect.arrayContaining([
        { field: 'sipBanFailures', from: 10, to: 5 },
        {
          field: 'sipBanSteps',
          from: [86_400, 31_536_000, null],
          to: [3600, null]
        }
      ])
    );
    await runOperation(db, 'audit.undo', { id: entry.id }, asConfirmedRun());
    await expect(
      runOperation(db, 'settings.get', {}, asRun())
    ).resolves.toMatchObject({
      sipBanFailures: 10,
      sipBanSteps: [86_400, 31_536_000, null]
    });
  });
});
