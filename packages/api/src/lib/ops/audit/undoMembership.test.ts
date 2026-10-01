import { describe, expect, it } from 'vitest';

import { newId, nowIso, type Db } from '@zamfono/shared';

import { makeTestDb } from '#lib/testDb.js';

import { runOperation, type RunInput } from '../runner.js';
import { type Actor } from '../types.js';

import '../ringGroups/index.js';
import '../userGroups/index.js';
import '../users/index.js';
import './index.js';

process.env.SECRETBOX_KEY ??= `1:${Buffer.alloc(32, 7).toString('base64')}`;
process.env.ORIGIN ??= 'https://pbx.example.test';

const owner: Actor = { id: 'owner', name: 'Owner', role: 'owner' };

function asRun(overrides: Partial<RunInput> = {}): RunInput {
  return {
    actor: owner,
    channel: 'rest',
    requestId: 'req-1',
    confirm: true,
    ...overrides
  };
}

/** Seeds the tenant `settings` singleton, required by extension assignment. */
async function seedTenant(db: Db): Promise<void> {
  const targetId = newId();
  await db
    .insertInto('forwardTargets')
    .values({ id: targetId, external: '+490000000' })
    .execute();
  const didId = newId();
  await db
    .insertInto('dids')
    .values({ id: didId, number: '+490000000', targetId, createdAt: nowIso() })
    .execute();
  await db
    .insertInto('settings')
    .values({
      id: 1,
      companyName: 'Test Co',
      country: 'DE',
      emergencyNumbersJson: '["112"]',
      mainDidId: didId
    })
    .execute();
}

async function createUser(db: Db, name: string, ext: string): Promise<string> {
  const result = await runOperation<unknown, { user: { id: string } }>(
    db,
    'users.create',
    { name, email: `${name.toLowerCase()}@x.test`, extension: ext },
    asRun()
  );
  return result.user.id;
}

/** Undoes the latest `operation` entry recorded for `entityId`. */
async function undoLatest(
  db: Db,
  operation: string,
  entityId: string
): Promise<void> {
  const entry = await db
    .selectFrom('auditLog')
    .select('id')
    .where('operation', '=', operation)
    .where('entityId', '=', entityId)
    .orderBy('id', 'desc')
    .executeTakeFirstOrThrow();
  await runOperation(db, 'audit.undo', { id: entry.id }, asRun());
}

type Members = { members: { kind: string; id: string }[] };

describe('audit.undo of a deleted member after a members edit', () => {
  it('keeps the ring-group position of a user deleted before the edit', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    const anna = await createUser(db, 'Anna', '101');
    const ben = await createUser(db, 'Ben', '102');
    const carl = await createUser(db, 'Carl', '103');
    const group = await runOperation<unknown, { id: string }>(
      db,
      'ringGroups.create',
      {
        name: 'Support',
        strategy: 'sequential',
        members: [
          { kind: 'user', id: anna },
          { kind: 'user', id: ben },
          { kind: 'user', id: carl }
        ]
      },
      asRun()
    );
    await runOperation(db, 'users.delete', { id: ben }, asRun());
    await runOperation(
      db,
      'ringGroups.update',
      {
        id: group.id,
        members: [
          { kind: 'user', id: carl },
          { kind: 'user', id: anna }
        ]
      },
      asRun()
    );

    await undoLatest(db, 'users.delete', ben);

    const read = await runOperation<unknown, Members>(
      db,
      'ringGroups.get',
      { id: group.id },
      asRun()
    );
    expect(read.members).toEqual([
      { position: 0, kind: 'user', id: carl },
      { position: 1, kind: 'user', id: ben },
      { position: 2, kind: 'user', id: anna }
    ]);
  });

  it('keeps the user-group links of a user and a child group deleted before the edit', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    const anna = await createUser(db, 'Anna', '101');
    const ben = await createUser(db, 'Ben', '102');
    const child = await runOperation<unknown, { id: string }>(
      db,
      'userGroups.create',
      { name: 'Night shift', members: [] },
      asRun()
    );
    const parent = await runOperation<unknown, { id: string }>(
      db,
      'userGroups.create',
      {
        name: 'Support',
        members: [
          { kind: 'user', id: anna },
          { kind: 'user', id: ben },
          { kind: 'userGroup', id: child.id }
        ]
      },
      asRun()
    );
    await runOperation(db, 'users.delete', { id: ben }, asRun());
    await runOperation(db, 'userGroups.delete', { id: child.id }, asRun());
    await runOperation(
      db,
      'userGroups.update',
      { id: parent.id, members: [] },
      asRun()
    );

    await undoLatest(db, 'users.delete', ben);
    await undoLatest(db, 'userGroups.delete', child.id);

    const read = await runOperation<unknown, Members>(
      db,
      'userGroups.get',
      { id: parent.id },
      asRun()
    );
    expect(read.members).toEqual([
      { kind: 'user', id: ben },
      { kind: 'userGroup', id: child.id }
    ]);
  });
});
