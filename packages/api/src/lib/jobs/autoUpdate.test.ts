import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';

import { MS_PER_DAY, newId, nowIso, type Db } from '@zamfono/shared';

import type { UpdateMailRequest } from '../mail/send.js';
import type { BackupRunRow } from '../ops/backups/_shared.js';
import {
  AUTO_UPDATE_RETRY_GAP_MS,
  loadUpdateState,
  MAX_AUTO_UPDATE_ATTEMPTS
} from '../ops/system/_state.js';
import {
  setUpdaterClient,
  UpdaterRefusal,
  type RunRequester,
  type UpdaterClient,
  type UpdaterStatus,
  type UpdateState
} from '../ops/system/_updater.js';
import { makeTestDb } from '../testDb.js';
import { runAutoUpdatePass, type AutoUpdateDeps } from './autoUpdate.js';
import {
  createMaintenanceGate,
  IDLE_RECHECK_MS,
  type GateCheck,
  type MaintenanceGate
} from './maintenanceWindow.js';

const STATUS_CONFLICT = 409;
const STARTED_AT = '2026-10-01T03:00:00.000Z';
const NOW = new Date('2026-10-01T03:00:00.000Z');
const TOMORROW = new Date('2026-10-02T03:00:00.000Z');

/** The settings row with `auto_update` as given, and a second owner and an admin beside the
 * test database's own owner `owner`. */
async function seed(db: Db, autoUpdate: boolean): Promise<void> {
  await sql`PRAGMA foreign_keys = OFF`.execute(db);
  await db
    .insertInto('settings')
    .values({
      id: 1,
      companyName: 'Test Co',
      country: 'DE',
      emergencyNumbersJson: '["112"]',
      mainDidId: 'did-1',
      autoUpdate: autoUpdate ? 1 : 0
    })
    .execute();
  for (const [id, role] of [
    ['o2', 'owner'],
    ['a1', 'admin']
  ] as const) {
    // eslint-disable-next-line no-await-in-loop -- two fixture rows, inserted in order
    await db
      .insertInto('users')
      .values({
        id,
        name: id,
        email: `${id}@x`,
        role,
        passwordHash: 'x',
        createdAt: nowIso()
      })
      .execute();
  }
}

function status(overrides: Partial<UpdaterStatus> = {}): UpdaterStatus {
  return {
    current: '0.1.1',
    latest: {
      version: '0.1.2',
      url: 'https://example/releases/v0.1.2',
      publishedAt: '2026-09-30T12:00:00Z'
    },
    updatable: true,
    breaking: false,
    last: { state: 'idle' },
    ...overrides
  };
}

type Harness = {
  deps: AutoUpdateDeps;
  mails: UpdateMailRequest[];
  asked: { version: string | undefined; requester?: RunRequester }[];
  backups: { count: number };
  gateChecks: { count: number };
  current: { status: UpdaterStatus; gate: GateCheck; backupOk: boolean };
  updaterAnswer: { next: () => Promise<UpdateState> };
};

function harness(db: Db): Harness {
  const mails: UpdateMailRequest[] = [];
  const asked: Harness['asked'] = [];
  const backups = { count: 0 };
  const gateChecks = { count: 0 };
  const current: Harness['current'] = {
    status: status(),
    gate: { open: true },
    backupOk: true
  };
  const updaterAnswer: Harness['updaterAnswer'] = {
    next: () =>
      Promise.resolve({
        state: 'running',
        from: '0.1.1',
        to: '0.1.2',
        startedAt: STARTED_AT
      })
  };
  const client: UpdaterClient = {
    status: () => Promise.resolve(current.status),
    update: async (version, requester) => {
      asked.push({ version, requester });
      return updaterAnswer.next();
    }
  };
  setUpdaterClient(() => client);
  const gate: MaintenanceGate = {
    check: () => {
      gateChecks.count += 1;
      return Promise.resolve(current.gate);
    },
    reset: () => undefined
  };
  const backUp = async (): Promise<BackupRunRow[]> => {
    backups.count += 1;
    const run: BackupRunRow = {
      id: newId(),
      targetId: 't1',
      status: current.backupOk ? 'ok' : 'failed',
      snapshotId: current.backupOk ? 'snap' : null,
      bytesAdded: null,
      bytesTotal: null,
      error: current.backupOk ? null : 'no space left on device',
      startedAt: nowIso(),
      finishedAt: nowIso()
    };
    await db.insertInto('backupRuns').values(run).execute();
    return [run];
  };
  return {
    deps: {
      db,
      backUp,
      gate,
      updater: () => client,
      send: req => {
        mails.push(req);
        return Promise.resolve('sent');
      },
      now: () => NOW
    },
    mails,
    asked,
    backups,
    gateChecks,
    current,
    updaterAnswer
  };
}

