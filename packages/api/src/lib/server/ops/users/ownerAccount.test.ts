import { describe, expect, it, vi } from 'vitest';

import { MS_PER_DAY, type Db } from '@zamfono/shared';
import { seedSettings } from '@zamfono/shared/testDb.js';

import { asConfirmedRun, asRun, makeTestDb, owner } from '#testing/testDb.js';

import { runOperation } from '../runner.js';
import type { Actor } from '../types.js';

import '../audit/index.js';
import './index.js';

vi.mock('#lib/server/mail/index.js', async importOriginal => {
  const actual =
    await importOriginal<typeof import('#lib/server/mail/index.js')>();
  return { ...actual, sendMail: vi.fn(() => Promise.resolve('sent')) };
});

const admin: Actor = { id: 'admin', name: 'Admin', role: 'admin' };

/** A database holding the seeded owner and `admin`. */
async function ownerAndAdmin(): Promise<Db> {
  const db = await makeTestDb();
  await seedSettings(db);
  await db
    .insertInto('users')
    .values({
      id: admin.id,
      name: admin.name,
      email: 'admin@x',
      role: 'admin',
      createdAt: '2026-01-01T00:00:00.000Z'
    })
    .execute();
  return db;
}

/** Creates Ada as `actor`, an admin unless `role` says otherwise. */
function createAdmin(
  db: Db,
  actor: Actor,
  role = 'admin'
): Promise<{ user: { id: string; role: string } }> {
  return runOperation(
    db,
    'users.create',
    { name: 'Ada', email: 'ada@x.test', role, extension: '120' },
    asRun({ actor })
  ) as Promise<{ user: { id: string; role: string } }>;
}

/** The audit entry `users.create` wrote for `userId`. */
function creationEntry(db: Db, userId: string): Promise<{ id: string }> {
  return db
    .selectFrom('auditLog')
    .select('id')
    .where('operation', '=', 'users.create')
    .where('entityId', '=', userId)
    .executeTakeFirstOrThrow();
}

/** Whether `userId` is soft-deleted. */
async function isDeleted(db: Db, userId: string): Promise<boolean> {
  const row = await db
    .selectFrom('users')
    .select('deletedAt')
    .where('id', '=', userId)
    .executeTakeFirstOrThrow();
  return row.deletedAt !== null;
}

/** The lifetime of the newest set-password link of `userId`, in days. */
async function linkLifetimeDays(db: Db, userId: string): Promise<number> {
  const row = await db
    .selectFrom('tokens')
    .select(['createdAt', 'expiresAt'])
    .where('userId', '=', userId)
    .where('kind', '=', 'reset')
    .orderBy('createdAt', 'desc')
    .executeTakeFirstOrThrow();
  return (Date.parse(row.expiresAt) - Date.parse(row.createdAt)) / MS_PER_DAY;
}

describe("an owner's account (§10.3)", () => {
  it("refuses an admin an owner's set-password link with 403", async () => {
    const db = await ownerAndAdmin();
    await expect(
      runOperation(
        db,
        'users.resetPassword',
        { id: owner.id },
        asRun({ actor: admin })
      )
    ).rejects.toMatchObject({ status: 403 });
  });

  it("refuses an admin a change of an owner's e-mail with 403", async () => {
    const db = await ownerAndAdmin();
    await expect(
      runOperation(
        db,
        'users.update',
        { id: owner.id, email: 'mine@x.test' },
        asRun({ actor: admin })
      )
    ).rejects.toMatchObject({ status: 403 });
  });

  it("lets an owner reset an owner's password", async () => {
    const db = await ownerAndAdmin();
    await runOperation(db, 'users.resetPassword', { id: owner.id }, asRun());
    expect(await linkLifetimeDays(db, owner.id)).toBe(7);
  });

  it('refuses an admin the soft delete of an owner before asking', async () => {
    const db = await ownerAndAdmin();
    await expect(
      runOperation(
        db,
        'users.delete',
        { id: owner.id },
        asRun({ actor: admin })
      )
    ).rejects.toMatchObject({ status: 403 });
  });

  it('lets only an owner create an admin', async () => {
    const db = await ownerAndAdmin();
    await expect(createAdmin(db, admin)).rejects.toMatchObject({
      status: 403
    });
    await expect(createAdmin(db, owner)).resolves.toMatchObject({
      user: { role: 'admin' }
    });
  });

  it('lets only an owner undo the soft delete of an admin', async () => {
    const db = await ownerAndAdmin();
    const { user } = await createAdmin(db, owner);
    await runOperation(db, 'users.delete', { id: user.id }, asConfirmedRun());
    const entry = await db
      .selectFrom('auditLog')
      .select('id')
      .where('operation', '=', 'users.delete')
      .executeTakeFirstOrThrow();
    await expect(
      runOperation(db, 'audit.undo', entry, asRun({ actor: admin }))
    ).rejects.toMatchObject({ status: 403 });
    await runOperation(db, 'audit.undo', entry, asRun());
  });

  it("refuses an admin the undo of an owner's creation, as the delete it replays (§5.8)", async () => {
    const db = await ownerAndAdmin();
    const { user } = await createAdmin(db, owner, 'owner');
    const entry = await creationEntry(db, user.id);
    await expect(
      runOperation(db, 'audit.undo', entry, asRun({ actor: admin }))
    ).rejects.toMatchObject({ status: 403 });
    expect(await isDeleted(db, user.id)).toBe(false);
    const audit = await db
      .selectFrom('auditLog')
      .select(['operation', 'undoneAt'])
      .orderBy('id')
      .execute();
    expect(audit).toEqual([{ operation: 'users.create', undoneAt: null }]);

    await runOperation(db, 'audit.undo', entry, asRun());
    expect(await isDeleted(db, user.id)).toBe(true);
  });

  it("lets an admin undo an admin's creation of a user", async () => {
    const db = await ownerAndAdmin();
    const { user } = await createAdmin(db, admin, 'user');
    const entry = await creationEntry(db, user.id);
    await runOperation(db, 'audit.undo', entry, asRun({ actor: admin }));
    expect(await isDeleted(db, user.id)).toBe(true);
  });
});

describe('an admin-issued set-password link (§5.2)', () => {
  it('lives 7 days, as a setup link', async () => {
    const db = await ownerAndAdmin();
    await runOperation(
      db,
      'users.resetPassword',
      { id: admin.id },
      asRun({ actor: admin })
    );
    expect(await linkLifetimeDays(db, admin.id)).toBe(7);
  });
});
