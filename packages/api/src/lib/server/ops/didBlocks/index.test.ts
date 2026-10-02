import { describe, expect, it } from 'vitest';

import { newId, nowIso, type Db } from '@zamfono/shared';

import { makeTestDb } from '#lib/server/testDb.js';

import { runOperation, type RunInput } from '../runner.js';
import { Conflict, type Actor } from '../types.js';

import './index.js';

const owner: Actor = { id: 'owner', name: 'Owner', role: 'owner' };

function asRun(overrides: Partial<RunInput> = {}): RunInput {
  return { actor: owner, channel: 'rest', requestId: 'req-1', ...overrides };
}

/** Inserts a live `dids` row targeting an external number, returning its id. */
async function insertLiveDid(db: Db, number: string): Promise<string> {
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

/** Seeds the tenant `settings` singleton, whose country normalizes a national block base. */
async function seedTenant(db: Db): Promise<void> {
  const mainDidId = await insertLiveDid(db, '+490000000');
  await db
    .insertInto('settings')
    .values({
      id: 1,
      companyName: 'Test Co',
      country: 'DE',
      emergencyNumbersJson: '["112"]',
      mainDidId
    })
    .execute();
}

describe('didBlocks', () => {
  it('creates, lists and updates a block', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    const created = (await runOperation(
      db,
      'didBlocks.create',
      { base: '+49891234', digits: 2 },
      asRun()
    )) as { id: string; base: string };
    const listed = (await runOperation(db, 'didBlocks.list', {}, asRun())) as {
      items: { id: string }[];
    };
    expect(listed.items.map(item => item.id)).toContain(created.id);
    const updated = (await runOperation(
      db,
      'didBlocks.update',
      { id: created.id, label: 'Sales range' },
      asRun()
    )) as { label: string | null };
    expect(updated.label).toBe('Sales range');
  });

  it('refuses to change the immutable base', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    const created = (await runOperation(
      db,
      'didBlocks.create',
      { base: '+49891234', digits: 2 },
      asRun()
    )) as { id: string };
    await expect(
      runOperation(
        db,
        'didBlocks.update',
        { id: created.id, base: '+49899999' },
        asRun()
      )
    ).rejects.toMatchObject({ status: 422 });
  });

  it('refuses to delete a block with a live DID inside it', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    const created = (await runOperation(
      db,
      'didBlocks.create',
      { base: '+49891234', digits: 2 },
      asRun()
    )) as { id: string };
    await insertLiveDid(db, '+4989123401');
    await expect(
      runOperation(
        db,
        'didBlocks.delete',
        { id: created.id },
        asRun({ confirm: true })
      )
    ).rejects.toThrow(Conflict);
  });

  it('the soft-delete guard trigger holds when the operation check is bypassed', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    const created = (await runOperation(
      db,
      'didBlocks.create',
      { base: '+49891234', digits: 2 },
      asRun()
    )) as { id: string };
    await insertLiveDid(db, '+4989123401');
    await expect(
      db
        .updateTable('didBlocks')
        .set({ deletedAt: nowIso() })
        .where('id', '=', created.id)
        .execute()
    ).rejects.toThrow();
  });

  it('normalizes a national base to the international form', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    const created = (await runOperation(
      db,
      'didBlocks.create',
      { base: '089123' },
      asRun()
    )) as { base: string };
    expect(created.base).toBe('+4989123');
  });

  it('refuses a base carrying whitespace', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    await expect(
      runOperation(db, 'didBlocks.create', { base: '+4989 12' }, asRun())
    ).rejects.toMatchObject({ status: 422 });
  });

  it('refuses a base carrying a GLOB metacharacter', async () => {
    const db = await makeTestDb();
    await seedTenant(db);
    await expect(
      runOperation(db, 'didBlocks.create', { base: '+4989*' }, asRun())
    ).rejects.toMatchObject({ status: 422 });
  });
});
