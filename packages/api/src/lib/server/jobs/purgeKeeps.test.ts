import { describe, expect, it, vi } from 'vitest';

import { MS_PER_DAY, nowIso } from '@zamfono/shared';
import { seedSettings } from '@zamfono/shared/testDb.js';

import { makeTestDb } from '#testing/testDb.js';

import { runPurge } from './purge.js';
import { checkAsteriskRestart } from './ringotelRereg.js';

// What the daily purge (§5.7, §11.6) must leave for the jobs that read the same history: the
// re-registration's memory of the last registration (§10.4).

const RETENTION_DAYS = 30;

function daysAgo(days: number): string {
  return new Date(Date.now() - days * MS_PER_DAY).toISOString();
}

describe('runPurge against the history other jobs read', () => {
  it('sends no second re-registration for the same Asterisk after audit retention purged the first entry', async () => {
    const db = await makeTestDb();
    await seedSettings(db, { auditRetentionDays: RETENTION_DAYS });
    const asteriskStartedAt = daysAgo(RETENTION_DAYS + 10);
    const onPbxRestarted = vi.fn(() => Promise.resolve());
    const deps = {
      db,
      lookup: () =>
        Promise.resolve({
          version: 'dev',
          revision: '',
          display: 'dev',
          startedAt: asteriskStartedAt,
          asteriskStartedAt
        }),
      provider: () =>
        Promise.resolve({
          onDeviceCreated: () => Promise.resolve(null),
          onDeviceDeleted: () => Promise.resolve(),
          onCredentialsRotated: () => Promise.resolve(null),
          onPbxRestarted
        })
    };
    await checkAsteriskRestart(deps, { lastSeen: null });
    // The re-registration happened shortly after that start, as long ago.
    await db
      .updateTable('auditLog')
      .set({ createdAt: daysAgo(RETENTION_DAYS + 9) })
      .execute();
    await db
      .updateTable('settings')
      .set({ ringotelRegisteredAt: daysAgo(RETENTION_DAYS + 9) })
      .execute();

    await runPurge(db, nowIso());
    // An `api` restart: nothing in memory.
    await checkAsteriskRestart(deps, { lastSeen: null });

    expect(onPbxRestarted).toHaveBeenCalledOnce();
  });
});
