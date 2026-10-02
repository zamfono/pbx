import process from 'node:process';
import { sql } from 'kysely';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getCoreClient } from '#lib/server/coreClient.js';
import { stubCoreClient } from '#lib/server/coreClientStub.js';
import { makeTestDb } from '#lib/server/testDb.js';

import { runOperation, type RunInput } from '../runner.js';

import '../index.js';

import { updaterClient } from './_updater.js';

vi.mock('./_updater.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./_updater.js')>()),
  updaterClient: vi.fn()
}));

// The lowest role: every signed-in user may read what the stack runs.
const asUser: RunInput = {
  actor: { id: 'u1', name: 'User', role: 'user' },
  channel: 'mcp',
  requestId: 'req-1'
};
const CORE = {
  version: '0.0.4',
  revision: 'abc1234ffff',
  display: '0.0.4 (abc1234)',
  startedAt: '2026-09-29T08:00:05.000Z',
  asteriskStartedAt: '2026-09-29T08:00:00.000Z'
};
const STARTED_AT = expect.any(String) as unknown;

const NO_UPDATER = {
  unavailable:
    'UPDATER_TOKEN is not set in .env; updates run only by update.sh on the host'
};

afterEach(() => {
  vi.mocked(getCoreClient).mockReset();
  vi.mocked(updaterClient).mockReset();
  delete process.env.ZAMFONO_VERSION;
  delete process.env.ZAMFONO_REVISION;
  delete process.env.FQDN;
  delete process.env.STACK_IPV4;
  delete process.env.EXTERNAL_IPV4;
});

