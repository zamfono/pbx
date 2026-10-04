import { describe, expect, it, vi } from 'vitest';

import { MS_PER_DAY, type Db } from '@zamfono/shared';

import { asRun, makeTestDb, owner, seedSettings } from '#lib/server/testDb.js';

import { runOperation } from '../runner.js';
import type { Actor } from '../types.js';

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
