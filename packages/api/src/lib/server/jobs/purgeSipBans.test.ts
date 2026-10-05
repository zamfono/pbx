import { describe, expect, it } from 'vitest';

import { MS_PER_DAY, nowIso } from '@zamfono/shared';
import { seedSettings } from '@zamfono/shared/testDb.js';

import { makeTestDb } from '#testing/testDb.js';

import { runPurge } from './purge.js';

function daysAgo(days: number): string {
  return new Date(Date.now() - days * MS_PER_DAY).toISOString();
}

describe('runPurge: SIP bans (§5.6, §5.9)', () => {
  it('deletes a ban that ended longer ago than the lookback, never an active one, a permanent one included', async () => {
    const db = await makeTestDb();
    // A lookback of 10 days.
    await seedSettings(db, { sipBanLookbackS: 864_000 });
    const ban = { address: '203.0.113.7', step: 1, failures: 10 };
    await db
      .insertInto('sipBans')
      .values([
        {
          ...ban,
          id: 'expired-old',
          createdAt: daysAgo(12),
          expiresAt: daysAgo(11)
        },
        {
          ...ban,
          id: 'expired-recent',
          createdAt: daysAgo(12),
          expiresAt: daysAgo(9)
        },
        {
          ...ban,
          id: 'lifted-old',
          createdAt: daysAgo(400),
          liftedAt: daysAgo(11),
          liftedBy: 'owner'
        },
        {
          ...ban,
          id: 'lifted-recent',
          createdAt: daysAgo(400),
          liftedAt: daysAgo(9),
          liftedBy: 'owner'
        },
        { ...ban, id: 'permanent', createdAt: daysAgo(400) }
      ])
      .execute();

    await runPurge(db, nowIso());

    const left = await db
      .selectFrom('sipBans')
      .select('id')
      .orderBy('id')
      .execute();
    expect(left.map(row => row.id)).toEqual([
      'expired-recent',
      'lifted-recent',
      'permanent'
    ]);
  });

  it('deletes an allowlist entry once its soft delete passed the retention', async () => {
    const db = await makeTestDb();
    await seedSettings(db, { softDeleteRetentionDays: 30 });
    await db
      .insertInto('sipAllowlist')
      .values([
        {
          id: 'old',
          address: '198.51.100.1',
          createdAt: daysAgo(40),
          deletedAt: daysAgo(31)
        },
        { id: 'live', address: '198.51.100.2', createdAt: daysAgo(40) }
      ])
      .execute();

    await runPurge(db, nowIso());

    expect(await db.selectFrom('sipAllowlist').select('id').execute()).toEqual([
      { id: 'live' }
    ]);
  });
});
