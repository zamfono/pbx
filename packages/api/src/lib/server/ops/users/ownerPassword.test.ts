import { describe, expect, it, vi } from 'vitest';

import { addMsIso, MS_PER_DAY, nowIso, type Db } from '@zamfono/shared';
import { seedSettings, seedUser } from '@zamfono/shared/testDb.js';

import {
  asConfirmedRun,
  asRun,
  makeTestDb,
  owner,
  seedSession
} from '#testing/testDb.js';

import { runOperation } from '../runner.js';
import type { Actor } from '../types.js';

import '../personalAccessTokens/index.js';
import './index.js';

vi.mock('#lib/server/mail/index.js', async importOriginal => {
  const actual =
    await importOriginal<typeof import('#lib/server/mail/index.js')>();
  return { ...actual, sendMail: vi.fn(() => Promise.resolve('sent')) };
});

const admin: Actor = { id: 'admin', name: 'Admin', role: 'admin' };

/** The seeded owner (with a password), `admin`, and Sso, an SSO-only admin with a session and a
 *  personal access token. */
async function seededDb(): Promise<Db> {
  const db = await makeTestDb();
  await seedSettings(db);
  await seedUser(db, { id: admin.id, name: admin.name, role: 'admin' });
  await seedUser(db, { id: 'sso', name: 'Sso', role: 'admin', ext: '140' });
  await seedSession(db, 'sso', 'console', 'session-sso');
  await db
    .insertInto('personalAccessTokens')
    .values({
      id: 'pat-sso',
      tokenHash: 'hash-sso',
      userId: 'sso',
      name: 'crm-sync',
      createdBy: 'sso',
      createdAt: nowIso(),
      expiresAt: addMsIso(nowIso(), MS_PER_DAY)
    })
    .execute();
  return db;
}

/** Creates the owner Olga, without a password, as `actor`. */
function createOwner(
  db: Db,
  actor: Actor
): Promise<{ user: { id: string; role: string }; setupLink: string }> {
  return runOperation(
    db,
    'users.create',
    { name: 'Olga', email: 'olga@x.test', role: 'owner', extension: '130' },
    asRun({ actor })
  ) as Promise<{ user: { id: string; role: string }; setupLink: string }>;
}

async function passwordHashOf(db: Db, id: string): Promise<string | null> {
  const row = await db
    .selectFrom('users')
    .select('passwordHash')
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
  return row.passwordHash;
}

describe('an owner without a password (§5.2, §10.3)', () => {
  it('is created by an owner, with a setup link and no password', async () => {
    const db = await seededDb();
    const created = await createOwner(db, owner);
    expect(created.user.role).toBe('owner');
    expect(created.setupLink).toContain('/auth/setPassword?token=');
    expect(await passwordHashOf(db, created.user.id)).toBeNull();
  });

  it('is never created by an admin (403)', async () => {
    const db = await seededDb();
    await expect(createOwner(db, admin)).rejects.toMatchObject({
      status: 403
    });
  });

  it('comes from promoting an SSO-only user, whose sessions and tokens end, with a set-password link', async () => {
    const db = await seededDb();
    const out = (await runOperation(
      db,
      'users.update',
      { id: 'sso', role: 'owner' },
      asRun()
    )) as { user: { role: string }; setupLink?: string };
    expect(out.user.role).toBe('owner');
    expect(out.setupLink).toContain('/auth/setPassword?token=');
    const liveRefresh = await db
      .selectFrom('tokens')
      .select('tokenHash')
      .where('userId', '=', 'sso')
      .where('kind', '=', 'refresh')
      .where('revokedAt', 'is', null)
      .execute();
    expect(liveRefresh).toEqual([]);
    const pat = await db
      .selectFrom('personalAccessTokens')
      .select('revokedAt')
      .where('id', '=', 'pat-sso')
      .executeTakeFirstOrThrow();
    expect(pat.revokedAt).not.toBeNull();
  });

  it('gets no personal access token (409)', async () => {
    const db = await seededDb();
    const { user } = await createOwner(db, owner);
    await expect(
      runOperation(
        db,
        'personalAccessTokens.create',
        { userId: user.id, name: 'crm-sync' },
        asRun()
      )
    ).rejects.toMatchObject({ status: 409 });
  });

  it('does not count as an owner who keeps the tenant from losing its last one', async () => {
    const db = await seededDb();
    const { user } = await createOwner(db, owner);
    await expect(
      runOperation(db, 'users.update', { id: owner.id, role: 'admin' }, asRun())
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      runOperation(db, 'users.delete', { id: owner.id }, asConfirmedRun())
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      runOperation(db, 'users.delete', { id: user.id }, asConfirmedRun())
    ).resolves.toEqual({ id: user.id });
  });
});
