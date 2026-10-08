import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '#lib/api/ops/index.js';

import { ApiError } from '#lib/api/errors.js';
import { call, ConfirmationRequired, type Actor } from '#lib/api/ops/core.js';
import { BACKUP, U } from '#lib/api/seed/ids.js';
import { resetDb, store } from '#lib/api/store.svelte.js';
import type { SystemInfo } from '#lib/api/types.js';

import type { BackupRunWire, BackupTargetWire } from './backups';

const lea: Actor = { id: U.lea, name: 'Lea Brandt', role: 'owner' };
const jonas: Actor = { id: U.jonas, name: 'Jonas Weber', role: 'admin' };
const mira: Actor = { id: U.mira, name: 'Mira Kovač', role: 'user' };

const run = <O>(
  actor: Actor,
  name: string,
  input: unknown,
  confirmed = false
): O => call<O>(name, input, { actor, channel: 'ui', confirmed });

function refusal(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ApiError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected a refusal');
}

beforeEach(() => {
  vi.useFakeTimers();
  resetDb();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('system', () => {
  it('info for everyone, check for admins, update for owners', () => {
    expect(run<SystemInfo>(mira, 'system.info', {}).api.version).toBe('0.4.1');
    expect(refusal(() => run(mira, 'system.checkUpdate', {})).code).toBe(
      'forbiddenRole'
    );
    expect(
      run<SystemInfo['update']>(jonas, 'system.checkUpdate', {}).latest?.version
    ).toBe('0.5.0');
    expect(refusal(() => run(jonas, 'system.update', {}, true)).code).toBe(
      'forbiddenRole'
    );
  });

  it('asks for confirmation and needs a backup from the last hour', () => {
    expect(() => run(lea, 'system.update', {})).toThrow(ConfirmationRequired);
    expect(refusal(() => run(lea, 'system.update', {}, true)).code).toBe(
      'updateNeedsBackup'
    );
  });

  it('updates after a manual backup and ends on the new release', () => {
    run<BackupRunWire>(jonas, 'backups.runs.start', { targetId: BACKUP.s3 });
    vi.advanceTimersByTime(5000);
    run(lea, 'system.update', {}, true);
    expect(store.db.system.maintenance).toBe(true);
    expect(store.db.system.update.last.state).toBe('running');
    expect(refusal(() => run(lea, 'system.update', {}, true)).code).toBe(
      'updateRunning'
    );
    vi.advanceTimersByTime(7000);
    const info = run<SystemInfo>(lea, 'system.info', {});
    expect(info.maintenance).toBe(false);
    expect(info.api.version).toBe('0.5.0');
    expect(info.update.last).toMatchObject({
      state: 'succeeded',
      from: '0.4.1',
      to: '0.5.0',
      trigger: 'manual',
      by: 'Lea Brandt'
    });
    expect(info.update.updatable).toBe(false);
  });
});

describe('backups', () => {
  it('a manual run is running, then ok, and is a pure, non-undoable entry', () => {
    const started = run<BackupRunWire>(jonas, 'backups.runs.start', {
      targetId: BACKUP.nas
    });
    expect(started.status).toBe('running');
    expect(store.db.audit[0]).toMatchObject({
      operation: 'backups.runs.start',
      undoable: false
    });
    vi.advanceTimersByTime(5000);
    const finished = run<BackupRunWire>(jonas, 'backups.runs.get', {
      id: started.id
    });
    expect(finished.status).toBe('ok');
    expect(finished.snapshotId).not.toBeNull();
    expect(store.db.events.slice(0, 2).map(event => event.type)).toEqual([
      'backup.finished',
      'backup.started'
    ]);
  });

  it('creates targets with the right credentials per kind and a default forget policy', () => {
    expect(
      refusal(() =>
        run(jonas, 'backups.targets.create', {
          kind: 's3',
          params: { bucket: 'b' },
          secret: { resticPassword: 'x', username: 'u', password: 'p' }
        })
      ).code
    ).toBe('backupSecretKind');
    expect(
      refusal(() =>
        run(jonas, 'backups.targets.create', {
          kind: 'sftp',
          params: { host: '-oProxy' },
          secret: { resticPassword: 'x', username: 'u', password: 'p' }
        })
      ).code
    ).toBe('backupHost');
    expect(
      refusal(() =>
        run(jonas, 'backups.targets.create', {
          kind: 'webdav',
          params: { url: 'ftp://x' },
          secret: { resticPassword: 'x', username: 'u', password: 'p' }
        })
      ).code
    ).toBe('backupWebdavUrl');
    const target = run<BackupTargetWire>(jonas, 'backups.targets.create', {
      kind: 'local',
      params: { path: '/backups/restic' },
      secret: { resticPassword: 'secret' }
    });
    expect(target.params.forget).toEqual({
      keepDaily: 7,
      keepWeekly: 4,
      keepMonthly: 6
    });
    expect(target.enabled).toBe(true);
    expect(store.db.audit[0]?.undoable).toBe(false);
  });

  it('changing the kind needs the new kind’s credentials', () => {
    expect(
      refusal(() =>
        run(jonas, 'backups.targets.update', {
          id: BACKUP.nas,
          kind: 's3',
          params: { bucket: 'b' }
        })
      ).code
    ).toBe('backupSecretKind');
    run(jonas, 'backups.targets.update', { id: BACKUP.nas, enabled: false });
    expect(store.db.audit[0]?.undoable).toBe(true);
  });
});
