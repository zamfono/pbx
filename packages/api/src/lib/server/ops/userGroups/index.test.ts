import { describe, expect, it, vi } from 'vitest';

import { nowIso } from '@zamfono/shared';

import { propagateConfig } from '#lib/server/propagation.js';
import { makeTestDb } from '#lib/server/testDb.js';

import { runOperation, type RunInput } from '../runner.js';
import { Conflict, OpError, type Actor } from '../types.js';

import './index.js';

const owner: Actor = { id: 'owner', name: 'Owner', role: 'owner' };

function asRun(overrides: Partial<RunInput> = {}): RunInput {
  return { actor: owner, channel: 'rest', requestId: 'req-1', ...overrides };
}

describe('userGroups', () => {
  it('create assigns an id and stores its direct user members', async () => {
    const db = await makeTestDb();
    const group = (await runOperation(
      db,
      'userGroups.create',
      { name: 'Support', members: [{ kind: 'user', id: 'owner' }] },
      asRun()
    )) as { id: string; members: unknown[] };
    expect(group.members).toEqual([{ kind: 'user', id: 'owner' }]);
  });

  it('create propagates pjsip when members is present', async () => {
    const db = await makeTestDb();
    vi.mocked(propagateConfig).mockClear();
    await runOperation(
      db,
      'userGroups.create',
      { name: 'Support', members: [{ kind: 'user', id: 'owner' }] },
      asRun()
    );
    expect(vi.mocked(propagateConfig).mock.calls).toEqual([[db, ['pjsip']]]);
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
    const group = (await runOperation(
      db,
      'userGroups.create',
      { name: 'Support', members: [{ kind: 'user', id: 'owner' }] },
      asRun()
    )) as { id: string };
    vi.mocked(propagateConfig).mockClear();
    const updated = (await runOperation(
      db,
      'userGroups.update',
      { id: group.id, members: [] },
      asRun()
    )) as { id: string; members: unknown[] };
    expect(updated.members).toEqual([]);
    expect(vi.mocked(propagateConfig).mock.calls).toEqual([[db, ['pjsip']]]);
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
    const child = (await runOperation(
      db,
      'userGroups.create',
      { name: 'Tier 2' },
      asRun()
    )) as { id: string };
    const parent = (await runOperation(
      db,
      'userGroups.create',
      { name: 'Tier 1', members: [{ kind: 'userGroup', id: child.id }] },
      asRun()
    )) as { id: string; members: unknown[] };
    expect(parent.members).toEqual([{ kind: 'userGroup', id: child.id }]);
  });

  it('refuses a nesting that would create a cycle, with a 409 naming the path', async () => {
    const db = await makeTestDb();
    const groupA = (await runOperation(
      db,
      'userGroups.create',
      { name: 'A' },
      asRun()
    )) as { id: string };
    const groupB = (await runOperation(
      db,
      'userGroups.create',
      { name: 'B', members: [{ kind: 'userGroup', id: groupA.id }] },
      asRun()
    )) as { id: string };
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
    const group = (await runOperation(
      db,
      'userGroups.create',
      { name: 'Sales' },
      asRun()
    )) as { id: string };
    const deleted = (await runOperation(
      db,
      'userGroups.delete',
      { id: group.id },
      asRun({ confirm: true })
    )) as { id: string };
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
    const group = (await runOperation(
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
    )) as { id: string };
    await db
      .updateTable('users')
      .set({ deletedAt: nowIso() })
      .where('id', '=', 'anna')
      .execute();

    const read = (await runOperation(
      db,
      'userGroups.get',
      { id: group.id },
      asRun()
    )) as { members: unknown[] };

    expect(read.members).toEqual([{ kind: 'user', id: 'owner' }]);
    const written = (await runOperation(
      db,
      'userGroups.update',
      { id: group.id, members: read.members },
      asRun()
    )) as { members: unknown[] };
    expect(written.members).toEqual([{ kind: 'user', id: 'owner' }]);
  });
});
