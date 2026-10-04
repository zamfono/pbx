import { describe, expect, it } from 'vitest';

import { MS_PER_DAY, newId, nowIso, type Db } from '@zamfono/shared';
import { seedSettings } from '@zamfono/shared/testDb.js';

import { createUser } from '#testing/fixtures.js';
import { asConfirmedRun, asRun, makeTestDb } from '#testing/testDb.js';

import { runOperation } from '../ops/runner.js';
import { runPurge } from './purge.js';

import '../ops/audit/index.js';
import '../ops/calls/index.js';
import '../ops/users/index.js';

// The daily purge (§5.9, §5.7) at its cutoffs, read back through the views over the same rows:
// undo availability (§5.8), the audit log, erasure of a purged user (§5.10) and call history.

const RETENTION_DAYS = 30;

/** `at` plus the retention window plus `offsetMs`: the purge's cutoff lands on `at` at offset 0. */
function purgeTime(at: string, offsetMs: number): string {
  return new Date(
    Date.parse(at) + RETENTION_DAYS * MS_PER_DAY + offsetMs
  ).toISOString();
}

async function auditEntry(
  db: Db,
  operation: string,
  entityId: string
): Promise<{ id: string; createdAt: string }> {
  return db
    .selectFrom('auditLog')
    .select(['id', 'createdAt'])
    .where('operation', '=', operation)
    .where('entityId', '=', entityId)
    .executeTakeFirstOrThrow();
}

async function listedOperations(db: Db, entityId: string): Promise<string[]> {
  const page = (await runOperation(
    db,
    'audit.list',
    { entityKind: 'user', entityId },
    asRun()
  )) as { items: { operation: string }[] };
  return page.items.map(item => item.operation).sort();
}

/** A user `users.delete` soft-deleted, with the `deleted_at` it was given. */
async function deletedUser(db: Db): Promise<{ id: string; deletedAt: string }> {
  const id = await createUser(db, '101');
  await runOperation(db, 'users.delete', { id }, asConfirmedRun());
  const { deletedAt } = await db
    .selectFrom('users')
    .select('deletedAt')
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
  if (deletedAt === null) {
    throw new Error('expected users.delete to set deletedAt');
  }
  return { id, deletedAt };
}

const BOUNDARIES = [
  { when: 'at the cutoff', offsetMs: 0, purged: false },
  { when: 'one millisecond past it', offsetMs: 1, purged: true }
];

describe('runPurge against the views reading the same rows', () => {
  it.each(BOUNDARIES)(
    'a deleted user purged $when: undo restores it only while the row is there, and the audit log keeps the deletion',
    async ({ offsetMs, purged }) => {
      const db = await makeTestDb();
      await seedSettings(db, { softDeleteRetentionDays: RETENTION_DAYS });
      const user = await deletedUser(db);

      await runPurge(db, purgeTime(user.deletedAt, offsetMs));

      const deletion = await auditEntry(db, 'users.delete', user.id);
      const undo = runOperation(
        db,
        'audit.undo',
        { id: deletion.id },
        asConfirmedRun()
      );
      if (purged) {
        await expect(undo).rejects.toMatchObject({
          status: 409,
          message: 'the reverted row has been purged'
        });
        expect(await listedOperations(db, user.id)).toEqual([
          'users.create',
          'users.delete'
        ]);
      } else {
        await undo;
        const restored = (await runOperation(
          db,
          'users.get',
          { id: user.id },
          asRun()
        )) as { id: string };
        expect(restored.id).toBe(user.id);
      }
    }
  );

  it.each(BOUNDARIES)(
    'a field change whose audit entry ages $when: undoable while listed, gone from both views after',
    async ({ offsetMs, purged }) => {
      const db = await makeTestDb();
      await seedSettings(db, { auditRetentionDays: RETENTION_DAYS });
      const userId = await createUser(db, '101');
      await runOperation(
        db,
        'users.update',
        { id: userId, name: 'Berta Huber' },
        asRun()
      );
      const update = await auditEntry(db, 'users.update', userId);

      await runPurge(db, purgeTime(update.createdAt, offsetMs));

      expect(
        (await listedOperations(db, userId)).includes('users.update')
      ).toBe(!purged);
      const undo = runOperation(
        db,
        'audit.undo',
        { id: update.id },
        asConfirmedRun()
      );
      if (purged) {
        await expect(undo).rejects.toMatchObject({ status: 404 });
      } else {
        await undo;
        const user = (await runOperation(
          db,
          'users.get',
          { id: userId },
          asRun()
        )) as { name: string };
        expect(user.name).toBe('Anna Huber');
      }
    }
  );

  it("erases a purged user's audit trail, and their calls stay in the history without them", async () => {
    const db = await makeTestDb();
    await seedSettings(db, { softDeleteRetentionDays: RETENTION_DAYS });
    const user = await deletedUser(db);
    const callId = newId();
    const startedAt = nowIso();
    await db
      .insertInto('calls')
      .values({
        id: callId,
        direction: 'outbound',
        fromUri: '101',
        toUri: '+4930123456',
        callerUserId: user.id,
        status: 'answered',
        startedAt,
        answeredAt: startedAt,
        endedAt: startedAt
      })
      .execute();

    await runPurge(db, purgeTime(user.deletedAt, 1));
    await runOperation(db, 'users.erase', { id: user.id }, asConfirmedRun());

    const created = await auditEntry(db, 'users.create', user.id);
    const { changesJson } = await db
      .selectFrom('auditLog')
      .select('changesJson')
      .where('id', '=', created.id)
      .executeTakeFirstOrThrow();
    expect(changesJson).not.toContain('Anna Huber');
    expect(changesJson).not.toContain('101@x.test');
    const history = (await runOperation(db, 'calls.list', {}, asRun())) as {
      items: { id: string; callerUserId: string | null }[];
    };
    expect(history.items).toEqual([
      expect.objectContaining({ id: callId, callerUserId: null })
    ]);
  });
});
