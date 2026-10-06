import { describe, expect, it, vi } from 'vitest';

import { nowIso, type Db } from '@zamfono/shared';
import { seedSettings, seedUser } from '@zamfono/shared/testDb.js';

import { issueRecoveryCodes } from '#lib/server/auth/mfa/recoveryCodes.js';
import { saveTotp } from '#lib/server/auth/mfa/totpCredential.js';
import { sendMail } from '#lib/server/mail/index.js';
import { testKeyring } from '#testing/fixtures.js';
import {
  asConfirmedRun,
  asRun,
  makeTestDb,
  owner,
  seedSession
} from '#testing/testDb.js';

import { runOperation } from '../runner.js';
import type { Actor } from '../types.js';

import './index.js';

vi.mock('#lib/server/mail/index.js', async importOriginal => {
  const actual =
    await importOriginal<typeof import('#lib/server/mail/index.js')>();
  return { ...actual, sendMail: vi.fn(() => Promise.resolve('sent')) };
});

const admin: Actor = { id: 'admin', name: 'Admin', role: 'admin' };

/** The seeded owner, `admin` and a second owner, each with an authenticator, recovery codes and
 *  a live session. */
async function enrolled(): Promise<Db> {
  const db = await makeTestDb();
  await seedSettings(db);
  await seedUser(db, { ...admin, email: 'admin@x', ext: '101' });
  await seedUser(db, {
    id: 'owner-2',
    name: 'Olga',
    email: 'olga@x',
    role: 'owner',
    passwordHash: 'x'
  });
  const now = nowIso();
  for (const id of [owner.id, admin.id, 'owner-2']) {
    // eslint-disable-next-line no-await-in-loop -- one user after another keeps the seed readable
    await saveTotp(
      db,
      testKeyring(),
      { userId: id, secret: Buffer.alloc(20, 1), step: 0 },
      now
    );
    // eslint-disable-next-line no-await-in-loop -- as above
    await issueRecoveryCodes(db, id, now);
    // eslint-disable-next-line no-await-in-loop -- as above
    await seedSession(db, id, 'client', `session-${id}`);
  }
  return db;
}

async function liveSessions(db: Db, userId: string): Promise<number> {
  const rows = await db
    .selectFrom('tokens')
    .select('tokenHash')
    .where('userId', '=', userId)
    .where('revokedAt', 'is', null)
    .execute();
  return rows.length;
}

describe('users.resetMfa (§5.2 "Two-factor authentication", §10.3)', () => {
  it('reports the methods on the user record, never a secret', async () => {
    const db = await enrolled();
    const user = await runOperation(db, 'users.get', { id: admin.id }, asRun());
    expect(user).toMatchObject({
      mfa: { totp: true, passkeys: 0, recoveryCodesLeft: 10 }
    });
  });

  it('removes every method and code, ends the sessions, audits it and mails the user', async () => {
    const db = await enrolled();
    await runOperation(
      db,
      'users.resetMfa',
      { id: admin.id },
      asConfirmedRun()
    );
    expect(
      await runOperation(db, 'users.get', { id: admin.id }, asRun())
    ).toMatchObject({
      mfa: { totp: false, passkeys: 0, recoveryCodesLeft: 0 }
    });
    expect(await liveSessions(db, admin.id)).toBe(0);
    expect(await liveSessions(db, owner.id)).toBe(1);
    const entry = await db
      .selectFrom('auditLog')
      .select(['changesJson', 'undoable'])
      .where('operation', '=', 'users.resetMfa')
      .executeTakeFirstOrThrow();
    expect(entry.undoable).toBe(0);
    expect(JSON.parse(entry.changesJson)).toContainEqual({
      field: 'mfa',
      from: { totp: true, passkeys: 0, recoveryCodesLeft: 10 },
      to: null
    });
    expect(sendMail).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        kind: 'mfaChanged',
        to: { userId: admin.id },
        values: expect.objectContaining({ reset: true }) as object
      })
    );
  });

  it('asks for confirmation first', async () => {
    const db = await enrolled();
    await expect(
      runOperation(db, 'users.resetMfa', { id: admin.id }, asRun())
    ).rejects.toMatchObject({ status: 409 });
  });

  it("refuses an admin an owner's reset with 403, and lets another owner do it", async () => {
    const db = await enrolled();
    await expect(
      runOperation(
        db,
        'users.resetMfa',
        { id: 'owner-2' },
        asConfirmedRun({ actor: admin })
      )
    ).rejects.toMatchObject({ status: 403 });
    await runOperation(
      db,
      'users.resetMfa',
      { id: 'owner-2' },
      asConfirmedRun()
    );
    expect(await liveSessions(db, 'owner-2')).toBe(0);
  });

  it("removes a soft-deleted user's methods with them", async () => {
    const db = await enrolled();
    await runOperation(db, 'users.delete', { id: admin.id }, asConfirmedRun());
    const left = await db
      .selectFrom('recoveryCodes')
      .select('id')
      .where('userId', '=', admin.id)
      .execute();
    expect(left).toEqual([]);
  });
});
