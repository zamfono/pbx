import { sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';

import { nowIso, openDb, type Db } from '@zamfono/shared';

import { apiHealth, type ApiHealth } from './health.js';
import { updateNews } from './ops/system/_state.js';
import { setUpdaterClient, type UpdaterClient } from './ops/system/_updater.js';
import { keyringFromEnv } from './secretbox.js';
import { makeTestDb } from './testDb.js';

/** An updater `apiHealth` only needs to be configured: it never asks it anything. */
const UNUSED_UPDATER: UpdaterClient = {
  status: () => Promise.reject(new Error('not asked')),
  update: () => Promise.reject(new Error('not asked'))
};

const kr = keyringFromEnv({
  SECRETBOX_KEY: `1:${Buffer.alloc(32, 7).toString('base64')}`
});

/** `apiHealth` over `db`, with core reachable and the job-fed fields fixed. */
async function healthOf(db: Db): Promise<ApiHealth> {
  return apiHealth({
    db,
    checkCore: () => Promise.resolve({ reachable: true, ari: true }),
    keyring: kr,
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

describe('apiHealth update fields (§6.3 "Automatic updates", §10.3 Health row)', () => {
  afterEach(() => {
    setUpdaterClient(undefined);
  });

  it('says whether an automatic update failed, and nothing of releases', async () => {
    setUpdaterClient(() => UNUSED_UPDATER);
    const db = await makeTestDb();
    await expect(healthOf(db)).resolves.toMatchObject({
      autoUpdateFailed: false
    });

    await db
      .updateTable('updateState')
      .set({
        breakingVersion: '0.2.0',
        autoFailedVersion: '0.1.2',
        autoFailure: 'the backup failed',
        autoFailedAt: nowIso(),
        autoFailedAttempts: 1
      })
      .execute();
    const health = await healthOf(db);
    expect(health).toMatchObject({ autoUpdateFailed: true });
    expect(health).not.toHaveProperty('breakingUpdateAvailable');
    expect(JSON.stringify(health)).not.toMatch(/0\.1\.2|0\.2\.0/u);
  });

  it('reports no failure without an updater, whatever update_state stores, and keeps the record', async () => {
    setUpdaterClient(() => undefined);
    const db = await makeTestDb();
    await db
      .updateTable('updateState')
      .set({
        breakingVersion: '0.2.0',
        breakingAnnounced: '0.2.0',
        autoFailedVersion: '0.1.2',
        autoFailure: 'the backup failed',
        autoFailedAt: nowIso(),
        autoFailedAttempts: 1
      })
      .execute();
    await expect(healthOf(db)).resolves.toMatchObject({
      autoUpdateFailed: false
    });

    // The token back, and nothing succeeded since: it reappears.
    setUpdaterClient(() => UNUSED_UPDATER);
    await expect(healthOf(db)).resolves.toMatchObject({
      autoUpdateFailed: true
    });
  });

  it('reports no failure on an unmigrated database instead of throwing', async () => {
    await expect(healthOf(openDb(':memory:'))).resolves.toMatchObject({
      autoUpdateFailed: false
    });
  });

  it('rejects a read of update_state that fails, rather than reporting no failure', async () => {
    setUpdaterClient(() => UNUSED_UPDATER);
    await expect(updateNews(openDb(':memory:'))).rejects.toThrow();
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

  it('rejects when the query fails on a migrated database', async () => {
    const db = await makeTestDb();
    await sql`ALTER TABLE trunks RENAME TO trunks_gone`.execute(db);
    await expect(healthOf(db)).rejects.toThrow(/trunks/u);
  });
});
