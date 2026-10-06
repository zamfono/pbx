import { describe, expect, it, vi } from 'vitest';

import { type Db } from '@zamfono/shared';
import { seedSettings } from '@zamfono/shared/testDb.js';

import { sendMail } from '#lib/server/mail/index.js';
import {
  asConfirmedRun,
  asRun,
  makeTestDb,
  seedSession
} from '#testing/testDb.js';

import { runOperation } from '../runner.js';

import '../audit/index.js';
import '../devices/index.js';
import '../personalAccessTokens/index.js';
import '../ringGroups/index.js';
import './index.js';

vi.mock('#lib/server/mail/index.js', async importOriginal => {
  const actual =
    await importOriginal<typeof import('#lib/server/mail/index.js')>();
  return { ...actual, sendMail: vi.fn(() => Promise.resolve('sent')) };
});

type UserOut = { id: string; email: string | null; extension: string | null };
type Created = { user: UserOut; setupLink: string | null };

async function seededDb(): Promise<Db> {
  const db = await makeTestDb();
  await seedSettings(db);
  return db;
}

function create(db: Db, input: Record<string, unknown>): Promise<Created> {
  return runOperation(
    db,
    'users.create',
    { name: 'Pat', ...input },
    asRun()
  ) as Promise<Created>;
}

function update(
  db: Db,
  input: Record<string, unknown>
): Promise<{ user: UserOut }> {
  return runOperation(db, 'users.update', input, asRun()) as Promise<{
    user: UserOut;
  }>;
}

describe('a user needs an e-mail or an extension (§11.2)', () => {
  it('creates a user with an e-mail alone, who has no extension', async () => {
    const db = await seededDb();
    const { user, setupLink } = await create(db, { email: 'pat@x.test' });
    expect(user.extension).toBeNull();
    expect(setupLink).toContain('/auth/setPassword?token=');
  });

  it('creates a user with an extension alone, who gets no link and no mail', async () => {
    const db = await seededDb();
    vi.mocked(sendMail).mockClear();
    const { user, setupLink } = await create(db, { extension: '101' });
    expect(user).toMatchObject({ email: null, extension: '101' });
    expect(setupLink).toBeNull();
    const links = await db
      .selectFrom('tokens')
      .select('tokenHash')
      .where('userId', '=', user.id)
      .execute();
    expect(links).toEqual([]);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('refuses a user with neither, and an admin without an e-mail (422)', async () => {
    const db = await seededDb();
    await expect(create(db, {})).rejects.toMatchObject({ status: 422 });
    await expect(
      create(db, { extension: '101', role: 'admin' })
    ).rejects.toMatchObject({ status: 422 });
  });

  it('gives a user without an extension no device and no ring-group membership (409)', async () => {
    const db = await seededDb();
    const { user } = await create(db, { email: 'pat@x.test' });
    await expect(
      runOperation(
        db,
        'devices.create',
        { userId: user.id, label: 'Desk', kind: 'manual' },
        asRun()
      )
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      runOperation(
        db,
        'ringGroups.create',
        {
          name: 'Sales',
          strategy: 'simultaneous',
          members: [{ kind: 'user', id: user.id }]
        },
        asRun()
      )
    ).rejects.toMatchObject({ status: 409 });
  });

  it('removes an extension only from a user with an e-mail, no device and no ring group', async () => {
    const db = await seededDb();
    const phone = await create(db, { extension: '101' });
    await expect(
      update(db, { id: phone.user.id, extension: null })
    ).rejects.toMatchObject({ status: 409 });

    const pat = await create(db, { email: 'pat@x.test', extension: '102' });
    await runOperation(
      db,
      'devices.create',
      { userId: pat.user.id, label: 'Desk', kind: 'manual' },
      asRun()
    );
    await expect(
      update(db, { id: pat.user.id, extension: null })
    ).rejects.toMatchObject({ status: 409 });

    const kim = await create(db, { email: 'kim@x.test', extension: '103' });
    await runOperation(
      db,
      'ringGroups.create',
      {
        name: 'Sales',
        strategy: 'simultaneous',
        members: [{ kind: 'user', id: kim.user.id }]
      },
      asRun()
    );
    await expect(
      update(db, { id: kim.user.id, extension: null })
    ).rejects.toMatchObject({ status: 409 });

    const lee = await create(db, { email: 'lee@x.test', extension: '104' });
    const { user } = await update(db, { id: lee.user.id, extension: null });
    expect(user.extension).toBeNull();
    const entry = await db
      .selectFrom('auditLog')
      .select('id')
      .where('operation', '=', 'users.update')
      .where('entityId', '=', lee.user.id)
      .executeTakeFirstOrThrow();
    await runOperation(db, 'audit.undo', entry, asRun());
    const restored = (await runOperation(
      db,
      'users.get',
      { id: lee.user.id },
      asRun()
    )) as UserOut;
    expect(restored.extension).toBe('104');
  });

  it("removes a user's e-mail, and with it every way to log in", async () => {
    const db = await seededDb();
    const { user } = await create(db, {
      email: 'pat@x.test',
      extension: '101'
    });
    await db
      .updateTable('users')
      .set({ passwordHash: 'x', ssoSubject: 'sub-pat' })
      .where('id', '=', user.id)
      .execute();
    await seedSession(db, user.id, 'console', 'session-pat');
    const updated = await update(db, { id: user.id, email: null });
    expect(updated.user.email).toBeNull();
    const row = await db
      .selectFrom('users')
      .select(['passwordHash', 'ssoSubject'])
      .where('id', '=', user.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ passwordHash: null, ssoSubject: null });
    const live = await db
      .selectFrom('tokens')
      .select('tokenHash')
      .where('userId', '=', user.id)
      .where('revokedAt', 'is', null)
      .execute();
    expect(live).toEqual([]);
    await expect(
      runOperation(db, 'users.resetPassword', { id: user.id }, asRun())
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      runOperation(
        db,
        'personalAccessTokens.create',
        { userId: user.id, name: 'crm-sync' },
        asRun()
      )
    ).rejects.toMatchObject({ status: 409 });
  });

  it("refuses to remove an admin's e-mail, or that of a user without an extension (409)", async () => {
    const db = await seededDb();
    const admin = await create(db, { email: 'ada@x.test', role: 'admin' });
    await expect(
      update(db, { id: admin.user.id, email: null })
    ).rejects.toMatchObject({ status: 409 });
    const pat = await create(db, { email: 'pat@x.test' });
    await expect(
      update(db, { id: pat.user.id, email: null })
    ).rejects.toMatchObject({ status: 409 });
  });

  it('soft-deletes a user without an extension, and undoes it', async () => {
    const db = await seededDb();
    const { user } = await create(db, { email: 'pat@x.test' });
    await runOperation(db, 'users.delete', { id: user.id }, asConfirmedRun());
    const entry = await db
      .selectFrom('auditLog')
      .select('id')
      .where('operation', '=', 'users.delete')
      .executeTakeFirstOrThrow();
    await runOperation(db, 'audit.undo', entry, asRun());
    const restored = (await runOperation(
      db,
      'users.get',
      { id: user.id },
      asRun()
    )) as UserOut;
    expect(restored).toMatchObject({ email: 'pat@x.test', extension: null });
  });
});