async function auditOutcomes(db: Db): Promise<unknown[]> {
  const rows = await db
    .selectFrom('auditLog')
    .select(['operation', 'channel', 'actorUserId', 'changesJson'])
    .where('operation', '=', 'system.autoUpdate')
    .orderBy('id')
    .execute();
  return rows.map(row => {
    const changes = JSON.parse(row.changesJson) as {
      field: string;
      to: unknown;
    }[];
    return {
      channel: row.channel,
      actor: row.actorUserId,
      ...Object.fromEntries(changes.map(change => [change.field, change.to]))
    };
  });
}

describe('runAutoUpdatePass', () => {
  it('leaves the stack alone while auto_update is off', async () => {
    const db = await makeTestDb();
    await seed(db, false);
    const { deps, asked, backups, gateChecks } = harness(db);

    await expect(runAutoUpdatePass(deps)).resolves.toBeNull();
    expect(gateChecks.count).toBe(0);
    expect(backups.count).toBe(0);
    expect(asked).toEqual([]);
  });

  it('waits for the gate, then backs up and asks the updater as system.update does', async () => {
    const db = await makeTestDb();
    await seed(db, true);
    const job = harness(db);
    const nextCheckAt = TOMORROW;
    job.current.gate = { open: false, nextCheckAt };

    await expect(runAutoUpdatePass(job.deps)).resolves.toEqual(nextCheckAt);
    expect(job.backups.count).toBe(0);

    job.current.gate = { open: true };
    await runAutoUpdatePass(job.deps);
    expect(job.backups.count).toBe(1);
    expect(job.asked).toEqual([
      { version: '0.1.2', requester: { trigger: 'automatic', by: 'Zamfono' } }
    ]);
    expect(await loadUpdateState(db)).toMatchObject({
      runTrigger: 'automatic',
      runStartedAt: STARTED_AT,
      runOutcomePending: 1
    });
    expect(await auditOutcomes(db)).toEqual([
      {
        channel: 'job',
        actor: 'system',
        outcome: 'started',
        from: '0.1.1',
        to: '0.1.2'
      }
    ]);
  });

  it('follows the run up after the restart: running, then failed, entered once', async () => {
    const db = await makeTestDb();
    await seed(db, true);
    const job = harness(db);
    await runAutoUpdatePass(job.deps);
    const run = { from: '0.1.1', to: '0.1.2', startedAt: STARTED_AT };
    job.current.status = status({ last: { state: 'running', ...run } });

    const soon = await runAutoUpdatePass(job.deps);
    expect(soon?.getTime()).toBeGreaterThan(NOW.getTime());
    expect(job.mails).toEqual([]);

    job.current.status = status({
      last: {
        state: 'failed',
        ...run,
        finishedAt: '2026-10-01T03:05:00.000Z',
        error: 'the recreated services did not report healthy'
      }
    });
    job.current.gate = { open: false, nextCheckAt: TOMORROW };
    await runAutoUpdatePass(job.deps);
    await runAutoUpdatePass(job.deps);

    // The first of the release's attempts: no mail yet, and the retry waits for the gate.
    expect(job.mails).toEqual([]);
    expect(await loadUpdateState(db)).toMatchObject({
      runOutcomePending: 0,
      autoFailedVersion: '0.1.2',
      autoFailure: 'the recreated services did not report healthy',
      autoFailedAttempts: 1
    });
    expect(job.asked).toHaveLength(1);
    expect((await auditOutcomes(db)).map(entry => entry)).toMatchObject([
      { outcome: 'started' },
      { outcome: 'failed', to: '0.1.2' }
    ]);
  });

  it('ends a recorded failure with an update that succeeded after it', async () => {
    const db = await makeTestDb();
    await seed(db, true);
    const job = harness(db);
    job.current.backupOk = false;
    await runAutoUpdatePass(job.deps);
    expect((await loadUpdateState(db))?.autoFailedVersion).toBe('0.1.2');

    job.current.status = status({
      current: '0.1.2',
      latest: null,
      updatable: false,
      last: {
        state: 'succeeded',
        from: '0.1.1',
        to: '0.1.2',
        trigger: 'manual',
        by: 'owner',
        startedAt: '2099-01-01T00:00:00.000Z',
        finishedAt: '2099-01-01T00:04:00.000Z'
      }
    });
    await runAutoUpdatePass(job.deps);
    expect((await loadUpdateState(db))?.autoFailedVersion).toBeNull();
  });

  it('aborts on a failed backup without asking the updater, and reports it', async () => {
    const db = await makeTestDb();
    await seed(db, true);
    const job = harness(db);
    job.current.backupOk = false;

    await runAutoUpdatePass(job.deps);

    expect(job.asked).toEqual([]);
    expect(job.mails).toEqual([]);
    const row = await loadUpdateState(db);
    expect(row?.autoFailure).toContain('no space left on device');
    expect(row?.autoFailedAttempts).toBe(1);
    expect(await auditOutcomes(db)).toMatchObject([
      { outcome: 'backupFailed', to: '0.1.2' }
    ]);
  });

  it("reports the updater's refusal as a failed attempt", async () => {
    const db = await makeTestDb();
    await seed(db, true);
    const job = harness(db);
    job.updaterAnswer.next = () =>
      Promise.reject(
        new UpdaterRefusal(
          STATUS_CONFLICT,
          'the stack directory pins no release; update it once with update.sh on the host'
        )
      );

    await runAutoUpdatePass(job.deps);

    expect(await loadUpdateState(db)).toMatchObject({
      autoFailure: expect.stringContaining('pins no release') as unknown,
      autoFailedAttempts: 1
    });
    expect(await auditOutcomes(db)).toMatchObject([{ outcome: 'refused' }]);
  });

  it('counts no attempt when refused because another update runs, and tries again after it', async () => {
    const db = await makeTestDb();
    await seed(db, true);
    const job = harness(db);
    const byHand: UpdateState = {
      state: 'running',
      from: '0.1.1',
      to: '0.1.2',
      trigger: 'host',
      startedAt: STARTED_AT
    };
    job.updaterAnswer.next = () => {
      // update.sh on the host began between the job's look and its request.
      job.current.status = status({ last: byHand });
      return Promise.reject(
        new UpdaterRefusal(STATUS_CONFLICT, 'an update is already running')
      );
    };

    await runAutoUpdatePass(job.deps);
    expect(await loadUpdateState(db)).toMatchObject({
      autoFailedVersion: null,
      autoFailedAttempts: 0
    });
    expect(job.mails).toEqual([]);
    expect(await auditOutcomes(db)).toMatchObject([
      {
        outcome: 'refused',
        reason: 'system.update: an update is already running'
      }
    ]);

    // While it runs nothing is asked; once it ended without reaching 0.1.2, the job asks again.
    await runAutoUpdatePass(job.deps);
    expect(job.asked).toHaveLength(1);
    job.current.status = status({
      last: {
        ...byHand,
        state: 'failed',
        finishedAt: '2026-10-01T03:04:00.000Z'
      }
    });
    job.updaterAnswer.next = () =>
      Promise.resolve({ ...byHand, trigger: 'automatic' });
    await runAutoUpdatePass(job.deps);
    expect(job.asked).toHaveLength(2);
  });

  it('tries a failed release again at the next maintenance moment, not before', async () => {
    const db = await makeTestDb();
    await seed(db, true);
    await db
      .updateTable('settings')
      .set({ timezone: 'UTC', tlsReloadHour: 3 })
      .execute();
    const job = harness(db);
    const clock = { now: new Date('2026-10-01T02:59:00.000Z') };
    job.deps.now = () => clock.now;
    job.deps.gate = createMaintenanceGate({
      db,
      isIdle: () => Promise.resolve(true)
    });
    job.current.backupOk = false;

    await expect(runAutoUpdatePass(job.deps)).resolves.toEqual(NOW);
    clock.now = NOW;
    await runAutoUpdatePass(job.deps);
    expect(job.backups.count).toBe(1);

    // Held off for the gap; the hourly poll past it finds the next moment.
    clock.now = new Date('2026-10-01T03:05:00.000Z');
    await expect(runAutoUpdatePass(job.deps)).resolves.toBeNull();
    clock.now = new Date('2026-10-01T23:30:00.000Z');
    await expect(runAutoUpdatePass(job.deps)).resolves.toEqual(TOMORROW);
    expect(job.backups.count).toBe(1);

    clock.now = TOMORROW;
    await runAutoUpdatePass(job.deps);
    expect(job.backups.count).toBe(2);
    expect((await loadUpdateState(db))?.autoFailedAttempts).toBe(2);
  });

  it('waits the retry gap after a failed attempt even where the gate is always open', async () => {
    const db = await makeTestDb();
    await seed(db, true);
    const job = harness(db);
    const clock = { now: NOW };
    job.deps.now = () => clock.now;
    job.current.backupOk = false;

    await runAutoUpdatePass(job.deps);
    const justShort = AUTO_UPDATE_RETRY_GAP_MS - 1;
    for (const afterMs of [IDLE_RECHECK_MS, justShort]) {
      clock.now = new Date(NOW.getTime() + afterMs);
      // eslint-disable-next-line no-await-in-loop -- passes run one after the other, as the job's do
      await runAutoUpdatePass(job.deps);
    }
    expect(job.backups.count).toBe(1);

    clock.now = new Date(NOW.getTime() + AUTO_UPDATE_RETRY_GAP_MS);
    await runAutoUpdatePass(job.deps);
    expect(job.backups.count).toBe(2);
  });

  it(`gives a release ${MAX_AUTO_UPDATE_ATTEMPTS} attempts, mails once the last failed, then tries a newer one`, async () => {
    const db = await makeTestDb();
    await seed(db, true);
    const job = harness(db);
    const clock = { now: NOW };
    job.deps.now = () => clock.now;
    const nextDay = (): void => {
      clock.now = new Date(clock.now.getTime() + MS_PER_DAY);
    };
    job.current.backupOk = false;

    for (let pass = 1; pass < MAX_AUTO_UPDATE_ATTEMPTS; pass += 1) {
      // eslint-disable-next-line no-await-in-loop -- passes run one after the other, as the job's do
      await runAutoUpdatePass(job.deps);
      nextDay();
    }
    expect(job.mails).toEqual([]);
    expect(await loadUpdateState(db)).toMatchObject({
      autoFailedVersion: '0.1.2',
      autoFailedAttempts: MAX_AUTO_UPDATE_ATTEMPTS - 1
    });

    await runAutoUpdatePass(job.deps);
    nextDay();
    expect(job.mails.map(mail => [mail.kind, mail.to.userId])).toEqual([
      ['updateFailed', 'owner'],
      ['updateFailed', 'o2']
    ]);
    expect(job.mails[0]?.values).toMatchObject({
      fromVersion: '0.1.1',
      toVersion: '0.1.2',
      reason: 'the backup to target t1 failed: no space left on device'
    });

    // Given up on 0.1.2: the gate is not even asked.
    const checks = job.gateChecks.count;
    await runAutoUpdatePass(job.deps);
    expect(job.backups.count).toBe(MAX_AUTO_UPDATE_ATTEMPTS);
    expect(job.gateChecks.count).toBe(checks);
    expect(job.mails).toHaveLength(2);

    // A newer release starts its own count; the failure stays reported meanwhile.
    job.current.status = status({
      latest: {
        version: '0.1.3',
        url: 'https://example/releases/v0.1.3',
        publishedAt: '2026-10-01T12:00:00Z'
      }
    });
    await runAutoUpdatePass(job.deps);
    expect(job.backups.count).toBe(MAX_AUTO_UPDATE_ATTEMPTS + 1);
    expect(await loadUpdateState(db)).toMatchObject({
      autoFailedVersion: '0.1.3',
      autoFailedAttempts: 1
    });
    expect(
      (await auditOutcomes(db)).filter(
        entry => (entry as { outcome: string }).outcome === 'backupFailed'
      )
    ).toHaveLength(MAX_AUTO_UPDATE_ATTEMPTS + 1);
  });

  it('announces a breaking release once, whether or not auto_update is on', async () => {
    const db = await makeTestDb();
    await seed(db, false);
    const job = harness(db);
    job.current.status = status({
      latest: {
        version: '0.2.0',
        url: 'https://example/releases/v0.2.0',
        publishedAt: '2026-09-30T12:00:00Z'
      },
      updatable: false,
      breaking: true
    });

    await runAutoUpdatePass(job.deps);
    await runAutoUpdatePass(job.deps);

    expect(job.mails.map(mail => [mail.kind, mail.to.userId])).toEqual([
      ['breakingUpdate', 'owner'],
      ['breakingUpdate', 'o2']
    ]);
    expect(job.mails[0]?.values).toMatchObject({
      currentVersion: '0.1.1',
      version: '0.2.0',
      releaseUrl: 'https://example/releases/v0.2.0'
    });
    expect(await loadUpdateState(db)).toMatchObject({
      breakingVersion: '0.2.0',
      breakingAnnounced: '0.2.0'
    });

    // A failed lookup says nothing; once installed by hand, none is pending any more.
    job.current.status = status({ latest: null, latestError: 'timeout' });
    await runAutoUpdatePass(job.deps);
    expect((await loadUpdateState(db))?.breakingVersion).toBe('0.2.0');
    job.current.status = status({
      current: '0.2.0',
      latest: null,
      updatable: false
    });
    await runAutoUpdatePass(job.deps);
    expect(await loadUpdateState(db)).toMatchObject({
      breakingVersion: null,
      breakingAnnounced: '0.2.0'
    });
    expect(job.mails).toHaveLength(2);
  });
});
