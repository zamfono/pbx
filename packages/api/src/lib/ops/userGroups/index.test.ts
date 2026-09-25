import { describe, expect, it } from 'vitest';

import { nowIso, type ReloadKind } from '@zamfono/shared';

import { makeTestDb } from '../../testDb.js';
import { onPropagate, runOperation, type RunInput } from '../runner.js';
import { Conflict, OpError, type Actor } from '../types.js';

import './index.js';

const owner: Actor = { id: 'owner', name: 'Owner', role: 'owner' };

function asRun(overrides: Partial<RunInput> = {}): RunInput {
  return { actor: owner, channel: 'rest', requestId: 'req-1', ...overrides };
}

describe('userGroups', () => {
  it('create assigns an id and stores its direct user members', async () => {
    const db = await makeTestDb();
    const group = await runOperation<
      unknown,
      { id: string; members: unknown[] }
    >(
      db,
      'userGroups.create',
      { name: 'Support', members: [{ kind: 'user', id: 'owner' }] },
      asRun()
    );
    expect(group.members).toEqual([{ kind: 'user', id: 'owner' }]);
  });

  it('create propagates pjsip when members is present', async () => {
    const db = await makeTestDb();
    const propagated: { operation: string; kind: ReloadKind[] }[] = [];
    onPropagate(change => {
      propagated.push(change);
      return Promise.resolve();
    });
    await runOperation(
      db,
      'userGroups.create',
      { name: 'Support', members: [{ kind: 'user', id: 'owner' }] },
      asRun()
    );
    expect(propagated).toEqual([
      { operation: 'userGroups.create', kind: ['pjsip'] }
    ]);
  });

  it('refuses an unknown member id with a 404, not a raw DB error', async () => {
    const db = await makeTestDb();
    const attempt = runOperation(
      db,
      'userGroups.create',
      { name: 'Support', members: [{ kind: 'user', id: 'nope' }] },
      asRun()
    );
    await expect(attempt).rejects.toBeInstanceOf(OpError);
    await expect(attempt).rejects.toMatchObject({ status: 404 });
  });

  it('refuses two members naming the same user, with a 422', async () => {
    const db = await makeTestDb();
    const attempt = runOperation(
      db,
      'userGroups.create',
      {
        name: 'Support',
        members: [
          { kind: 'user', id: 'owner' },
          { kind: 'user', id: 'owner' }
        ]
      },
      asRun()
    );
    await expect(attempt).rejects.toBeInstanceOf(OpError);
    await expect(attempt).rejects.toMatchObject({ status: 422 });
  });

  it('update replaces members as a whole and propagates pjsip', async () => {
    const db = await makeTestDb();
    const group = await runOperation<unknown, { id: string }>(
      db,
      'userGroups.create',
      { name: 'Support', members: [{ kind: 'user', id: 'owner' }] },
      asRun()
    );
    const propagated: { operation: string; kind: ReloadKind[] }[] = [];
    onPropagate(change => {
      propagated.push(change);
      return Promise.resolve();
    });
    const updated = await runOperation<
      unknown,
      { id: string; members: unknown[] }
    >(db, 'userGroups.update', { id: group.id, members: [] }, asRun());
    expect(updated.members).toEqual([]);
    expect(propagated).toEqual([
      { operation: 'userGroups.update', kind: ['pjsip'] }
    ]);
  });

  it('refuses to create a user group whose name is already used by another live group', async () => {
    const db = await makeTestDb();
    await runOperation(db, 'userGroups.create', { name: 'Sales' }, asRun());
    const attempt = runOperation(
      db,
      'userGroups.create',
      { name: 'Sales' },
      asRun()
    );
    await expect(attempt).rejects.toBeInstanceOf(Conflict);
    await expect(attempt).rejects.toMatchObject({ status: 409 });
  });

  it('nests one user group under another and lists the child on the parent', async () => {
    const db = await makeTestDb();
    const child = await runOperation<unknown, { id: string }>(
      db,
      'userGroups.create',
      { name: 'Tier 2' },
      asRun()
    );
    const parent = await runOperation<
      unknown,
      { id: string; members: unknown[] }
    >(
      db,
      'userGroups.create',
      { name: 'Tier 1', members: [{ kind: 'userGroup', id: child.id }] },
      asRun()
    );
    expect(parent.members).toEqual([{ kind: 'userGroup', id: child.id }]);
  });

  it('refuses a nesting that would create a cycle, with a 409 naming the path', async () => {
    const db = await makeTestDb();
    const groupA = await runOperation<unknown, { id: string }>(
      db,
      'userGroups.create',
      { name: 'A' },
      asRun()
    );
    const groupB = await runOperation<unknown, { id: string }>(
      db,
      'userGroups.create',
      { name: 'B', members: [{ kind: 'userGroup', id: groupA.id }] },
      asRun()
    );
    const attempt = runOperation(
      db,
      'userGroups.update',
      { id: groupA.id, members: [{ kind: 'userGroup', id: groupB.id }] },
      asRun()
    );
    await expect(attempt).rejects.toBeInstanceOf(OpError);
    await expect(attempt).rejects.toMatchObject({
      status: 409,
      detail: { path: [groupA.id, groupB.id, groupA.id] }
    });
  });

  it('deletes a user group without checking ring-group membership as a blocking reference', async () => {
    const db = await makeTestDb();
    const group = await runOperation<unknown, { id: string }>(
      db,
      'userGroups.create',
      { name: 'Sales' },
      asRun()
    );
    const deleted = await runOperation<unknown, { id: string }>(
      db,
      'userGroups.delete',
      { id: group.id },
      asRun({ confirm: true })
    );
    expect(deleted.id).toBe(group.id);
    const row = await db
      .selectFrom('userGroups')
      .select('deletedAt')
      .where('id', '=', group.id)
      .executeTakeFirstOrThrow();
    expect(row.deletedAt).not.toBeNull();
  });
  it('skips a soft-deleted member, so a read-then-write round trip keeps working', async () => {
    const db = await makeTestDb();
    await db
      .insertInto('users')
      .values({
        id: 'anna',
        name: 'Anna Huber',
        email: 'anna@x',
        role: 'user',
        passwordHash: 'x',
        createdAt: nowIso()
      })
      .execute();
    const group = await runOperation<unknown, { id: string }>(
      db,
      'userGroups.create',
      {
        name: 'Support',
        members: [
          { kind: 'user', id: 'owner' },
          { kind: 'user', id: 'anna' }
        ]
      },
      asRun()
    );
    await db
      .updateTable('users')
      .set({ deletedAt: nowIso() })
      .where('id', '=', 'anna')
      .execute();

    const read = await runOperation<unknown, { members: unknown[] }>(
      db,
      'userGroups.get',
      { id: group.id },
      asRun()
    );

    expect(read.members).toEqual([{ kind: 'user', id: 'owner' }]);
    const written = await runOperation<unknown, { members: unknown[] }>(
      db,
      'userGroups.update',
      { id: group.id, members: read.members },
      asRun()
    );
    expect(written.members).toEqual([{ kind: 'user', id: 'owner' }]);
  });
});