describe('system.info', () => {
  it("reports api's version and the one core reports, each on its own", async () => {
    process.env.ZAMFONO_VERSION = '0.0.5';
    process.env.ZAMFONO_REVISION = '79c1041aaaaaaa';
    vi.mocked(getCoreClient).mockReturnValue(
      stubCoreClient({ version: () => Promise.resolve(CORE) })
    );

    expect(
      await runOperation(await makeTestDb(), 'system.info', {}, asUser)
    ).toEqual({
      api: {
        version: '0.0.5',
        revision: '79c1041aaaaaaa',
        display: '0.0.5 (79c1041)',
        startedAt: STARTED_AT
      },
      core: CORE,
      update: NO_UPDATER,
      autoUpdate: { enabled: false, failed: null },
      maintenanceGate: { certSync: null, autoUpdate: null },
      ringotel: { profilePending: false },
      stack: { domain: null, ipv4: null }
    });
  });

  it("dates api's start to this process's own, so a restart is visible", async () => {
    const out = await runOperation<unknown, { api: { startedAt: string } }>(
      await makeTestDb(),
      'system.info',
      {},
      asUser
    );

    const startedMs = Date.parse(out.api.startedAt);
    expect(startedMs).toBeLessThanOrEqual(Date.now());
    expect(startedMs).toBeGreaterThan(
      Date.now() - (process.uptime() + 1) * 1000
    );
  });

  it('reports core as null while core does not answer', async () => {
    vi.mocked(getCoreClient).mockReturnValue(
      stubCoreClient({
        version: () => Promise.reject(new Error('connect ECONNREFUSED'))
      })
    );

    expect(
      await runOperation(await makeTestDb(), 'system.info', {}, asUser)
    ).toEqual({
      api: {
        version: 'dev',
        revision: '',
        display: 'dev',
        startedAt: STARTED_AT
      },
      core: null,
      update: NO_UPDATER,
      autoUpdate: { enabled: false, failed: null },
      maintenanceGate: { certSync: null, autoUpdate: null },
      ringotel: { profilePending: false },
      stack: { domain: null, ipv4: null }
    });
  });

  it('passes on what the updater reports, or why it could not', async () => {
    const status = {
      current: '0.0.6',
      latest: { version: '0.0.7', url: 'https://example', publishedAt: '' },
      updatable: true,
      breaking: false,
      last: { state: 'idle' as const }
    };
    vi.mocked(updaterClient).mockImplementation(() => ({
      status: () => Promise.resolve(status),
      update: () => Promise.reject(new Error('unused'))
    }));
    const db = await makeTestDb();
    expect(await runOperation(db, 'system.info', {}, asUser)).toMatchObject({
      update: status
    });

    vi.mocked(updaterClient).mockImplementation(() => ({
      status: () => Promise.reject(new Error('connect ECONNREFUSED')),
      update: () => Promise.reject(new Error('unused'))
    }));
    expect(await runOperation(db, 'system.info', {}, asUser)).toMatchObject({
      update: {
        unavailable: 'the updater did not answer: connect ECONNREFUSED'
      }
    });
  });

  it('names who asked for the last run: the record, else the run api started (§6.3)', async () => {
    const db = await makeTestDb();
    const last = {
      state: 'succeeded' as const,
      from: '0.1.0',
      to: '0.1.1',
      startedAt: '2026-10-01T03:00:00.000Z',
      finishedAt: '2026-10-01T03:04:00.000Z'
    };
    const reporting = (state: typeof last & { trigger?: 'host' }) => () => ({
      status: () =>
        Promise.resolve({
          current: '0.1.1',
          latest: null,
          updatable: false,
          breaking: false,
          last: state
        }),
      update: () => Promise.reject(new Error('unused'))
    });
    vi.mocked(updaterClient).mockImplementation(
      reporting({ ...last, trigger: 'host' })
    );
    expect(await runOperation(db, 'system.info', {}, asUser)).toMatchObject({
      update: { last: { trigger: 'host' } }
    });

    // An updater that keeps no trigger: the run api started, as update_state recorded it.
    await db
      .updateTable('updateState')
      .set({
        runTrigger: 'automatic',
        runActorName: 'Zamfono',
        runStartedAt: last.startedAt
      })
      .execute();
    vi.mocked(updaterClient).mockImplementation(reporting(last));
    expect(await runOperation(db, 'system.info', {}, asUser)).toMatchObject({
      update: { last: { ...last, trigger: 'automatic', by: 'Zamfono' } }
    });
  });

  it('reports whether automatic updates are on, why the last one failed and how often (§6.3)', async () => {
    const db = await makeTestDb();
    await sql`PRAGMA foreign_keys = OFF`.execute(db);
    await db
      .insertInto('settings')
      .values({
        id: 1,
        companyName: 'Test Co',
        country: 'DE',
        emergencyNumbersJson: '["112"]',
        mainDidId: 'did-1',
        autoUpdate: 1
      })
      .execute();
    const failed = {
      version: '0.1.2',
      reason: 'the backup to target t1 failed: no space left',
      at: '2026-10-01T03:01:00.000Z',
      attempts: 2
    };
    await db
      .updateTable('updateState')
      .set({
        autoFailedVersion: failed.version,
        autoFailure: failed.reason,
        autoFailedAt: failed.at,
        autoFailedAttempts: failed.attempts
      })
      .execute();

    // Without an updater there are no automatic updates, so no failure to show; the record stays.
    expect(await runOperation(db, 'system.info', {}, asUser)).toMatchObject({
      autoUpdate: { enabled: true, failed: null }
    });
    vi.mocked(updaterClient).mockImplementation(() => ({
      status: () => Promise.reject(new Error('not answering')),
      update: () => Promise.reject(new Error('not asked'))
    }));
    expect(await runOperation(db, 'system.info', {}, asUser)).toMatchObject({
      autoUpdate: { enabled: true, failed }
    });
  });

  it('reports when and why the maintenance gate last gave up on each work (§6.4)', async () => {
    const db = await makeTestDb();
    await db
      .insertInto('maintenanceGate')
      .values({
        work: 'certSync',
        gaveUpAt: '2026-10-01T05:00:00.000Z',
        reason: 'live calls 1, Asterisk channels 2, recordings in progress 0',
        consecutiveGiveUps: 1
      })
      .execute();

    expect(await runOperation(db, 'system.info', {}, asUser)).toMatchObject({
      maintenanceGate: {
        certSync: {
          at: '2026-10-01T05:00:00.000Z',
          reason: 'live calls 1, Asterisk channels 2, recordings in progress 0'
        },
        autoUpdate: null
      }
    });
  });

  it('reports a tenant profile change that has not reached Ringotel yet (§10.4)', async () => {
    const db = await makeTestDb();
    await sql`PRAGMA foreign_keys = OFF`.execute(db);
    await db
      .insertInto('settings')
      .values({
        id: 1,
        companyName: 'Test Co',
        country: 'DE',
        emergencyNumbersJson: '["112"]',
        mainDidId: 'did-1',
        ringotelProfilePending: 1
      })
      .execute();

    expect(await runOperation(db, 'system.info', {}, asUser)).toMatchObject({
      ringotel: { profilePending: true }
    });
  });

  it("reports the stack's domain and the IPv4 address SIP and media use (§6.1)", async () => {
    const db = await makeTestDb();
    process.env.FQDN = 'pbx.example.com';
    process.env.STACK_IPV4 = '203.0.113.34';
    process.env.EXTERNAL_IPV4 = '';
    expect(await runOperation(db, 'system.info', {}, asUser)).toMatchObject({
      stack: { domain: 'pbx.example.com', ipv4: '203.0.113.34' }
    });

    process.env.STACK_IPV4 = '';
    process.env.EXTERNAL_IPV4 = '198.51.100.7';
    expect(await runOperation(db, 'system.info', {}, asUser)).toMatchObject({
      stack: { domain: 'pbx.example.com', ipv4: '198.51.100.7' }
    });
  });
});
