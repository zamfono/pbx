import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { ReloadKind } from '@zamfono/shared';

import { makeTestDb } from '../testDb.js';
import { register } from './registry.js';
import {
  onPropagate,
  propagate,
  recordChange,
  runOperation,
  type RunInput
} from './runner.js';
import { ConfirmationRequired, defineOperation, type Actor } from './types.js';

const owner: Actor = { id: 'owner', name: 'Owner', role: 'owner' };
const plainUser: Actor = { id: 'u1', name: 'A User', role: 'user' };

function asRun(overrides: Partial<RunInput> = {}): RunInput {
  return { actor: owner, channel: 'rest', requestId: 'req-1', ...overrides };
}

describe('runOperation', () => {
  it('rejects input that fails the operation schema with a 422 OpError', async () => {
    const db = await makeTestDb();
    register(
      defineOperation({
        name: 'test.echo',
        description: 'echoes num',
        input: z.object({ num: z.number() }),
        minRole: 'user',
        readOnly: true,
        run: (ctx, input) => Promise.resolve(input.num)
      })
    );
    await expect(
      runOperation(db, 'test.echo', { num: 'x' }, asRun())
    ).rejects.toMatchObject({ status: 422 });
  });

  it('enforces minRole: refused below it, allowed at or above', async () => {
    const db = await makeTestDb();
    register(
      defineOperation({
        name: 'test.adminOnly',
        description: 'an admin-only read',
        input: z.object({}),
        minRole: 'admin',
        readOnly: true,
        run: () => Promise.resolve('ok')
      })
    );
    await expect(
      runOperation(db, 'test.adminOnly', {}, asRun({ actor: plainUser }))
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      runOperation(db, 'test.adminOnly', {}, asRun({ actor: owner }))
    ).resolves.toBe('ok');
  });

  it('asks for confirmation unless already confirmed, never on undo or job', async () => {
    const db = await makeTestDb();
    register(
      defineOperation({
        name: 'test.deleteThing',
        description: 'deletes a thing',
        input: z.object({}),
        minRole: 'user',
        readOnly: true,
        confirm: () => 'Delete the thing?',
        run: () => Promise.resolve('deleted')
      })
    );
    const refused = runOperation(db, 'test.deleteThing', {}, asRun());
    await expect(refused).rejects.toBeInstanceOf(ConfirmationRequired);
    await expect(refused).rejects.toMatchObject({
      status: 409,
      question: 'Delete the thing?'
    });
    await expect(
      runOperation(db, 'test.deleteThing', {}, asRun({ confirm: true }))
    ).resolves.toBe('deleted');
    await expect(
      runOperation(db, 'test.deleteThing', {}, asRun({ channel: 'undo' }))
    ).resolves.toBe('deleted');
    await expect(
      runOperation(db, 'test.deleteThing', {}, asRun({ channel: 'job' }))
    ).resolves.toBe('deleted');
  });

  it('writes one audit_log row for a successful, audited write', async () => {
    const db = await makeTestDb();
    register(
      defineOperation({
        name: 'test.renameThing',
        description: 'renames a thing',
        input: z.object({ id: z.string() }),
        minRole: 'user',
        entity: input => ({ kind: 'thing', id: input.id }),
        run: (ctx, input) => {
          recordChange(ctx, { field: 'name', from: 'a', to: 'b' });
          return Promise.resolve({ id: input.id });
        }
      })
    );
    await runOperation(db, 'test.renameThing', { id: 't1' }, asRun());
    const rows = await db.selectFrom('auditLog').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      operation: 'test.renameThing',
      channel: 'rest',
      actorUserId: 'owner',
      changesJson: JSON.stringify([{ field: 'name', from: 'a', to: 'b' }]),
      undoable: 1
    });
  });

  it('writes no audit_log row for a readOnly op or one with audit: false', async () => {
    const db = await makeTestDb();
    register(
      defineOperation({
        name: 'test.readOnlyThing',
        description: 'reads a thing',
        input: z.object({}),
        minRole: 'user',
        readOnly: true,
        run: () => Promise.resolve('ok')
      })
    );
    register(
      defineOperation({
        name: 'test.silentWrite',
        description: 'writes without an audit trail',
        input: z.object({}),
        minRole: 'user',
        audit: false,
        run: () => Promise.resolve('ok')
      })
    );
    await runOperation(db, 'test.readOnlyThing', {}, asRun());
    await runOperation(db, 'test.silentWrite', {}, asRun());
    const rows = await db.selectFrom('auditLog').selectAll().execute();
    expect(rows).toHaveLength(0);
  });

  it('masks a secret field change and marks the entry non-undoable', async () => {
    const db = await makeTestDb();
    register(
      defineOperation({
        name: 'test.rotateSecret',
        description: 'rotates a secret',
        input: z.object({}),
        minRole: 'admin',
        entity: () => ({ kind: 'device', id: 'd1' }),
        run: ctx => {
          recordChange(ctx, { field: 'sipPassword', from: 'x', to: 'y' });
          return Promise.resolve('ok');
        }
      })
    );
    await runOperation(db, 'test.rotateSecret', {}, asRun());
    const rows = await db.selectFrom('auditLog').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]?.changesJson ?? '[]')).toEqual([
      { field: 'sipPassword', from: '***', to: '***' }
    ]);
    expect(rows[0]?.undoable).toBe(0);
  });

  it('rolls back the op body and skips the audit row when run throws', async () => {
    const db = await makeTestDb();
    register(
      defineOperation({
        name: 'test.writeThenThrow',
        description: 'writes a device then throws',
        input: z.object({}),
        minRole: 'admin',
        entity: () => ({ kind: 'device', id: 'd1' }),
        run: async ctx => {
          await ctx.db
            .insertInto('devices')
            .values({
              id: 'd1',
              userId: 'owner',
              label: 'x',
              kind: 'manual',
              sipUsername: 'e1-d1',
              sipPasswordEnc: Buffer.alloc(1),
              createdAt: ctx.now
            })
            .execute();
          recordChange(ctx, { field: 'label', from: null, to: 'x' });
          throw new Error('boom');
        }
      })
    );
    await expect(
      runOperation(db, 'test.writeThenThrow', {}, asRun())
    ).rejects.toThrow('boom');
    const devices = await db.selectFrom('devices').selectAll().execute();
    expect(devices).toHaveLength(0);
    const rows = await db.selectFrom('auditLog').selectAll().execute();
    expect(rows).toHaveLength(0);
  });

  it('propagates the deduplicated reload kinds an operation requests, once after commit, never on a throw, a readOnly op, or a write that never called propagate', async () => {
    const db = await makeTestDb();
    const propagated: { operation: string; kind: ReloadKind[] }[] = [];
    onPropagate(change => {
      propagated.push(change);
      return Promise.resolve();
    });
    register(
      defineOperation({
        name: 'test.propagatingWrite',
        description: 'a write requesting the same kind twice and a second kind',
        input: z.object({}),
        minRole: 'admin',
        entity: () => ({ kind: 'device', id: 'd1' }),
        run: ctx => {
          propagate(ctx, ['pjsip']);
          propagate(ctx, ['pjsip', 'dialplan']);
          return Promise.resolve('ok');
        }
      })
    );
    register(
      defineOperation({
        name: 'test.propagatingThrow',
        description: 'a write that requests a reload kind then throws',
        input: z.object({}),
        minRole: 'admin',
        entity: () => ({ kind: 'device', id: 'd1' }),
        run: ctx => {
          propagate(ctx, ['pjsip']);
          return Promise.reject(new Error('nope'));
        }
      })
    );
    register(
      defineOperation({
        name: 'test.propagatingReadOnly',
        description: 'a readOnly op that still requests a reload kind',
        input: z.object({}),
        minRole: 'user',
        readOnly: true,
        run: ctx => {
          propagate(ctx, ['pjsip']);
          return Promise.resolve('ok');
        }
      })
    );
    register(
      defineOperation({
        name: 'test.noKindRequested',
        description: 'a non-readOnly write that requests no reload kind',
        input: z.object({}),
        minRole: 'admin',
        entity: () => ({ kind: 'device', id: 'd2' }),
        run: () => Promise.resolve('ok')
      })
    );
    await runOperation(db, 'test.propagatingWrite', {}, asRun());
    await expect(
      runOperation(db, 'test.propagatingThrow', {}, asRun())
    ).rejects.toThrow('nope');
    await runOperation(db, 'test.propagatingReadOnly', {}, asRun());
    await runOperation(db, 'test.noKindRequested', {}, asRun());
    expect(propagated).toEqual([
      { operation: 'test.propagatingWrite', kind: ['pjsip', 'dialplan'] }
    ]);
  });
  it('propagates a write that changed config but asked for no reload', async () => {
    const db = await makeTestDb();
    const propagated: { operation: string; kind: ReloadKind[] }[] = [];
    onPropagate(change => {
      propagated.push(change);
      return Promise.resolve();
    });
    register(
      defineOperation({
        name: 'test.configOnlyWrite',
        description: 'a write the routing pipeline reads but Asterisk does not',
        input: z.object({}),
        minRole: 'admin',
        entity: () => ({ kind: 'did', id: 'did-1' }),
        run: ctx => {
          propagate(ctx, []);
          return Promise.resolve('ok');
        }
      })
    );
    await runOperation(db, 'test.configOnlyWrite', {}, asRun());
    // §3.1: `core` drops its config cache for this, and reloads nothing. A DID, a menu, an
    // outbound route and an out-of-office rule all change routing without touching Asterisk.
    expect(propagated).toEqual([
      { operation: 'test.configOnlyWrite', kind: [] }
    ]);
  });

  it('reports the committed write when a propagation hook fails after commit', async () => {
    const db = await makeTestDb();
    const reached: string[] = [];
    onPropagate(() => Promise.reject(new Error('core unreachable')));
    onPropagate(change => {
      reached.push(change.operation);
      return Promise.resolve();
    });
    register(
      defineOperation({
        name: 'test.propagatingWriteThatFailsToReload',
        description: 'a write whose reload notification fails',
        input: z.object({}),
        minRole: 'admin',
        entity: () => ({ kind: 'device', id: 'd3' }),
        run: async ctx => {
          await ctx.db
            .insertInto('devices')
            .values({
              id: 'd3',
              userId: 'owner',
              label: 'x',
              kind: 'manual',
              sipUsername: 'e1-d3',
              sipPasswordEnc: Buffer.alloc(1),
              createdAt: ctx.now
            })
            .execute();
          propagate(ctx, ['pjsip']);
          return 'ok';
        }
      })
    );

    await expect(
      runOperation(db, 'test.propagatingWriteThatFailsToReload', {}, asRun())
    ).resolves.toBe('ok');

    const devices = await db
      .selectFrom('devices')
      .select('id')
      .where('id', '=', 'd3')
      .execute();
    expect(devices).toHaveLength(1);
    const audit = await db
      .selectFrom('auditLog')
      .select('id')
      .where('operation', '=', 'test.propagatingWriteThatFailsToReload')
      .execute();
    expect(audit).toHaveLength(1);
    // A hook that rejects does not keep the remaining hooks from running.
    expect(reached).toEqual(['test.propagatingWriteThatFailsToReload']);
  });
});
