import { sql } from 'kysely';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  healthHttpStatus,
  HTTP_OK,
  HTTP_SERVICE_UNAVAILABLE,
  nowIso,
  openDb,
  type Db,
  type HealthChecks,
  type HealthDocument,
  type HealthStatus
} from '@zamfono/shared';
import { MIGRATIONS_DIR, seedSettings } from '@zamfono/shared/testDb.js';

import { makeTestDb } from '#testing/testDb.js';

import { apiHealth, type ApiHealthDeps } from './health.js';
import { updateNews } from './ops/system/_state.js';
import { updaterClient, type UpdaterClient } from './ops/system/_updater.js';
import { keyringFromEnv } from './secretbox.js';

vi.mock('./ops/system/_updater.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./ops/system/_updater.js')>()),
  updaterClient: vi.fn()
}));

/** An updater `apiHealth` only needs to be configured: it never asks it anything. */
const UNUSED_UPDATER: UpdaterClient = {
  status: () => Promise.reject(new Error('not asked')),
  update: () => Promise.reject(new Error('not asked'))
};

const kr = keyringFromEnv({
  SECRETBOX_KEY: `1:${Buffer.alloc(32, 7).toString('base64')}`
});

const CORE_PASSING: HealthChecks = {
  'core:database': [{ status: 'pass' }],
  'core:ari': [{ status: 'pass' }]
};

/** `apiHealth` over `db`, with core and the job-fed checks passing unless `deps` says otherwise. */
async function healthOf(
  db: Db,
  deps: Partial<ApiHealthDeps> = {}
): Promise<HealthDocument> {
  return apiHealth({
    db,
    migrationsDir: MIGRATIONS_DIR,
    coreChecks: () => Promise.resolve(CORE_PASSING),
    keyring: kr,
    certificateSync: { state: 'ok', at: '2026-10-05T12:00:00.000Z' },
    sipBanHelper: { running: true, heartbeat: '2026-10-05T12:00:00Z' },
    ...deps
  });
}

/** The status of `key`'s check in `document`, `undefined` while it holds none. */
function statusOf(
  document: HealthDocument,
  key: string
): HealthStatus | undefined {
  return document.checks[key]?.[0].status;
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

describe('apiHealth (§6.3 "Health", §10.3 "Health")', () => {
  it('passes with every check passing, in the order §10.3 lists them', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    await seedTrunk(db, 'local', 1, 1);
    const health = await healthOf(db);
    expect(health).toStrictEqual({
      status: 'pass',
      checks: {
        'database:status': [{ status: 'pass' }],
        'core:reachable': [{ status: 'pass' }],
        ...CORE_PASSING,
        'certificate:sync': [
          {
            status: 'pass',
            observedValue: 'ok',
            time: '2026-10-05T12:00:00.000Z'
          }
        ],
        'sipBan:helper': [{ status: 'pass', time: '2026-10-05T12:00:00Z' }],
        'trunks:emergency': [{ status: 'pass' }],
        'secrets:keyRotation': [{ status: 'pass', observedValue: 0 }],
        'config:propagation': [{ status: 'pass' }],
        'ringotel:profile': [{ status: 'pass' }],
        'ringotel:roster': [{ status: 'pass' }],
        'update:automatic': [{ status: 'pass' }]
      }
    });
    expect(Object.keys(health.checks)).toEqual([
      'database:status',
      'core:reachable',
      'core:database',
      'core:ari',
      'certificate:sync',
      'sipBan:helper',
      'trunks:emergency',
      'secrets:keyRotation',
      'config:propagation',
      'ringotel:profile',
      'ringotel:roster',
      'update:automatic'
    ]);
    expect(healthHttpStatus(health)).toBe(HTTP_OK);
  });

  it('fails with only database:status and the core and job checks while a migration is pending', async () => {
    const health = await healthOf(openDb(':memory:'), {
      coreChecks: () => Promise.resolve(null),
      certificateSync: { state: 'unknown', at: null },
      sipBanHelper: { running: false, heartbeat: null }
    });
    expect(health).toStrictEqual({
      status: 'fail',
      checks: {
        'database:status': [{ status: 'fail', output: 'migrationPending' }],
        'core:reachable': [{ status: 'fail' }],
        'certificate:sync': [{ status: 'warn', observedValue: 'unknown' }],
        'sipBan:helper': [{ status: 'fail' }]
      }
    });
    expect(healthHttpStatus(health)).toBe(HTTP_SERVICE_UNAVAILABLE);
  });

  it("copies only core's own core:* checks, a failing one failing the document", async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    await seedTrunk(db, 'local', 1, 1);
    const health = await healthOf(db, {
      coreChecks: () =>
        Promise.resolve({
          'core:database': [{ status: 'pass' }],
          'core:ari': [{ status: 'fail' }],
          'database:status': [{ status: 'pass', output: 'core' }]
        })
    });
    expect(health.status).toBe('fail');
    expect(health.checks['core:ari']).toEqual([{ status: 'fail' }]);
    expect(health.checks['database:status']).toEqual([{ status: 'pass' }]);
  });

  it.each([
    ['ok', 'pass'],
    ['unknown', 'warn'],
    ['pending', 'warn'],
    ['expiring', 'warn'],
    ['missing', 'fail'],
    ['failed', 'fail'],
    ['expired', 'fail']
  ] as const)(
    'maps the certificate sync state %s to %s',
    async (state, status) => {
      const db = await makeTestDb();
      await seedSettings(db);
      const health = await healthOf(db, {
        certificateSync: { state, at: null }
      });
      expect(statusOf(health, 'certificate:sync')).toBe(status);
    }
  );

  it('warns, answering 200, while only a warning check is not passing', async () => {
    const db = await makeTestDb();
    await seedSettings(db, { configPropagationPending: 1 });
    await seedTrunk(db, 'local', 1, 1);
    const health = await healthOf(db);
    expect(health.status).toBe('warn');
    expect(statusOf(health, 'config:propagation')).toBe('warn');
    expect(healthHttpStatus(health)).toBe(HTTP_OK);
  });

  it('fails sipBan:helper with its stale heartbeat as time while the helper does not run', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const health = await healthOf(db, {
      sipBanHelper: { running: false, heartbeat: '2026-10-05T11:00:00Z' }
    });
    expect(health.checks['sipBan:helper']).toEqual([
      { status: 'fail', time: '2026-10-05T11:00:00Z' }
    ]);
  });
});

