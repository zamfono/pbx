import { describe, expect, it } from 'vitest';

import { asRun, makeTestDb } from '#lib/server/testDb.js';

import { runOperation } from '../runner.js';
import { type BackupRunWire, type BackupTargetWire } from './_shared.js';

import './index.js';

describe('backups', () => {
  it('creates a target, storing only the encrypted secret', async () => {
    const db = await makeTestDb();
    const created = (await runOperation(
      db,
      'backups.targets.create',
      {
        kind: 'local',
        params: { path: '/backups' },
        secret: { resticPassword: 'restic-repo-password' }
      },
      asRun()
    )) as BackupTargetWire & { secret?: unknown };
    expect(created.secret).toBeUndefined();
    const row = await db
      .selectFrom('backupTargets')
      .select('secretEnc')
      .where('id', '=', created.id)
      .executeTakeFirstOrThrow();
    expect(row.secretEnc.toString('utf8')).not.toContain(
      'restic-repo-password'
    );
  });

  it('takes the secret as JSON with exactly the credentials of the kind', async () => {
    const db = await makeTestDb();
    const create = (kind: string, secret: unknown): Promise<unknown> =>
      runOperation(
        db,
        'backups.targets.create',
        { kind, params: { path: '/backups' }, secret },
        asRun()
      );
    for (const secret of [
      'restic-repo-password',
      { resticPassword: 'pw', username: 'u', password: 'p' }
    ]) {
      // eslint-disable-next-line no-await-in-loop -- one refusal at a time
      await expect(create('local', secret)).rejects.toMatchObject({
        status: 422
      });
    }
    await expect(
      create('s3', { resticPassword: 'pw', accessKeyId: 'AKID' })
    ).rejects.toMatchObject({ status: 422 });
    const created = (await create('s3', {
      resticPassword: 'pw',
      accessKeyId: 'AKID',
      secretAccessKey: 'SECRET'
    })) as BackupTargetWire;
    // A new kind needs credentials the stored secret lacks, unless a secret comes along.
    await expect(
      runOperation(
        db,
        'backups.targets.update',
        { id: created.id, kind: 'sftp' },
        asRun()
      )
    ).rejects.toMatchObject({ status: 422 });
    const updated = (await runOperation(
      db,
      'backups.targets.update',
      {
        id: created.id,
        kind: 'sftp',
        secret: { resticPassword: 'pw', username: 'u', password: 'p' }
      },
      asRun()
    )) as BackupTargetWire;
    expect(updated.kind).toBe('sftp');
  });

  it('defaults the forget policy to 7 daily/4 weekly/6 monthly on create', async () => {
    const db = await makeTestDb();
    const created = (await runOperation(
      db,
      'backups.targets.create',
      {
        kind: 'local',
        params: { path: '/backups' },
        secret: { resticPassword: 'x' }
      },
      asRun()
    )) as BackupTargetWire;
    expect(created.params.forget).toEqual({
      keepDaily: 7,
      keepWeekly: 4,
      keepMonthly: 6
    });
  });

  it('lists, updates and deletes a target', async () => {
    const db = await makeTestDb();
    const created = (await runOperation(
      db,
      'backups.targets.create',
      {
        kind: 'local',
        params: { path: '/backups' },
        secret: { resticPassword: 'x' }
      },
      asRun()
    )) as BackupTargetWire;
    const listed = (await runOperation(
      db,
      'backups.targets.list',
      {},
      asRun()
    )) as { items: BackupTargetWire[] };
    expect(listed.items.map(item => item.id)).toContain(created.id);
    const updated = (await runOperation(
      db,
      'backups.targets.update',
      { id: created.id, enabled: false },
      asRun()
    )) as BackupTargetWire;
    expect(updated.enabled).toBe(false);
    await runOperation(
      db,
      'backups.targets.delete',
      { id: created.id },
      asRun({ confirm: true })
    );
    const afterDelete = (await runOperation(
      db,
      'backups.targets.list',
      {},
      asRun()
    )) as { items: BackupTargetWire[] };
    expect(afterDelete.items.map(item => item.id)).not.toContain(created.id);
  });

  it('starts a run as a running row', async () => {
    const db = await makeTestDb();
    const target = (await runOperation(
      db,
      'backups.targets.create',
      {
        kind: 'local',
        params: { path: '/backups' },
        secret: { resticPassword: 'x' }
      },
      asRun()
    )) as BackupTargetWire;
    const started = (await runOperation(
      db,
      'backups.runs.start',
      { targetId: target.id },
      asRun()
    )) as BackupRunWire;
    expect(started.status).toBe('running');
    const fetched = (await runOperation(
      db,
      'backups.runs.get',
      { id: started.id },
      asRun()
    )) as BackupRunWire;
    expect(fetched.id).toBe(started.id);
    const listed = (await runOperation(
      db,
      'backups.runs.list',
      { targetId: target.id },
      asRun()
    )) as { items: BackupRunWire[] };
    expect(listed.items.map(item => item.id)).toContain(started.id);
    const audit = await db
      .selectFrom('auditLog')
      .selectAll()
      .where('operation', '=', 'backups.runs.start')
      .executeTakeFirstOrThrow();
    expect(audit.undoable).toBe(0);
  });

  it('refuses to start a run for an unknown target', async () => {
    const db = await makeTestDb();
    await expect(
      runOperation(db, 'backups.runs.start', { targetId: 'missing' }, asRun())
    ).rejects.toMatchObject({ status: 404 });
  });
});
