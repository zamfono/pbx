import { describe, expect, it } from 'vitest';

import { newId, nowIso, type Db, type Envelope } from '@zamfono/shared';
import { migratedTestDb, seedSettings } from '@zamfono/shared/testDb.js';

import { testKeyring } from '#testing/fixtures.js';

import { sealTargetSecret } from '../ops/backups/_secret.js';
import { type Keyring } from '../secretbox.js';
import type { Bus } from './backup.js';
import type { ExecFn } from './backupBackends.js';
import { queueRun, scheduleBackups } from './cron.js';

const SNAPSHOT_BYTES = 4321;
const READ_INTERVAL_MS = 5;
const WAIT_MS = 200;

async function insertTarget(db: Db, kr: Keyring): Promise<string> {
  const id = newId();
  await db
    .insertInto('backupTargets')
    .values({
      id,
      kind: 'local',
      paramsJson: JSON.stringify({ path: '/backups/restic' }),
      enabled: 0,
      secretEnc: sealTargetSecret(kr, { resticPassword: 'restic-pw' }),
      createdAt: nowIso()
    })
    .execute();
  return id;
}

/**
 * A manual run as `backups.runs.start` commits it, a `running` row; `handOver` also hands it to
 * the scheduler, as the operation does once the row has committed.
 */
async function insertRun(
  db: Db,
  targetId: string,
  startedAt: string,
  handOver = true
): Promise<string> {
  const run = {
    id: newId(),
    targetId,
    status: 'running' as const,
    snapshotId: null,
    bytesAdded: null,
    bytesTotal: null,
    error: null,
    startedAt,
    finishedAt: null
  };
  await db.insertInto('backupRuns').values(run).execute();
  if (handOver) {
    expect(queueRun(run)).toBe(true);
  }
  return run.id;
}

function resticBackupOutput(snapshotId: string): string {
  return JSON.stringify({
    message_type: 'summary',
    snapshot_id: snapshotId,
    data_added: SNAPSHOT_BYTES
  });
}

function fakeExec(snapshotId: string): ExecFn {
  return (_file, args) =>
    Promise.resolve({
      stdout: args[0] === 'backup' ? resticBackupOutput(snapshotId) : '',
      stderr: ''
    });
}

function fakeBus(): { bus: Bus; published: Envelope[] } {
  const published: Envelope[] = [];
  return {
    published,
    bus: {
      publish: ev => {
        published.push(ev);
      },
      enqueue: () => Promise.resolve()
    }
  };
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

/** Resolves once `backup_runs.status` of `runId` leaves `running`, or after `WAIT_MS`. */
async function waitForRun(db: Db, runId: string): Promise<string> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- polling the row the scheduler updates
    const row = await db
      .selectFrom('backupRuns')
      .select(['status'])
      .where('id', '=', runId)
      .executeTakeFirstOrThrow();
    if (row.status !== 'running' || Date.now() > deadline) {
      return row.status;
    }
    // eslint-disable-next-line no-await-in-loop -- one interval between reads
    await wait(READ_INTERVAL_MS);
  }
}

describe('scheduleBackups: the manual runs handed over', () => {
  it('executes a run backups.runs.start hands over', async () => {
    const db = await migratedTestDb();
    await seedSettings(db);
    const kr = testKeyring();
    const targetId = await insertTarget(db, kr);
    const { bus, published } = fakeBus();
    const scheduler = scheduleBackups(db, kr, {
      exec: fakeExec('snap-queued'),
      mediaDir: '/media',
      bus
    });
    const runId = await insertRun(db, targetId, nowIso());

    const status = await waitForRun(db, runId);
    scheduler.stop();

    expect(status).toBe('ok');
    const row = await db
      .selectFrom('backupRuns')
      .selectAll()
      .where('id', '=', runId)
      .executeTakeFirstOrThrow();
    expect(row.snapshotId).toBe('snap-queued');
    expect(row.bytesAdded).toBe(SNAPSHOT_BYTES);
    expect(published.map(ev => ev.type)).toEqual([
      'backup.started',
      'backup.finished'
    ]);
  });

  it('fails a queued run whose target has been deleted', async () => {
    const db = await migratedTestDb();
    await seedSettings(db);
    const kr = testKeyring();
    const targetId = await insertTarget(db, kr);
    await db
      .updateTable('backupTargets')
      .set({ deletedAt: nowIso() })
      .where('id', '=', targetId)
      .execute();
    const { bus } = fakeBus();
    const scheduler = scheduleBackups(db, kr, {
      exec: fakeExec('snap-gone'),
      mediaDir: '/media',
      bus
    });
    const runId = await insertRun(db, targetId, nowIso());

    const status = await waitForRun(db, runId);
    scheduler.stop();

    expect(status).toBe('failed');
    const row = await db
      .selectFrom('backupRuns')
      .select('error')
      .where('id', '=', runId)
      .executeTakeFirstOrThrow();
    expect(row.error).toContain('not found');
  });

  it('runs a handed-over run once', async () => {
    const db = await migratedTestDb();
    await seedSettings(db);
    const kr = testKeyring();
    const targetId = await insertTarget(db, kr);
    const { bus, published } = fakeBus();
    const scheduler = scheduleBackups(db, kr, {
      exec: fakeExec('snap-once'),
      mediaDir: '/media',
      bus
    });
    const runId = await insertRun(db, targetId, nowIso());
    await waitForRun(db, runId);

    await wait(WAIT_MS);
    scheduler.stop();

    const started = published.filter(ev => ev.type === 'backup.started');
    expect(started).toHaveLength(1);
  });

  it('leaves a run an earlier process left behind to the boot sweep', async () => {
    const db = await migratedTestDb();
    await seedSettings(db);
    const kr = testKeyring();
    const targetId = await insertTarget(db, kr);
    const staleRunId = await insertRun(
      db,
      targetId,
      new Date(Date.now() - WAIT_MS).toISOString(),
      false
    );
    const { bus, published } = fakeBus();
    const scheduler = scheduleBackups(db, kr, {
      exec: fakeExec('snap-stale'),
      mediaDir: '/media',
      bus
    });

    const status = await waitForRun(db, staleRunId);
    scheduler.stop();

    expect(status).toBe('failed');
    const row = await db
      .selectFrom('backupRuns')
      .select('error')
      .where('id', '=', staleRunId)
      .executeTakeFirstOrThrow();
    expect(row.error).toBe('interrupted');
    expect(published).toHaveLength(0);
  });

  it('takes no run once stopped, and none without a scheduler', async () => {
    const db = await migratedTestDb();
    await seedSettings(db);
    const kr = testKeyring();
    const targetId = await insertTarget(db, kr);
    const { bus } = fakeBus();
    const scheduler = scheduleBackups(db, kr, {
      exec: fakeExec('snap-stopped'),
      mediaDir: '/media',
      bus
    });
    scheduler.stop();
    const runId = await insertRun(db, targetId, nowIso(), false);

    expect(
      queueRun({
        id: runId,
        targetId,
        status: 'running',
        snapshotId: null,
        bytesAdded: null,
        bytesTotal: null,
        error: null,
        startedAt: nowIso(),
        finishedAt: null
      })
    ).toBe(false);
  });
});
