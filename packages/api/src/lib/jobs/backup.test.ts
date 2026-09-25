import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { newId, nowIso, openDb, type Db, type Envelope } from '@zamfono/shared';
import { migrateForTest } from '@zamfono/shared/testDb.js';

import { encrypt, keyringFromEnv, type Keyring } from '../secretbox.js';
import { failBackupRun, runBackup, type Bus, type ExecFn } from './backup.js';
import { markInterruptedRuns } from './cron.js';
import { nextRun } from './cronExpression.js';

const KEY_BYTE_LENGTH = 32;
const SNAPSHOT_BYTES = 12345;

function testKeyring(): Keyring {
  return keyringFromEnv({
    SECRETBOX_KEY: `1:${randomBytes(KEY_BYTE_LENGTH).toString('base64')}`
  });
}

async function migratedDb(): Promise<Db> {
  const db = openDb(':memory:');
  await migrateForTest(db);
  return db;
}

/** A `backup_targets` row with the default forget policy, its `secret` encrypted under `kr`. */
async function insertTarget(
  db: Db,
  kr: Keyring,
  kind: string,
  params: Record<string, unknown>,
  secret: string
): Promise<string> {
  const id = newId();
  await db
    .insertInto('backupTargets')
    .values({
      id,
      kind,
      paramsJson: JSON.stringify({
        ...params,
        forget: { keepDaily: 7, keepWeekly: 4, keepMonthly: 6 }
      }),
      enabled: 1,
      secretEnc: encrypt(kr, secret),
      createdAt: nowIso()
    })
    .execute();
  return id;
}

