import { describe, expect, it } from 'vitest';

import { makeTestDb } from '#lib/server/testDb.js';

import { runOperation, type RunInput } from '../runner.js';
import { type Actor } from '../types.js';
import { type BackupRunWire, type BackupTargetWire } from './_shared.js';

import './index.js';

// backups.targets.create/update encrypt `secret` via secretbox (§5.4), which needs a key.
process.env.SECRETBOX_KEY ??= `1:${Buffer.alloc(32, 7).toString('base64')}`;

const owner: Actor = { id: 'owner', name: 'Owner', role: 'owner' };

function asRun(overrides: Partial<RunInput> = {}): RunInput {
  return { actor: owner, channel: 'rest', requestId: 'req-1', ...overrides };
}

describe('backups', () => {
  it('creates a target, storing only the encrypted secret', async () => {
    const db = await makeTestDb();
    const created = await runOperation<
      unknown,
      BackupTargetWire & { secret?: unknown }
    >(
      db,
      'backups.targets.create',
      {
        kind: 'local',
        params: { path: '/backups' },
        secret: 'restic-repo-password'
      },
      asRun()
    );
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

  it('defaults the forget policy to 7 daily/4 weekly/6 monthly on create', async () => {
    const db = await makeTestDb();
    const created = await runOperation<unknown, BackupTargetWire>(
      db,
      'backups.targets.create',
      { kind: 'local', params: { path: '/backups' }, secret: 'x' },
      asRun()
    );
    expect(created.params.forget).toEqual({
      keepDaily: 7,
      keepWeekly: 4,
      keepMonthly: 6
    });
  });

  it('lists, updates and deletes a target', async () => {
    const db = await makeTestDb();
    const created = await runOperation<unknown, BackupTargetWire>(
      db,
      'backups.targets.create',
      { kind: 'local', params: { path: '/backups' }, secret: 'x' },
      asRun()
    );
    const listed = await runOperation<unknown, { items: BackupTargetWire[] }>(
      db,
      'backups.targets.list',
      {},
      asRun()
    );
    expect(listed.items.map(item => item.id)).toContain(created.id);
    const updated = await runOperation<unknown, BackupTargetWire>(
      db,
      'backups.targets.update',
      { id: created.id, enabled: false },
      asRun()
    );
    expect(updated.enabled).toBe(false);
    await runOperation(
      db,
      'backups.targets.delete',
      { id: created.id },
      asRun({ confirm: true })
    );
    const afterDelete = await runOperation<
      unknown,
      { items: BackupTargetWire[] }
    >(db, 'backups.targets.list', {}, asRun());
    expect(afterDelete.items.map(item => item.id)).not.toContain(created.id);
  });

  it('starts a run as a running row', async () => {
    const db = await makeTestDb();
    const target = await runOperation<unknown, BackupTargetWire>(
      db,
      'backups.targets.create',
      { kind: 'local', params: { path: '/backups' }, secret: 'x' },
      asRun()
    );
    const started = await runOperation<unknown, BackupRunWire>(
      db,
      'backups.runs.start',
      { targetId: target.id },
      asRun()
    );
    expect(started.status).toBe('running');
    const fetched = await runOperation<unknown, BackupRunWire>(
      db,
      'backups.runs.get',
      { id: started.id },
      asRun()
    );
    expect(fetched.id).toBe(started.id);
    const listed = await runOperation<unknown, { items: BackupRunWire[] }>(
      db,
      'backups.runs.list',
      { targetId: target.id },
      asRun()
    );
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
