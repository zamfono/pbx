import { describe, expect, it } from 'vitest';

import { addMsIso, MS_PER_DAY, nowIso, type Db } from '@zamfono/shared';
import { seedSettings, seedUser } from '@zamfono/shared/testDb.js';

import { authenticateToken } from '#lib/server/auth/bearer.js';
import { asConfirmedRun, asRun, makeTestDb, owner } from '#testing/testDb.js';

import { runOperation } from '../runner.js';
import type { Actor } from '../types.js';

import '../users/index.js';
import './index.js';

const admin: Actor = { id: 'admin', name: 'Admin', role: 'admin' };
const anna: Actor = { id: 'anna', name: 'Anna', role: 'user' };
const ben: Actor = { id: 'ben', name: 'Ben', role: 'user' };

type Created = { id: string; userId: string; token: string };

async function seededDb(): Promise<Db> {
  const db = await makeTestDb();
  await seedUser(db, { id: admin.id, name: admin.name, role: admin.role });
  await seedUser(db, {
    id: anna.id,
    name: anna.name,
    role: anna.role,
    ext: '101'
  });
  await seedUser(db, { id: ben.id, name: ben.name, role: ben.role });
  return db;
}

function create(
  db: Db,
  actor: Actor,
  userId: string,
  name = 'crm-sync',
  expiresAt?: string | null
): Promise<Created> {
  return runOperation(
    db,
    'personalAccessTokens.create',
    { userId, name, expiresAt },
    asRun({ actor })
  ) as Promise<Created>;
}

function revoke(db: Db, actor: Actor, id: string): Promise<unknown> {
  return runOperation(
    db,
    'personalAccessTokens.revoke',
    { id },
    asConfirmedRun({ actor })
  );
}

describe('personalAccessTokens', () => {
  it('returns the token once, stores only its hash, and lists it without the value', async () => {
    const db = await seededDb();
    const created = await create(db, anna, anna.id);
    expect(created.token).toMatch(/^zpat_[\w-]{43}$/u);
    const stored = await db
      .selectFrom('personalAccessTokens')
      .select('tokenHash')
      .executeTakeFirstOrThrow();
    expect(stored.tokenHash).not.toContain(created.token);
    const listed = (await runOperation(
      db,
      'personalAccessTokens.list',
      { userId: anna.id },
      asRun({ actor: anna })
    )) as { items: Record<string, unknown>[] };
    expect(listed.items).toEqual([
      expect.objectContaining({ id: created.id, name: 'crm-sync' })
    ]);
    expect(listed.items[0]).not.toHaveProperty('token');
  });

  it('lets a user mint, list and revoke only their own', async () => {
    const db = await seededDb();
    await expect(create(db, anna, ben.id)).rejects.toMatchObject({
      status: 403
    });
    await expect(
      runOperation(
        db,
        'personalAccessTokens.list',
        { userId: ben.id },
        asRun({ actor: anna })
      )
    ).rejects.toMatchObject({ status: 403 });
    const bens = await create(db, admin, ben.id);
    await expect(revoke(db, anna, bens.id)).rejects.toMatchObject({
      status: 403
    });
    await revoke(db, ben, bens.id);
  });

  it("refuses an admin an owner's tokens, and lets an owner act on them", async () => {
    const db = await seededDb();
    await expect(create(db, admin, owner.id)).rejects.toMatchObject({
      status: 403
    });
    const owners = await create(db, owner, owner.id);
    await expect(revoke(db, admin, owners.id)).rejects.toMatchObject({
      status: 403
    });
    await revoke(db, owner, owners.id);
    await expect(revoke(db, owner, owners.id)).rejects.toMatchObject({
      status: 409
    });
  });

  // §10.3 "Personal access tokens": an owner's are owner-only, the list included.
  it("refuses an admin the list of an owner's tokens", async () => {
    const db = await seededDb();
    await create(db, owner, owner.id);
    await expect(
      runOperation(
        db,
        'personalAccessTokens.list',
        { userId: owner.id },
        asRun({ actor: admin })
      )
    ).rejects.toMatchObject({ status: 403 });
  });

  // §10.3 "Confirmation": the question comes after the checks that refuse the caller.
  it("refuses an admin an owner's token before asking to revoke it", async () => {
    const db = await seededDb();
    const owners = await create(db, owner, owner.id);
    await expect(
      runOperation(
        db,
        'personalAccessTokens.revoke',
        { id: owners.id },
        asRun({ actor: admin })
      )
    ).rejects.toMatchObject({ status: 403 });
  });

  it('answers 404 for the list of an unknown or deleted user', async () => {
    const db = await seededDb();
    await db
      .updateTable('users')
      .set({ deletedAt: nowIso() })
      .where('id', '=', ben.id)
      .execute();
    for (const actor of [admin, owner]) {
      for (const userId of ['nobody', ben.id]) {
        // eslint-disable-next-line no-await-in-loop -- one refusal after another on the same db
        await expect(
          runOperation(
            db,
            'personalAccessTokens.list',
            { userId },
            asRun({ actor })
          )
        ).rejects.toMatchObject({ status: 404 });
      }
    }
  });

  it('refuses a live duplicate name and an expiry in the past, and asks before revoking', async () => {
    const db = await seededDb();
    const first = await create(db, anna, anna.id);
    await expect(create(db, anna, anna.id)).rejects.toMatchObject({
      status: 409
    });
    await expect(
      create(db, anna, anna.id, 'other', '2000-01-01T00:00:00Z')
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      runOperation(
        db,
        'personalAccessTokens.revoke',
        { id: first.id },
        asRun({ actor: anna })
      )
    ).rejects.toMatchObject({ status: 409 });
    await revoke(db, anna, first.id);
    await create(db, anna, anna.id);
  });

  it('audits create and revoke as their actor, never undoable and without the value', async () => {
    const db = await seededDb();
    const created = await create(db, admin, anna.id);
    await revoke(db, admin, created.id);
    const rows = await db
      .selectFrom('auditLog')
      .select(['operation', 'actorUserId', 'undoable', 'changesJson'])
      .where('entityId', '=', created.id)
      .orderBy('createdAt')
      .execute();
    expect(
      rows.map(row => [row.operation, row.actorUserId, row.undoable])
    ).toEqual([
      ['personalAccessTokens.create', admin.id, 0],
      ['personalAccessTokens.revoke', admin.id, 0]
    ]);
    expect(rows.map(row => row.changesJson).join()).not.toContain(
      created.token
    );
  });

  it("revokes a user's tokens with their soft delete, so a restored user's stay revoked", async () => {
    const db = await seededDb();
    await seedSettings(db);
    const created = await create(
      db,
      admin,
      anna.id,
      'crm-sync',
      addMsIso(nowIso(), MS_PER_DAY)
    );
    await runOperation(db, 'users.delete', { id: anna.id }, asConfirmedRun());
    const row = await db
      .selectFrom('personalAccessTokens')
      .select('revokedAt')
      .where('id', '=', created.id)
      .executeTakeFirstOrThrow();
    expect(row.revokedAt).not.toBeNull();
    await db
      .updateTable('users')
      .set({ deletedAt: null })
      .where('id', '=', anna.id)
      .execute();
    expect(
      await authenticateToken({ db, jwtSecret: 'x' }, created.token)
    ).toBeNull();
  });
});