describe('apiHealth update:automatic (§6.3 "Automatic updates", §10.3 "Health")', () => {
  afterEach(() => {
    vi.mocked(updaterClient).mockReset();
  });

  it('says whether an automatic update failed, and nothing of releases', async () => {
    vi.mocked(updaterClient).mockImplementation(() => UNUSED_UPDATER);
    const db = await makeTestDb();
    await seedSettings(db);
    expect(statusOf(await healthOf(db), 'update:automatic')).toBe('pass');

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
    expect(statusOf(health, 'update:automatic')).toBe('warn');
    expect(JSON.stringify(health)).not.toMatch(/0\.1\.2|0\.2\.0|backup/u);
  });

  it('reports no failure without an updater, whatever update_state stores, and keeps the record', async () => {
    vi.mocked(updaterClient).mockImplementation(() => undefined);
    const db = await makeTestDb();
    await seedSettings(db);
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
    expect(statusOf(await healthOf(db), 'update:automatic')).toBe('pass');

    // The token back, and nothing succeeded since: it reappears.
    vi.mocked(updaterClient).mockImplementation(() => UNUSED_UPDATER);
    expect(statusOf(await healthOf(db), 'update:automatic')).toBe('warn');
  });

  it('rejects a read of update_state that fails, rather than reporting no failure', async () => {
    vi.mocked(updaterClient).mockImplementation(() => UNUSED_UPDATER);
    await expect(updateNews(openDb(':memory:'))).rejects.toThrow();
  });
});

describe('apiHealth trunks:emergency (§9.4 "Emergency trunks", §10.3 "Health")', () => {
  it('fails with no trunk at all', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    expect(statusOf(await healthOf(db), 'trunks:emergency')).toBe('fail');
  });

  it('fails while only unflagged or deleted flagged trunks exist', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    await seedTrunk(db, 'foreign', 1, 0);
    await seedTrunk(db, 'gone', 2, 1, nowIso());
    expect(statusOf(await healthOf(db), 'trunks:emergency')).toBe('fail');
  });

  it('passes once a live trunk is flagged', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    await seedTrunk(db, 'foreign', 1, 0);
    await seedTrunk(db, 'local', 2, 1);
    expect(statusOf(await healthOf(db), 'trunks:emergency')).toBe('pass');
  });

  it('rejects when the query fails on a migrated database', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    await sql`ALTER TABLE trunks RENAME TO trunks_gone`.execute(db);
    await expect(healthOf(db)).rejects.toThrow(/trunks/u);
  });
});

describe('apiHealth Ringotel markers (§10.4, §10.3 "Health")', () => {
  it('warns ringotel:roster while a roster push is pending', async () => {
    const db = await makeTestDb();
    await seedSettings(db, { ringotelRosterPending: 1 });
    const health = await healthOf(db);
    expect(statusOf(health, 'ringotel:profile')).toBe('pass');
    expect(statusOf(health, 'ringotel:roster')).toBe('warn');
  });
});
