import { describe, expect, it, vi } from 'vitest';

import { MS_PER_DAY, nowIso } from '@zamfono/shared';
import { seedSettings } from '@zamfono/shared/testDb.js';

import { makeTestDb } from '#testing/testDb.js';

import { runPurge } from './purge.js';
import { checkAsteriskRestart } from './ringotelRereg.js';

// What the daily purge (§5.7, §11.6) must leave for the jobs that read the same history: the
// re-registration's memory of the last registration (§10.4) and each backup target's latest
// successful run, which `/metrics` reports the age of (§7).

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

  it("keeps each backup target's latest successful run past retention, for its age in /metrics", async () => {
    const db = await makeTestDb();
    await seedSettings(db, { recordingRetentionDays: RETENTION_DAYS });
    for (const id of ['quiet', 'busy']) {
      // eslint-disable-next-line no-await-in-loop -- two rows, the runs below reference them
      await db
        .insertInto('backupTargets')
        .values({
          id,
          kind: 'local',
          paramsJson: '{}',
          secretEnc: Buffer.from(''),
          createdAt: daysAgo(100)
        })
        .execute();
    }
    const runs = [
      { id: 'quiet-old-ok', targetId: 'quiet', status: 'ok', age: 50 },
      { id: 'quiet-last-ok', targetId: 'quiet', status: 'ok', age: 40 },
      { id: 'quiet-failed', targetId: 'quiet', status: 'failed', age: 35 },
      { id: 'busy-old-ok', targetId: 'busy', status: 'ok', age: 40 },
      { id: 'busy-last-ok', targetId: 'busy', status: 'ok', age: 1 }
    ] as const;
    await db
      .insertInto('backupRuns')
      .values(
        runs.map(({ id, targetId, status, age }) => ({
          id,
          targetId,
          status,
          startedAt: daysAgo(age),
          finishedAt: daysAgo(age)
        }))
      )
      .execute();

    await runPurge(db, nowIso());

    const kept = await db
      .selectFrom('backupRuns')
      .select('id')
      .orderBy('id')
      .execute();
    expect(kept.map(row => row.id)).toEqual(['busy-last-ok', 'quiet-last-ok']);
  });
});
