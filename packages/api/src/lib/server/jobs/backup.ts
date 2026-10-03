/**
 * Restic backups per target (§6.5): a `VACUUM INTO` snapshot backed up with `media/` to a
 * `backup_targets` row, with `backup_runs` history fanned out as `backup.*` events. The restic
 * repository string and backend env per target kind live in `backupBackends.ts`, the summary
 * parsing and retention pruning in `backupRestic.ts`.
 */
import { mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { sql } from 'kysely';

import {
  MS_PER_SECOND,
  newId,
  nowIso,
  type Db,
  type Envelope,
  type Event
} from '@zamfono/shared';

import { errorMessage } from '../errors.js';
import { openTargetSecret } from '../ops/backups/_secret.js';
import {
  loadLiveTarget,
  type BackupRunRow,
  type BackupTargetRow
} from '../ops/backups/_shared.js';
import { type Keyring } from '../secretbox.js';
import { loadParams, repositoryAndEnv, type ExecFn } from './backupBackends.js';
import {
  ensureRepository,
  parseResticSummary,
  pruneSnapshots,
  RESTIC_BIN
} from './backupRestic.js';

// 0700: the snapshot is a full-database VACUUM, secrets and password hashes included.
const SNAPSHOT_DIR_MODE = 0o700;

/** The two sinks a `backup.*` event is fanned out to (§6.5, §10.6): `/events` and webhooks. */
export type Bus = {
  publish(ev: Envelope): void;
  enqueue(ev: Envelope): Promise<void>;
};

export type BackupJobDeps = {
  exec: ExecFn;
  mediaDir: string;
  bus: Bus;
  now?: () => string;
};

async function emit(bus: Bus, now: () => string, ev: Event): Promise<void> {
  const envelope: Envelope = { ...ev, id: newId(), at: now() };
  bus.publish(envelope);
  await bus.enqueue(envelope);
}

/**
 * Marks `run` `failed` with `error` and emits `backup.failed` (§6.5): the backup itself failed,
 * or a queued run's target is gone by the time the scheduler picks it up.
 */
export async function failBackupRun(
  db: Db,
  deps: BackupJobDeps,
  run: BackupRunRow,
  error: string
): Promise<BackupRunRow> {
  const now = deps.now ?? nowIso;
  const finishedAt = now();
  await db
    .updateTable('backupRuns')
    .set({ status: 'failed', error, finishedAt })
    .where('id', '=', run.id)
    .execute();
  await emit(deps.bus, now, {
    type: 'backup.failed',
    targetId: run.targetId,
    runId: run.id,
    error
  });
  return { ...run, status: 'failed', error, finishedAt };
}

/** Runs `target`'s backup for the already-`running` `run` row (§6.5), through to `ok`/`failed`. */
export async function performBackup(
  db: Db,
  kr: Keyring,
  run: BackupRunRow,
  target: BackupTargetRow,
  deps: BackupJobDeps
): Promise<BackupRunRow> {
  const now = deps.now ?? nowIso;
  await emit(deps.bus, now, {
    type: 'backup.started',
    targetId: target.id,
    runId: run.id
  });
  const startedAtMs = Date.parse(run.startedAt);
  // Keyed by `target.id`, not a random name: `restic forget` groups snapshots by `host,paths`,
  // so a path that changed every run would put each snapshot in its own group and nothing
  // would ever be forgotten.
  const snapshotDir = path.join(os.tmpdir(), 'zamfono-backup', target.id);
  const snapshotFile = path.join(snapshotDir, 'zamfono.sqlite3');
  try {
    // `VACUUM INTO` refuses an existing output file; a process killed mid-run leaves one behind,
    // since the `finally` cleanup below never gets to run.
    await rm(snapshotDir, { recursive: true, force: true });
    await mkdir(snapshotDir, { recursive: true, mode: SNAPSHOT_DIR_MODE });
    const secret = openTargetSecret(kr, target.secretEnc);
    const { repository, env, options } = await repositoryAndEnv(
      target,
      secret,
      deps.exec
    );
    const fullEnv = {
      ...env,
      RESTIC_REPOSITORY: repository,
      RESTIC_PASSWORD: secret.resticPassword
    };
    await ensureRepository(deps.exec, { ...process.env, ...fullEnv }, options);
    await sql`VACUUM INTO ${snapshotFile}`.execute(db);
    const { stdout } = await deps.exec(
      RESTIC_BIN,
      ['backup', snapshotFile, deps.mediaDir, '--json', ...options],
      { env: { ...process.env, ...fullEnv } }
    );
    const { snapshotId, bytesAdded, bytesTotal } = parseResticSummary(stdout);
    const finishedAt = now();
    await db
      .updateTable('backupRuns')
      .set({ status: 'ok', snapshotId, bytesAdded, bytesTotal, finishedAt })
      .where('id', '=', run.id)
      .execute();
    await pruneSnapshots(deps.exec, fullEnv, options, loadParams(target));
    const durationS = (Date.parse(finishedAt) - startedAtMs) / MS_PER_SECOND;
    await emit(deps.bus, now, {
      type: 'backup.finished',
      targetId: target.id,
      runId: run.id,
      snapshotId,
      bytesAdded,
      bytesTotal,
      durationS
    });
    return {
      ...run,
      status: 'ok',
      snapshotId,
      bytesAdded,
      bytesTotal,
      error: null,
      finishedAt
    };
  } catch (error) {
    const message = errorMessage(error);
    return await failBackupRun(db, deps, run, message);
  } finally {
    await rm(snapshotDir, { recursive: true, force: true });
  }
}

/**
 * Opens a `running` `backup_runs` row for `targetId` (§6.5) and returns it with its live target,
 * ready for `performBackup`. The caller sees the run's id before the backup starts, which is what
 * lets the scheduler mark its own runs as already started.
 */
export async function createBackupRun(
  db: Db,
  targetId: string,
  deps: BackupJobDeps
): Promise<{ run: BackupRunRow; target: BackupTargetRow }> {
  const target = await loadLiveTarget(db, targetId);
  if (!target) {
    throw new Error(`backup: target '${targetId}' not found`);
  }
  const run: BackupRunRow = {
    id: newId(),
    targetId: target.id,
    status: 'running',
    snapshotId: null,
    bytesAdded: null,
    bytesTotal: null,
    error: null,
    startedAt: (deps.now ?? nowIso)(),
    finishedAt: null
  };
  await db.insertInto('backupRuns').values(run).execute();
  return { run, target };
}

/** Runs a fresh backup of `targetId` (§6.5): a new `running` row, then through to `ok`/`failed`. */
export async function runBackup(
  db: Db,
  kr: Keyring,
  targetId: string,
  deps: BackupJobDeps
): Promise<BackupRunRow> {
  const { run, target } = await createBackupRun(db, targetId, deps);
  return performBackup(db, kr, run, target, deps);
}
