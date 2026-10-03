import { describe, expect, it } from 'vitest';

import { type Db } from '@zamfono/shared';

import {
  asConfirmedRun,
  makeTestDb,
  seedSettings
} from '#lib/server/testDb.js';

import { runOperation } from '../runner.js';

import '../ringGroups/index.js';
import '../userGroups/index.js';
import '../users/index.js';
import './index.js';

async function createUser(db: Db, name: string, ext: string): Promise<string> {
  const result = (await runOperation(
    db,
    'users.create',
    { name, email: `${name.toLowerCase()}@x.test`, extension: ext },
    asConfirmedRun()
  )) as { user: { id: string } };
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
  await runOperation(db, 'audit.undo', { id: entry.id }, asConfirmedRun());
}

type Members = { members: { kind: string; id: string }[] };

describe('audit.undo of a deleted member after a members edit', () => {
  it('keeps the ring-group position of a user deleted before the edit', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const anna = await createUser(db, 'Anna', '101');
    const ben = await createUser(db, 'Ben', '102');
    const carl = await createUser(db, 'Carl', '103');
    const group = (await runOperation(
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
      asConfirmedRun()
    )) as { id: string };
    await runOperation(db, 'users.delete', { id: ben }, asConfirmedRun());
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
      asConfirmedRun()
    );

    await undoLatest(db, 'users.delete', ben);

    const read = (await runOperation(
      db,
      'ringGroups.get',
      { id: group.id },
      asConfirmedRun()
    )) as Members;
    expect(read.members).toEqual([
      { position: 0, kind: 'user', id: carl },
      { position: 1, kind: 'user', id: ben },
      { position: 2, kind: 'user', id: anna }
    ]);
  });

  it('keeps the user-group links of a user and a child group deleted before the edit', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const anna = await createUser(db, 'Anna', '101');
    const ben = await createUser(db, 'Ben', '102');
    const child = (await runOperation(
      db,
      'userGroups.create',
      { name: 'Night shift', members: [] },
      asConfirmedRun()
    )) as { id: string };
    const parent = (await runOperation(
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
      asConfirmedRun()
    )) as { id: string };
    await runOperation(db, 'users.delete', { id: ben }, asConfirmedRun());
    await runOperation(
      db,
      'userGroups.delete',
      { id: child.id },
      asConfirmedRun()
    );
    await runOperation(
      db,
      'userGroups.update',
      { id: parent.id, members: [] },
      asConfirmedRun()
    );

    await undoLatest(db, 'users.delete', ben);
    await undoLatest(db, 'userGroups.delete', child.id);

    const read = (await runOperation(
      db,
      'userGroups.get',
      { id: parent.id },
      asConfirmedRun()
    )) as Members;
    expect(read.members).toEqual([
      { kind: 'user', id: ben },
      { kind: 'userGroup', id: child.id }
    ]);
  });
});
