import { describe, expect, it } from 'vitest';

import { newId, nowIso, type Db } from '@zamfono/shared';

import { asRun, makeTestDb, seedSettings } from '#lib/server/testDb.js';

import { runOperation } from '../runner.js';
import { Conflict } from '../types.js';

import './index.js';

/** Inserts a live `dids` row targeting an external number, returning its id. */
async function insertDid(db: Db, number: string): Promise<string> {
  const targetId = newId();
  await db
    .insertInto('forwardTargets')
    .values({
      id: targetId,
      userId: null,
      ringGroupId: null,
      external: number,
      mailboxUserId: null,
      mailboxRingGroupId: null,
      announcementAudioId: null,
      menuId: null
    })
    .execute();
  const id = newId();
  await db
    .insertInto('dids')
    .values({ id, number, label: null, targetId, createdAt: nowIso() })
    .execute();
  return id;
}

describe('dids', () => {
  it('create normalizes a national number to e164 with the tenant country', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const created = (await runOperation(
      db,
      'dids.create',
      { number: '089123456', target: { kind: 'user', userId: 'owner' } },
      asRun()
    )) as { id: string; number: string };
    expect(created.number).toBe('+4989123456');
    const user = await db
      .selectFrom('users')
      .select('calleridDidId')
      .where('id', '=', 'owner')
      .executeTakeFirstOrThrow();
    expect(user.calleridDidId).toBe(created.id);
  });

  it('does not set a verbatim (non-numeric) DID as a user caller-ID', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const created = (await runOperation(
      db,
      'dids.create',
      { number: 'acct-4711', target: { kind: 'user', userId: 'owner' } },
      asRun()
    )) as { id: string; number: string };
    expect(created.number).toBe('acct-4711');
    const user = await db
      .selectFrom('users')
      .select('calleridDidId')
      .where('id', '=', 'owner')
      .executeTakeFirstOrThrow();
    expect(user.calleridDidId).toBeNull();
  });

  it('refuses whitespace in a DID number', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    await expect(
      runOperation(
        db,
        'dids.create',
        { number: '+49 89 1', target: { kind: 'user', userId: 'owner' } },
        asRun()
      )
    ).rejects.toBeDefined();
  });

  it('refuses a duplicate live DID number as a conflict', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    await insertDid(db, '+4930000009');
    await expect(
      runOperation(
        db,
        'dids.create',
        { number: '+4930000009', target: { kind: 'user', userId: 'owner' } },
        asRun()
      )
    ).rejects.toThrow(Conflict);
  });

  it('refuses to delete a DID a live user presents as caller-ID', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const presentedId = await insertDid(db, '+4930000001');
    await db
      .updateTable('users')
      .set({ calleridDidId: presentedId })
      .where('id', '=', 'owner')
      .execute();
    await expect(
      runOperation(
        db,
        'dids.delete',
        { id: presentedId },
        asRun({ confirm: true })
      )
    ).rejects.toThrow(Conflict);
  });

  it('refuses to delete the tenant main number', async () => {
    const db = await makeTestDb();
    const mainDidId = await seedSettings(db);
    await expect(
      runOperation(
        db,
        'dids.delete',
        { id: mainDidId },
        asRun({ confirm: true })
      )
    ).rejects.toThrow(Conflict);
  });
  it('refuses a target whose external number is not E.164', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    await expect(
      runOperation(
        db,
        'dids.create',
        {
          number: '+4930000010',
          target: { kind: 'external', external: '0049301234' }
        },
        asRun()
      )
    ).rejects.toMatchObject({ status: 422 });
  });

  it('refuses a target pointing at a soft-deleted user', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    await db
      .updateTable('users')
      .set({ deletedAt: nowIso() })
      .where('id', '=', 'owner')
      .execute();
    await expect(
      runOperation(
        db,
        'dids.create',
        {
          number: '+4930000011',
          target: { kind: 'user', userId: 'owner' }
        },
        asRun()
      )
    ).rejects.toMatchObject({ status: 404 });
  });
});
