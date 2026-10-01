import { describe, expect, it } from 'vitest';

import { newId, nowIso, type Db } from '@zamfono/shared';

import { makeTestDb } from '#lib/testDb.js';

import { runOperation, type RunInput } from '../runner.js';
import { Conflict, type Actor } from '../types.js';

import './index.js';

const owner: Actor = { id: 'owner', name: 'Owner', role: 'owner' };

function asRun(overrides: Partial<RunInput> = {}): RunInput {
  return { actor: owner, channel: 'rest', requestId: 'req-1', ...overrides };
}

/** Inserts one live `audio_assets` row of kind `announcement`, for a menu's required greeting. */
async function seedAudio(db: Db): Promise<string> {
  const id = newId();
  await db
    .insertInto('audioAssets')
    .values({
      id,
      label: 'Greeting',
      kind: 'announcement',
      filename: `${id}.wav`,
      createdAt: nowIso()
    })
    .execute();
  return id;
}

describe('menus', () => {
  it('create stores the greeting and fallback target, reachable on the returned menu', async () => {
    const db = await makeTestDb();
    const audioId = await seedAudio(db);
    const menu = await runOperation<
      unknown,
      { id: string; fallbackTarget: unknown }
    >(
      db,
      'menus.create',
      {
        name: 'Main menu',
        audioId,
        fallbackTarget: { kind: 'external', external: '+490000000' }
      },
      asRun()
    );
    expect(menu.fallbackTarget).toEqual({
      kind: 'external',
      external: '+490000000'
    });
  });

  it('refuses to create a menu whose name is already used by another live menu', async () => {
    const db = await makeTestDb();
    const audioId = await seedAudio(db);
    await runOperation(
      db,
      'menus.create',
      {
        name: 'Main menu',
        audioId,
        fallbackTarget: { kind: 'external', external: '+490000000' }
      },
      asRun()
    );
    const attempt = runOperation(
      db,
      'menus.create',
      {
        name: 'Main menu',
        audioId,
        fallbackTarget: { kind: 'external', external: '+491111111' }
      },
      asRun()
    );
    await expect(attempt).rejects.toBeInstanceOf(Conflict);
    await expect(attempt).rejects.toMatchObject({ status: 409 });
  });

  it('setTargets replaces the DTMF map as a whole', async () => {
    const db = await makeTestDb();
    const audioId = await seedAudio(db);
    const menu = await runOperation<unknown, { id: string }>(
      db,
      'menus.create',
      {
        name: 'Support menu',
        audioId,
        fallbackTarget: { kind: 'external', external: '+490000000' }
      },
      asRun()
    );
    await runOperation(
      db,
      'menus.setTargets',
      {
        id: menu.id,
        targets: [{ digits: '1', target: { kind: 'user', userId: 'owner' } }]
      },
      asRun()
    );
    const rows = await db
      .selectFrom('menuTargets')
      .selectAll()
      .where('menuId', '=', menu.id)
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.digits).toBe('1');
    const audit = await db
      .selectFrom('auditLog')
      .selectAll()
      .where('entityId', '=', menu.id)
      .where('operation', '=', 'menus.setTargets')
      .executeTakeFirstOrThrow();
    expect(audit.undoable).toBe(1);
  });

  it('getTargets returns the DTMF map in the shape setTargets takes, so it round-trips', async () => {
    const db = await makeTestDb();
    const audioId = await seedAudio(db);
    const menu = await runOperation<unknown, { id: string }>(
      db,
      'menus.create',
      {
        name: 'Round-trip menu',
        audioId,
        fallbackTarget: { kind: 'external', external: '+490000000' }
      },
      asRun()
    );
    const targets = [
      { digits: '1', target: { kind: 'user', userId: 'owner' } },
      { digits: '2', target: { kind: 'external', external: '+491111111' } }
    ];
    const set = await runOperation(
      db,
      'menus.setTargets',
      { id: menu.id, targets },
      asRun()
    );
    const read = await runOperation(
      db,
      'menus.getTargets',
      { id: menu.id },
      asRun()
    );
    expect(read).toEqual(set);
    const again = await runOperation(db, 'menus.setTargets', read, asRun());
    expect(again).toEqual(read);
  });

  it('getTargets answers an unknown menu with a 404', async () => {
    const db = await makeTestDb();
    const attempt = runOperation(
      db,
      'menus.getTargets',
      { id: 'missing' },
      asRun()
    );
    await expect(attempt).rejects.toMatchObject({ status: 404 });
  });

  it('setTargets refuses two targets with the same digits, with a 422', async () => {
    const db = await makeTestDb();
    const audioId = await seedAudio(db);
    const menu = await runOperation<unknown, { id: string }>(
      db,
      'menus.create',
      {
        name: 'Duplicate digits menu',
        audioId,
        fallbackTarget: { kind: 'external', external: '+490000000' }
      },
      asRun()
    );
    const attempt = runOperation(
      db,
      'menus.setTargets',
      {
        id: menu.id,
        targets: [
          { digits: '1', target: { kind: 'user', userId: 'owner' } },
          { digits: '1', target: { kind: 'external', external: '+491111111' } }
        ]
      },
      asRun()
    );
    await expect(attempt).rejects.toMatchObject({ status: 422 });
  });

  it('refuses to create a menu with an unknown audioId, with a 404', async () => {
    const db = await makeTestDb();
    const attempt = runOperation(
      db,
      'menus.create',
      {
        name: 'Ghost audio menu',
        audioId: 'not-a-real-asset',
        fallbackTarget: { kind: 'external', external: '+490000000' }
      },
      asRun()
    );
    await expect(attempt).rejects.toMatchObject({ status: 404 });
  });

  it('update replaces the fallback target, deleting the superseded forward_targets row', async () => {
    const db = await makeTestDb();
    const audioId = await seedAudio(db);
    const menu = await runOperation<unknown, { id: string }>(
      db,
      'menus.create',
      {
        name: 'Main menu',
        audioId,
        fallbackTarget: { kind: 'external', external: '+490000000' }
      },
      asRun()
    );
    const updated = await runOperation<unknown, { fallbackTarget: unknown }>(
      db,
      'menus.update',
      {
        id: menu.id,
        fallbackTarget: { kind: 'external', external: '+491111111' }
      },
      asRun()
    );
    expect(updated.fallbackTarget).toEqual({
      kind: 'external',
      external: '+491111111'
    });
    const targets = await db.selectFrom('forwardTargets').selectAll().execute();
    expect(targets).toHaveLength(1);
    expect(targets[0]?.external).toBe('+491111111');
  });

  it('allows deleting a menu whose own OOO rule routes back into its own scope', async () => {
    const db = await makeTestDb();
    const audioId = await seedAudio(db);
    const menu = await runOperation<unknown, { id: string }>(
      db,
      'menus.create',
      {
        name: 'Self-routing menu',
        audioId,
        fallbackTarget: { kind: 'external', external: '+490000000' }
      },
      asRun()
    );
    const selfTargetId = newId();
    await db
      .insertInto('forwardTargets')
      .values({
        id: selfTargetId,
        userId: null,
        ringGroupId: null,
        external: null,
        mailboxUserId: null,
        mailboxRingGroupId: null,
        announcementAudioId: null,
        menuId: menu.id
      })
      .execute();
    await db
      .insertInto('oooRules')
      .values({
        id: newId(),
        scopeUserId: null,
        scopeRingGroupId: null,
        scopeMenuId: menu.id,
        targetId: selfTargetId,
        createdAt: nowIso()
      })
      .execute();
    await expect(
      runOperation(
        db,
        'menus.delete',
        { id: menu.id },
        asRun({ confirm: true })
      )
    ).resolves.toMatchObject({ id: menu.id });
  });

  it('refuses to delete a menu another menu still targets, with a Conflict listing it', async () => {
    const db = await makeTestDb();
    const audioId = await seedAudio(db);
    const target = await runOperation<unknown, { id: string }>(
      db,
      'menus.create',
      {
        name: 'Target menu',
        audioId,
        fallbackTarget: { kind: 'external', external: '+490000000' }
      },
      asRun()
    );
    await runOperation(
      db,
      'menus.create',
      {
        name: 'Caller menu',
        audioId,
        fallbackTarget: { kind: 'menu', menuId: target.id }
      },
      asRun()
    );
    const attempt = runOperation(
      db,
      'menus.delete',
      { id: target.id },
      asRun({ confirm: true })
    );
    await expect(attempt).rejects.toBeInstanceOf(Conflict);
    await expect(attempt).rejects.toMatchObject({ status: 409 });
  });

  it('refuses to delete a menu when a live DID uses a forward_targets row other than the first one pointing at it', async () => {
    const db = await makeTestDb();
    const audioId = await seedAudio(db);
    const target = await runOperation<unknown, { id: string }>(
      db,
      'menus.create',
      {
        name: 'Target menu',
        audioId,
        fallbackTarget: { kind: 'external', external: '+490000000' }
      },
      asRun()
    );
    // An orphaned `forward_targets` row pointing at the menu, inserted first, that no other
    // table references (a purge-pending row per §5.9): it must not be the only one inspected.
    await db
      .insertInto('forwardTargets')
      .values({
        id: newId(),
        userId: null,
        ringGroupId: null,
        external: null,
        mailboxUserId: null,
        mailboxRingGroupId: null,
        announcementAudioId: null,
        menuId: target.id
      })
      .execute();
    const usedTargetId = newId();
    await db
      .insertInto('forwardTargets')
      .values({
        id: usedTargetId,
        userId: null,
        ringGroupId: null,
        external: null,
        mailboxUserId: null,
        mailboxRingGroupId: null,
        announcementAudioId: null,
        menuId: target.id
      })
      .execute();
    await db
      .insertInto('dids')
      .values({
        id: newId(),
        number: '+491234567',
        label: 'Main line',
        targetId: usedTargetId,
        createdAt: nowIso()
      })
      .execute();
    const attempt = runOperation(
      db,
      'menus.delete',
      { id: target.id },
      asRun({ confirm: true })
    );
    await expect(attempt).rejects.toBeInstanceOf(Conflict);
    await expect(attempt).rejects.toMatchObject({
      status: 409,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- vitest types expect.any() as `any`
      references: [{ kind: 'did', id: expect.any(String), label: 'Main line' }]
    });
  });
});
