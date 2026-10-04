import { describe, expect, it, vi } from 'vitest';

import { MS_PER_DAY, type Db } from '@zamfono/shared';
import { seedSettings } from '@zamfono/shared/testDb.js';

import { runPurge } from '#lib/server/jobs/purge.js';
import { createUser } from '#testing/fixtures.js';
import { makeTestDb } from '#testing/testDb.js';
import { EXTERNAL, run, seedAudio } from '#testing/undoKit.js';

import '../audio/index.js';
import '../blockedNumbers/index.js';
import '../dids/index.js';
import '../menus/index.js';
import '../ringGroups/index.js';
import '../users/index.js';
import './index.js';

vi.mock('#lib/server/audio/store.js', () => ({
  storeAudio: vi.fn(),
  deleteAudioFile: vi.fn(async () => Promise.resolve())
}));

/** Undoes the latest live `operation` entry for `entityId`. */
async function undo(
  db: Db,
  operation: string,
  entityId: string
): Promise<unknown> {
  const entry = await db
    .selectFrom('auditLog')
    .select('id')
    .where('operation', '=', operation)
    .where('entityId', '=', entityId)
    .where('undoneAt', 'is', null)
    .executeTakeFirstOrThrow();
  return run(db, 'audit.undo', { id: entry.id });
}

async function deletedAt(
  db: Db,
  table: 'menus' | 'ringGroups' | 'dids' | 'users',
  id: string
): Promise<string | null> {
  const row = await db
    .selectFrom(table)
    .select('deletedAt')
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
  return row.deletedAt;
}

describe('audit.undo of a deletion pointing at a row deleted since (§5.8)', () => {
  it('refuses a menu whose greeting was deleted since, and the purge still runs', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const audioId = await seedAudio(db, 'announcement');
    const menu = await run(db, 'menus.create', {
      name: 'Main',
      audioId,
      fallbackTarget: EXTERNAL
    });
    await run(db, 'menus.delete', { id: menu.id });
    await run(db, 'audio.delete', { id: audioId });

    await expect(undo(db, 'menus.delete', menu.id)).rejects.toMatchObject({
      status: 409,
      detail: { references: [{ kind: 'audio', id: audioId }] }
    });
    expect(await deletedAt(db, 'menus', menu.id)).not.toBeNull();
    const later = new Date(Date.now() + 31 * MS_PER_DAY).toISOString();
    await expect(runPurge(db, later)).resolves.toBeUndefined();
  });

  it('revives the menu once its greeting is revived first', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const audioId = await seedAudio(db, 'announcement');
    const menu = await run(db, 'menus.create', {
      name: 'Main',
      audioId,
      fallbackTarget: EXTERNAL
    });
    await run(db, 'menus.delete', { id: menu.id });
    await run(db, 'audio.delete', { id: audioId });

    await undo(db, 'audio.delete', audioId);
    await undo(db, 'menus.delete', menu.id);

    expect(await deletedAt(db, 'menus', menu.id)).toBeNull();
  });

  it('refuses a ring group whose greeting, a SET NULL reference, was deleted since', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const audioId = await seedAudio(db, 'greeting');
    const group = await run(db, 'ringGroups.create', {
      name: 'Sales',
      strategy: 'simultaneous',
      greetingAudioId: audioId
    });
    await run(db, 'ringGroups.delete', { id: group.id });
    await run(db, 'audio.delete', { id: audioId });

    await expect(undo(db, 'ringGroups.delete', group.id)).rejects.toMatchObject(
      {
        status: 409,
        detail: { references: [{ kind: 'audio', id: audioId }] }
      }
    );
    expect(await deletedAt(db, 'ringGroups', group.id)).not.toBeNull();
  });

  it('refuses a DID whose forward target names a user deleted since', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const anna = await createUser(db, '101');
    const did = await run(db, 'dids.create', {
      number: '+49891111',
      target: { kind: 'user', userId: anna }
    });
    await run(db, 'users.update', { id: anna, callerIdDidId: null });
    await run(db, 'dids.delete', { id: did.id });
    await run(db, 'users.delete', { id: anna });

    await expect(undo(db, 'dids.delete', did.id)).rejects.toMatchObject({
      status: 409,
      detail: { references: [{ kind: 'user', id: anna }] }
    });
    expect(await deletedAt(db, 'dids', did.id)).not.toBeNull();
  });

  it('refuses a user whose own forwarding rule targets a ring group deleted since', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const anna = await createUser(db, '101');
    const group = await run(db, 'ringGroups.create', {
      name: 'Sales',
      strategy: 'simultaneous'
    });
    await run(db, 'users.setForwarding', {
      id: anna,
      rules: [
        {
          condition: 'busy',
          target: { kind: 'ringGroup', ringGroupId: group.id }
        }
      ]
    });
    await run(db, 'users.delete', { id: anna });
    await run(db, 'ringGroups.delete', { id: group.id });

    await expect(undo(db, 'users.delete', anna)).rejects.toMatchObject({
      status: 409,
      detail: { references: [{ kind: 'ringGroup', id: group.id }] }
    });
    expect(await deletedAt(db, 'users', anna)).not.toBeNull();
  });

  it('revives a blocked number whose creator was deleted since', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const anna = await createUser(db, '101', { role: 'admin' });
    const blocked = await run(db, 'blockedNumbers.create', {
      number: '+491234567'
    });
    await db
      .updateTable('blockedNumbers')
      .set({ createdBy: anna })
      .where('id', '=', blocked.id)
      .execute();
    await run(db, 'blockedNumbers.delete', { id: blocked.id });
    await run(db, 'users.delete', { id: anna });

    await undo(db, 'blockedNumbers.delete', blocked.id);

    const row = await db
      .selectFrom('blockedNumbers')
      .select('deletedAt')
      .where('id', '=', blocked.id)
      .executeTakeFirstOrThrow();
    expect(row.deletedAt).toBeNull();
  });

  it('revives a user whose ring group, a membership rather than a route, was deleted since', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const anna = await createUser(db, '101');
    const group = await run(db, 'ringGroups.create', {
      name: 'Sales',
      strategy: 'simultaneous',
      members: [{ kind: 'user', id: anna }]
    });
    await run(db, 'ringGroups.delete', { id: group.id });
    await run(db, 'users.delete', { id: anna });

    await undo(db, 'users.delete', anna);

    expect(await deletedAt(db, 'users', anna)).toBeNull();
  });

  it("revives a user whose personal access token's creator was deleted since", async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const admin = await createUser(db, '100', { role: 'admin' });
    const anna = await createUser(db, '101', { email: 'anna@x.test' });
    await db
      .insertInto('personalAccessTokens')
      .values({
        id: 'pat-1',
        tokenHash: 'hash-1',
        userId: anna,
        name: 'crm-sync',
        createdBy: admin,
        createdAt: new Date().toISOString()
      })
      .execute();
    await run(db, 'users.delete', { id: admin });
    await run(db, 'users.delete', { id: anna });

    await undo(db, 'users.delete', anna);

    expect(await deletedAt(db, 'users', anna)).toBeNull();
  });
});