/** `restic backup --json`'s output: a status line, then the summary line the job reads. */
function resticBackupOutput(snapshotId: string, bytes: number): string {
  /* eslint-disable camelcase -- restic's own --json field names */
  return [
    JSON.stringify({ message_type: 'status', percent_done: 1 }),
    JSON.stringify({
      message_type: 'summary',
      snapshot_id: snapshotId,
      data_added: bytes
    })
  ].join('\n');
  /* eslint-enable camelcase -- restic's own --json field names */
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

type RecordedCall = {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  input?: string;
};

/**
 * Records every call; `backup` succeeds with `resticBackupOutput`, `rclone obscure` echoes back
 * a recognizable transform of its stdin (real rclone's obscure output is opaque, but this is
 * enough to prove the job passes the credential through it rather than exporting it plain), and
 * `forget` is a no-op.
 */
function recordingExec(
  snapshotId: string,
  bytes: number
): {
  exec: ExecFn;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const exec: ExecFn = (file, args, options) => {
    calls.push({
      file,
      args: [...args],
      env: options.env,
      input: options.input
    });
    if (args[0] === 'backup') {
      return Promise.resolve({
        stdout: resticBackupOutput(snapshotId, bytes),
        stderr: ''
      });
    }
    if (file === 'rclone' && args[0] === 'obscure') {
      return Promise.resolve({
        stdout: `obscured(${options.input ?? ''})\n`,
        stderr: ''
      });
    }
    return Promise.resolve({ stdout: '', stderr: '' });
  };
  return { exec, calls };
}

describe('runBackup: command lines per target kind', () => {
  it('builds a plain filesystem repository for a local target', async () => {
    const db = await migratedDb();
    const kr = testKeyring();
    const targetId = await insertTarget(
      db,
      kr,
      'local',
      { path: '/backups/restic' },
      'restic-pw'
    );
    const { exec, calls } = recordingExec('snap-local', SNAPSHOT_BYTES);
    const { bus } = fakeBus();

    await runBackup(db, kr, targetId, { exec, mediaDir: '/media', bus });

    const backupCall = calls.find(call => call.args[0] === 'backup');
    expect(backupCall?.args[2]).toBe('/media');
    expect(backupCall?.args[3]).toBe('--json');
    expect(backupCall?.env.RESTIC_REPOSITORY).toBe('/backups/restic');
    expect(backupCall?.env.RESTIC_PASSWORD).toBe('restic-pw');
  });

  it('builds an s3 repository with AWS credentials from the secret', async () => {
    const db = await migratedDb();
    const kr = testKeyring();
    const targetId = await insertTarget(
      db,
      kr,
      's3',
      { bucket: 'zamfono-backups', endpoint: 's3.eu-central-1.amazonaws.com' },
      JSON.stringify({
        resticPassword: 'pw',
        accessKeyId: 'AKID',
        secretAccessKey: 'SECRET'
      })
    );
    const { exec, calls } = recordingExec('snap-s3', SNAPSHOT_BYTES);
    const { bus } = fakeBus();

    await runBackup(db, kr, targetId, { exec, mediaDir: '/media', bus });

    const backupCall = calls.find(call => call.args[0] === 'backup');
    expect(backupCall?.env.RESTIC_REPOSITORY).toBe(
      's3:s3.eu-central-1.amazonaws.com/zamfono-backups'
    );
    expect(backupCall?.env.RESTIC_PASSWORD).toBe('pw');
    expect(backupCall?.env.AWS_ACCESS_KEY_ID).toBe('AKID');
    expect(backupCall?.env.AWS_SECRET_ACCESS_KEY).toBe('SECRET');
  });

  it('builds an sftp repository whose ssh authenticates with the secret’s password', async () => {
    vi.stubEnv('DB_FILE', '/data/zamfono.sqlite3');
    const db = await migratedDb();
    const kr = testKeyring();
    const targetId = await insertTarget(
      db,
      kr,
      'sftp',
      { host: 'backup.example.net', path: '/srv/restic' },
      JSON.stringify({
        resticPassword: 'pw',
        username: 'zamfono',
        password: 'ssh pass'
      })
    );
    const { exec, calls } = recordingExec('snap-sftp', SNAPSHOT_BYTES);
    const { bus } = fakeBus();

    const run = await runBackup(db, kr, targetId, {
      exec,
      mediaDir: '/media',
      bus
    });

    expect(run.status).toBe('ok');
    const sftpCommand =
      'sftp.command=sshpass -e ssh -o StrictHostKeyChecking=accept-new ' +
      '-o UserKnownHostsFile=/data/ssh_known_hosts -l zamfono backup.example.net -s sftp';
    const backupCall = calls.find(call => call.args[0] === 'backup');
    expect(backupCall?.env.RESTIC_REPOSITORY).toBe(
      'sftp:zamfono@backup.example.net:/srv/restic'
    );
    // `sshpass -e` reads the password from the environment, never from argv.
    expect(backupCall?.env.SSHPASS).toBe('ssh pass');
    expect(backupCall?.args.slice(-2)).toEqual(['-o', sftpCommand]);
    expect(backupCall?.args.join(' ')).not.toContain('ssh pass');
    const forgetCall = calls.find(call => call.args[0] === 'forget');
    expect(forgetCall?.args.slice(-2)).toEqual(['-o', sftpCommand]);
    vi.unstubAllEnvs();
  });

  it('fails an sftp run whose secret carries no password', async () => {
    vi.stubEnv('DB_FILE', '/data/zamfono.sqlite3');
    const db = await migratedDb();
    const kr = testKeyring();
    const targetId = await insertTarget(
      db,
      kr,
      'sftp',
      { host: 'backup.example.net', path: '/srv/restic' },
      JSON.stringify({ resticPassword: 'pw', username: 'zamfono' })
    );
    const { exec, calls } = recordingExec('snap-sftp', SNAPSHOT_BYTES);
    const { bus } = fakeBus();

    const run = await runBackup(db, kr, targetId, {
      exec,
      mediaDir: '/media',
      bus
    });

    expect(run.status).toBe('failed');
    expect(run.error).toBe("backup: sftp target needs a 'password' credential");
    expect(calls).toHaveLength(0);
    vi.unstubAllEnvs();
  });

  it('builds an ftp repository through restic’s rclone backend', async () => {
    const db = await migratedDb();
    const kr = testKeyring();
    const targetId = await insertTarget(
      db,
      kr,
      'ftp',
      { host: 'ftp.example.net', path: 'restic' },
      JSON.stringify({
        resticPassword: 'pw',
        username: 'user1',
        password: 'pass1'
      })
    );
    const { exec, calls } = recordingExec('snap-ftp', SNAPSHOT_BYTES);
    const { bus } = fakeBus();

    await runBackup(db, kr, targetId, { exec, mediaDir: '/media', bus });

    const backupCall = calls.find(call => call.args[0] === 'backup');
    expect(backupCall?.env.RESTIC_REPOSITORY).toBe('rclone:zamfono:restic');
    expect(backupCall?.env.RCLONE_CONFIG_ZAMFONO_TYPE).toBe('ftp');
    expect(backupCall?.env.RCLONE_CONFIG_ZAMFONO_HOST).toBe('ftp.example.net');
    expect(backupCall?.env.RCLONE_CONFIG_ZAMFONO_USER).toBe('user1');
    // rclone treats a backend password as obscured; the job runs it through `rclone obscure`
    // rather than exporting the plain credential.
    expect(backupCall?.env.RCLONE_CONFIG_ZAMFONO_PASS).toBe('obscured(pass1)');
    const obscureCall = calls.find(
      call => call.file === 'rclone' && call.args[0] === 'obscure'
    );
    // The password travels on stdin, never as an argv element (visible via `ps`, and echoed
    // back into a non-zero-exit error message).
    expect(obscureCall?.input).toBe('pass1');
    expect(obscureCall?.args).not.toContain('pass1');
  });

  it('builds a webdav repository addressed by URL, not host', async () => {
    const db = await migratedDb();
    const kr = testKeyring();
    const targetId = await insertTarget(
      db,
      kr,
      'webdav',
      { url: 'https://dav.example.net/remote.php/webdav/', path: 'restic' },
      JSON.stringify({
        resticPassword: 'pw',
        username: 'user1',
        password: 'pass1'
      })
    );
    const { exec, calls } = recordingExec('snap-webdav', SNAPSHOT_BYTES);
    const { bus } = fakeBus();

    await runBackup(db, kr, targetId, { exec, mediaDir: '/media', bus });

    const backupCall = calls.find(call => call.args[0] === 'backup');
    expect(backupCall?.env.RCLONE_CONFIG_ZAMFONO_TYPE).toBe('webdav');
    expect(backupCall?.env.RCLONE_CONFIG_ZAMFONO_URL).toBe(
      'https://dav.example.net/remote.php/webdav/'
    );
    expect(backupCall?.env.RCLONE_CONFIG_ZAMFONO_HOST).toBeUndefined();
  });
});

describe('runBackup: retention grouping', () => {
  it('backs up the same target under the same path on every run', async () => {
    const db = await migratedDb();
    const kr = testKeyring();
    const targetId = await insertTarget(
      db,
      kr,
      'local',
      { path: '/backups/restic' },
      'restic-pw'
    );
    const { exec, calls } = recordingExec('snap-local', SNAPSHOT_BYTES);
    const { bus } = fakeBus();

    await runBackup(db, kr, targetId, { exec, mediaDir: '/media', bus });
    await runBackup(db, kr, targetId, { exec, mediaDir: '/media', bus });

    const paths = calls
      .filter(call => call.args[0] === 'backup')
      .map(call => call.args[1]);
    expect(paths).toHaveLength(2);
    // `restic forget` groups snapshots by `host,paths`, so a target's snapshot path is stable
    // across runs.
    expect(paths[1]).toBe(paths[0]);
  });

  it('backs up successfully after a prior run left its snapshot file behind', async () => {
    const db = await migratedDb();
    const kr = testKeyring();
    const targetId = await insertTarget(
      db,
      kr,
      'local',
      { path: '/backups/restic' },
      'restic-pw'
    );
    // Simulates a process killed mid-run: `VACUUM INTO`'s output file survives because the
    // `finally` cleanup never ran.
    const snapshotDir = path.join(os.tmpdir(), 'zamfono-backup', targetId);
    await mkdir(snapshotDir, { recursive: true });
    await writeFile(
      path.join(snapshotDir, 'zamfono.sqlite3'),
      'stale snapshot from a killed run'
    );
    const { exec, calls } = recordingExec('snap-2', SNAPSHOT_BYTES);
    const { bus } = fakeBus();

    const run = await runBackup(db, kr, targetId, {
      exec,
      mediaDir: '/media',
      bus
    });

    expect(run.status).toBe('ok');
    expect(run.snapshotId).toBe('snap-2');
    expect(calls.some(call => call.args[0] === 'backup')).toBe(true);
  });
});

describe('pruneSnapshots: default retention', () => {
  it('keeps 7 daily/4 weekly/6 monthly when a target has no forget policy at all', async () => {
    const db = await migratedDb();
    const kr = testKeyring();
    const id = newId();
    await db
      .insertInto('backupTargets')
      .values({
        id,
        kind: 'local',
        paramsJson: JSON.stringify({ path: '/backups/restic' }),
        enabled: 1,
        secretEnc: encrypt(kr, 'restic-pw'),
        createdAt: nowIso()
      })
      .execute();
    const { exec, calls } = recordingExec('snap-local', SNAPSHOT_BYTES);
    const { bus } = fakeBus();

    await runBackup(db, kr, id, { exec, mediaDir: '/media', bus });

    const forgetCall = calls.find(call => call.args[0] === 'forget');
    expect(forgetCall?.args).toEqual([
      'forget',
      '--prune',
      '--keep-daily',
      '7',
      '--keep-weekly',
      '4',
      '--keep-monthly',
      '6'
    ]);
  });
});

describe('failBackupRun', () => {
  it('marks a running row failed and emits backup.failed', async () => {
    const db = await migratedDb();
    const kr = testKeyring();
    const targetId = await insertTarget(
      db,
      kr,
      'local',
      { path: '/backups/restic' },
      'restic-pw'
    );
    const runId = newId();
    await db
      .insertInto('backupRuns')
      .values({
        id: runId,
        targetId,
        status: 'running',
        snapshotId: null,
        bytes: null,
        error: null,
        startedAt: nowIso(),
        finishedAt: null
      })
      .execute();
    const { bus, published } = fakeBus();
    const run = {
      id: runId,
      targetId,
      status: 'running' as const,
      snapshotId: null,
      bytes: null,
      error: null,
      startedAt: nowIso(),
      finishedAt: null
    };

    const result = await failBackupRun(
      db,
      {
        exec: () => Promise.resolve({ stdout: '', stderr: '' }),
        mediaDir: '/media',
        bus
      },
      run,
      "backup: target 'gone' not found"
    );

    expect(result.status).toBe('failed');
    const row = await db
      .selectFrom('backupRuns')
      .selectAll()
      .where('id', '=', runId)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('failed');
    expect(row.error).toBe("backup: target 'gone' not found");
    expect(published).toEqual([
      expect.objectContaining({
        type: 'backup.failed',
        targetId,
        runId,
        error: "backup: target 'gone' not found"
      })
    ]);
  });
});

describe('runBackup: run lifecycle', () => {
  it('starts a run "running", ending "ok" with the restic snapshot id and bytes', async () => {
    const db = await migratedDb();
    const kr = testKeyring();
    const targetId = await insertTarget(
      db,
      kr,
      'local',
      { path: '/backups/restic' },
      'restic-pw'
    );
    let sawRunning = false;
    const exec: ExecFn = async (_file, args) => {
      if (args[0] === 'backup') {
        const row = await db
          .selectFrom('backupRuns')
          .selectAll()
          .where('targetId', '=', targetId)
          .executeTakeFirstOrThrow();
        sawRunning = row.status === 'running';
        return {
          stdout: resticBackupOutput('snap1', SNAPSHOT_BYTES),
          stderr: ''
        };
      }
      return { stdout: '', stderr: '' };
    };
    const { bus, published } = fakeBus();

    const run = await runBackup(db, kr, targetId, {
      exec,
      mediaDir: '/media',
      bus
    });

    expect(sawRunning).toBe(true);
    expect(run.status).toBe('ok');
    expect(run.snapshotId).toBe('snap1');
    expect(run.bytes).toBe(SNAPSHOT_BYTES);
    expect(published.map(ev => ev.type)).toEqual([
      'backup.started',
      'backup.finished'
    ]);
  });

  it('marks a run "failed" with the error and emits backup.failed', async () => {
    const db = await migratedDb();
    const kr = testKeyring();
    const targetId = await insertTarget(
      db,
      kr,
      'local',
      { path: '/backups/restic' },
      'restic-pw'
    );
    const exec: ExecFn = () =>
      Promise.reject(new Error('restic: repository not found'));
    const { bus, published } = fakeBus();

    const run = await runBackup(db, kr, targetId, {
      exec,
      mediaDir: '/media',
      bus
    });

    expect(run.status).toBe('failed');
    expect(run.error).toBe('restic: repository not found');
    const failed = published.find(ev => ev.type === 'backup.failed');
    expect(failed).toMatchObject({
      type: 'backup.failed',
      targetId,
      runId: run.id,
      error: 'restic: repository not found'
    });
  });
});

describe('markInterruptedRuns', () => {
  it('fails a run still "running" from an earlier process with error "interrupted"', async () => {
    const db = await migratedDb();
    const kr = testKeyring();
    const targetId = await insertTarget(
      db,
      kr,
      'local',
      { path: '/backups/restic' },
      'restic-pw'
    );
    await db
      .insertInto('backupRuns')
      .values({
        id: newId(),
        targetId,
        status: 'running',
        snapshotId: null,
        bytes: null,
        error: null,
        startedAt: nowIso(),
        finishedAt: null
      })
      .execute();

    const updated = await markInterruptedRuns(db);

    expect(updated).toBe(1);
    const row = await db
      .selectFrom('backupRuns')
      .selectAll()
      .where('targetId', '=', targetId)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('failed');
    expect(row.error).toBe('interrupted');
  });

  it('leaves a run started at or after `startedBefore` untouched', async () => {
    const db = await migratedDb();
    const kr = testKeyring();
    const targetId = await insertTarget(
      db,
      kr,
      'local',
      { path: '/backups/restic' },
      'restic-pw'
    );
    const bootAt = nowIso();
    const runId = newId();
    await db
      .insertInto('backupRuns')
      .values({
        id: runId,
        targetId,
        status: 'running',
        snapshotId: null,
        bytes: null,
        error: null,
        startedAt: bootAt,
        finishedAt: null
      })
      .execute();

    const updated = await markInterruptedRuns(db, nowIso, bootAt);

    expect(updated).toBe(0);
    const row = await db
      .selectFrom('backupRuns')
      .selectAll()
      .where('id', '=', runId)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('running');
  });
});

describe('nextRun', () => {
  it('computes the next occurrence in UTC', () => {
    const due = nextRun(
      '0 3 * * *',
      'UTC',
      new Date('2026-01-01T00:00:00.000Z')
    );
    expect(due.toISOString()).toBe('2026-01-01T03:00:00.000Z');
  });

  it('computes the next occurrence in the tenant timezone, not UTC', () => {
    // 03:00 in New York (UTC-5 in January) is 08:00 UTC the same day.
    const due = nextRun(
      '0 3 * * *',
      'America/New_York',
      new Date('2026-01-01T00:00:00.000Z')
    );
    expect(due.toISOString()).toBe('2026-01-01T08:00:00.000Z');
  });
});
