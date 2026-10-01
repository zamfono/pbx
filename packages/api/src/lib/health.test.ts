import { describe, expect, it } from 'vitest';

import { nowIso, openDb, type Db } from '@zamfono/shared';

import { apiHealth, type ApiHealth } from './health.js';
import { makeTestDb } from './testDb.js';

/** `apiHealth` over `db`, with core reachable and the job-fed fields fixed. */
async function healthOf(db: Db): Promise<ApiHealth> {
  return apiHealth({
    db,
    checkCore: () => Promise.resolve({ reachable: true, ari: true }),
    keyRotationRemaining: 0,
    certificateSync: 'ok'
  });
}

async function seedTrunk(
  db: Db,
  id: string,
  priority: number,
  emergency: 0 | 1,
  deletedAt: string | null = null
): Promise<void> {
  await db
    .insertInto('trunks')
    .values({
      id,
      name: id,
      priority,
      emergency,
      authMode: 'ip',
      createdAt: nowIso(),
      deletedAt
    })
    .execute();
}

describe('apiHealth update fields (§6.3 "Updates", §10.3 Health row)', () => {
  it('carries the breaking release and the failed automatic update from update_state', async () => {
    const db = await makeTestDb();
    await expect(healthOf(db)).resolves.toMatchObject({
      breakingUpdateAvailable: null,
      autoUpdateFailed: null
    });

    await db
      .updateTable('updateState')
      .set({
        breakingVersion: '0.2.0',
        autoFailedVersion: '0.1.2',
        autoFailure: 'the backup failed',
        autoFailedAt: nowIso()
      })
      .execute();
    await expect(healthOf(db)).resolves.toMatchObject({
      breakingUpdateAvailable: '0.2.0',
      autoUpdateFailed: '0.1.2'
    });
  });

  it('reports neither on an unmigrated database instead of throwing', async () => {
    await expect(healthOf(openDb(':memory:'))).resolves.toMatchObject({
      breakingUpdateAvailable: null,
      autoUpdateFailed: null
    });
  });
});

describe('apiHealth emergencyTrunk (§9.4 "Emergency trunks", §10.3 Health row)', () => {
  it('is false with no trunk at all', async () => {
    const db = await makeTestDb();
    expect((await healthOf(db)).emergencyTrunk).toBe(false);
  });

  it('is false while only unflagged or deleted flagged trunks exist', async () => {
    const db = await makeTestDb();
    await seedTrunk(db, 'foreign', 1, 0);
    await seedTrunk(db, 'gone', 2, 1, nowIso());
    expect((await healthOf(db)).emergencyTrunk).toBe(false);
  });

  it('is true once a live trunk is flagged', async () => {
    const db = await makeTestDb();
    await seedTrunk(db, 'foreign', 1, 0);
    await seedTrunk(db, 'local', 2, 1);
    expect((await healthOf(db)).emergencyTrunk).toBe(true);
  });

  it('is false on an unmigrated database instead of throwing', async () => {
    const db = openDb(':memory:');
    expect((await healthOf(db)).emergencyTrunk).toBe(false);
  });
});
