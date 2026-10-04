import { describe, expect, it } from 'vitest';

import { type Db } from '@zamfono/shared';

import {
  asConfirmedRun,
  asRun,
  makeTestDb,
  seedSettings
} from '#testing/testDb.js';

import { runOperation } from '../runner.js';

import '../audit/index.js';
import '../users/index.js';
import './index.js';

/** The latest `operation` entry, the one an undo of that operation reverts. */
async function latestEntry(db: Db, operation: string): Promise<string> {
  const entry = await db
    .selectFrom('auditLog')
    .select('id')
    .where('operation', '=', operation)
    .orderBy('id', 'desc')
    .executeTakeFirstOrThrow();
  return entry.id;
}

async function undo(db: Db, operation: string): Promise<void> {
  const id = await latestEntry(db, operation);
  await runOperation(db, 'audit.undo', { id }, asConfirmedRun());
}

async function ownerCallerId(db: Db): Promise<string | null> {
  const user = await db
    .selectFrom('users')
    .select('callerIdDidId')
    .where('id', '=', 'owner')
    .executeTakeFirstOrThrow();
  return user.callerIdDidId;
}

/** A test database whose owner has an extension, which `users.update` reports back. */
async function ownerDb(): Promise<Db> {
  const db = await makeTestDb();
  await seedSettings(db);
  await db
    .insertInto('extensions')
    .values({
      ext: '101',
      userId: 'owner',
      ringGroupId: null,
      isParkingSlot: 0
    })
    .execute();
  return db;
}

async function createDid(
  db: Db,
  number: string,
  target:
    { kind: 'user'; userId: string } | { kind: 'external'; external: string }
): Promise<string> {
  const created = (await runOperation(
    db,
    'dids.create',
    { number, target },
    asRun()
  )) as { id: string };
  return created.id;
}

describe('a DID as caller ID (§9.4 "Caller-ID")', () => {
  it('undo of dids.create clears the caller ID it set, then deletes the DID', async () => {
    const db = await ownerDb();
    const id = await createDid(db, '+4930000020', {
      kind: 'user',
      userId: 'owner'
    });
    expect(await ownerCallerId(db)).toBe(id);
    await undo(db, 'dids.create');
    expect(await ownerCallerId(db)).toBeNull();
    const did = await db
      .selectFrom('dids')
      .select('deletedAt')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(did.deletedAt).not.toBeNull();
  });

  it('dids.update retargeted to a user without a caller ID sets it, and undo clears it', async () => {
    const db = await ownerDb();
    const id = await createDid(db, '+4930000021', {
      kind: 'external',
      external: '+4930999999'
    });
    await runOperation(
      db,
      'dids.update',
      { id, target: { kind: 'user', userId: 'owner' } },
      asRun()
    );
    expect(await ownerCallerId(db)).toBe(id);
    await undo(db, 'dids.update');
    expect(await ownerCallerId(db)).toBeNull();
    const target = await db
      .selectFrom('dids')
      .innerJoin('forwardTargets', 'forwardTargets.id', 'dids.targetId')
      .select('forwardTargets.userId')
      .where('dids.id', '=', id)
      .executeTakeFirstOrThrow();
    expect(target.userId).toBeNull();
  });
});
