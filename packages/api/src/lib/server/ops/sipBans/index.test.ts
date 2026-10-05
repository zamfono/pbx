import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Db } from '@zamfono/shared';
import { seedSettings, seedUser } from '@zamfono/shared/testDb.js';

import { propagateConfig } from '#lib/server/propagation.js';
import { asConfirmedRun, asRun, makeTestDb } from '#testing/testDb.js';

import { runOperation } from '../runner.js';

import '../audit/index.js';
import '../sipAllowlist/index.js';
import './index.js';

const CREATED_AT = '2026-01-01T00:00:00.000Z';
const FUTURE = '2999-01-01T00:00:00.000Z';

let db: Db;

beforeEach(async () => {
  db = await makeTestDb();
  await seedSettings(db);
  vi.mocked(propagateConfig).mockClear();
});

const listFile = (): string =>
  path.join(process.env.ASTERISK_GEN_DIR ?? '', 'sip_bans.list');

async function seedBan(
  id: string,
  address: string,
  extra: { expiresAt?: string; liftedAt?: string } = {}
): Promise<void> {
  await db
    .insertInto('sipBans')
    .values({
      id,
      address,
      step: 1,
      failures: 10,
      createdAt: CREATED_AT,
      ...extra
    })
    .execute();
}

type Page = { items: { id: string }[] };

async function banIds(state?: string): Promise<string[]> {
  const page = (await runOperation(
    db,
    'sipBans.list',
    state === undefined ? {} : { state },
    asRun()
  )) as Page;
  return page.items.map(item => item.id);
}

describe('sipBans (§5.6, §10.3)', () => {
  it('lists the active bans by default, the ended or all of them on request', async () => {
    await seedBan('a-permanent', '203.0.113.1');
    await seedBan('b-running', '203.0.113.2', { expiresAt: FUTURE });
    await seedBan('c-expired', '203.0.113.3', {
      expiresAt: '2026-01-02T00:00:00.000Z'
    });
    await seedBan('d-lifted', '203.0.113.4', {
      liftedAt: '2026-01-01T01:00:00.000Z'
    });
    expect(await banIds()).toEqual(['a-permanent', 'b-running']);
    expect(await banIds('ended')).toEqual(['c-expired', 'd-lifted']);
    expect(await banIds('all')).toHaveLength(4);
    const page = (await runOperation(db, 'sipBans.list', {}, asRun())) as {
      items: unknown[];
    };
    expect(page.items[0]).toEqual({
      id: 'a-permanent',
      address: '203.0.113.1',
      step: 1,
      failures: 10,
      createdAt: CREATED_AT,
      expiresAt: null,
      liftedAt: null,
      liftedBy: null
    });
  });

  it('lifts an active ban, a permanent one included, and renders the list without it; not undoable', async () => {
    await seedBan('ban-1', '203.0.113.1');
    await seedBan('ban-2', '203.0.113.2', { expiresAt: FUTURE });
    await runOperation(db, 'sipBans.lift', { id: 'ban-1' }, asConfirmedRun());
    const row = await db
      .selectFrom('sipBans')
      .selectAll()
      .where('id', '=', 'ban-1')
      .executeTakeFirstOrThrow();
    expect(row.liftedBy).toBe('owner');
    expect(row.liftedAt).not.toBeNull();
    await expect(readFile(listFile(), 'utf8')).resolves.toBe(
      `203.0.113.2 ${FUTURE}\n`
    );
    const entry = await db
      .selectFrom('auditLog')
      .select(['operation', 'undoable'])
      .executeTakeFirstOrThrow();
    expect(entry).toEqual({ operation: 'sipBans.lift', undoable: 0 });
  });

  it('refuses to lift an unknown ban with 404 and an ended one with 409', async () => {
    await seedBan('ended', '203.0.113.3', {
      expiresAt: '2026-01-02T00:00:00.000Z'
    });
    await expect(
      runOperation(db, 'sipBans.lift', { id: 'missing' }, asConfirmedRun())
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      runOperation(db, 'sipBans.lift', { id: 'ended' }, asConfirmedRun())
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe('sipAllowlist (§5.6, §10.3)', () => {
  const create = async (address: string): Promise<{ id: string }> =>
    (await runOperation(
      db,
      'sipAllowlist.create',
      { address, label: 'office' },
      asRun()
    )) as { id: string };

  it('creates, lists and deletes an entry, each reaching core', async () => {
    const { id } = await create('198.51.100.0/24');
    const page = (await runOperation(db, 'sipAllowlist.list', {}, asRun())) as {
      items: unknown[];
    };
    expect(page.items).toMatchObject([
      { id, address: '198.51.100.0/24', label: 'office' }
    ]);
    await runOperation(db, 'sipAllowlist.delete', { id }, asConfirmedRun());
    expect(
      (
        (await runOperation(db, 'sipAllowlist.list', {}, asRun())) as {
          items: unknown[];
        }
      ).items
    ).toEqual([]);
    expect(propagateConfig).toHaveBeenCalledTimes(2);
  });

  it.each([['example.com'], ['10.0.0.0/33'], ['10.0.0.1 10.0.0.2'], ['']])(
    'refuses the address %j with 422',
    async address => {
      await expect(create(address)).rejects.toMatchObject({ status: 422 });
    }
  );

  it('refuses a second live entry of the same address with 409', async () => {
    await create('198.51.100.7');
    await expect(create('198.51.100.7')).rejects.toMatchObject({
      status: 409
    });
  });

  it('ends every active ban a new entry covers, recording its creator, and renders the list', async () => {
    await seedBan('v4', '198.51.100.7');
    await seedBan('v6', '2001:db8:0:5::/64', { expiresAt: FUTURE });
    await seedBan('other', '203.0.113.9');
    await create('198.51.100.0/24');
    await create('2001:db8:0:5::1');
    const lifted = await db
      .selectFrom('sipBans')
      .select(['id', 'liftedBy'])
      .where('liftedAt', 'is not', null)
      .orderBy('id')
      .execute();
    expect(lifted).toEqual([
      { id: 'v4', liftedBy: 'owner' },
      { id: 'v6', liftedBy: 'owner' }
    ]);
    await expect(readFile(listFile(), 'utf8')).resolves.toBe('203.0.113.9\n');
  });

  it('ends the active bans a restored entry covers when its delete is undone, recording the undoing admin', async () => {
    const { id } = await create('198.51.100.0/24');
    await runOperation(db, 'sipAllowlist.delete', { id }, asConfirmedRun());
    await seedBan('since', '198.51.100.7');
    await seedUser(db, {
      id: 'admin-2',
      name: 'Admin',
      email: 'admin@x',
      role: 'admin',
      passwordHash: 'x'
    });
    const entry = await db
      .selectFrom('auditLog')
      .select('id')
      .where('operation', '=', 'sipAllowlist.delete')
      .executeTakeFirstOrThrow();
    await runOperation(
      db,
      'audit.undo',
      { id: entry.id },
      asConfirmedRun({
        actor: { id: 'admin-2', name: 'Admin', role: 'admin' }
      })
    );
    const ban = await db
      .selectFrom('sipBans')
      .select(['liftedAt', 'liftedBy'])
      .executeTakeFirstOrThrow();
    expect(ban.liftedBy).toBe('admin-2');
    expect(ban.liftedAt).not.toBeNull();
    await expect(readFile(listFile(), 'utf8')).resolves.toBe('');
  });

  it('renders the list again when a create or a delete is undone', async () => {
    const { id } = await create('198.51.100.7');
    await runOperation(db, 'sipAllowlist.delete', { id }, asConfirmedRun());
    const entries = await db
      .selectFrom('auditLog')
      .select(['id', 'operation'])
      .orderBy('createdAt')
      .execute();
    for (const operation of ['sipAllowlist.delete', 'sipAllowlist.create']) {
      const entry = entries.find(row => row.operation === operation);
      // eslint-disable-next-line no-await-in-loop -- the delete's undo first, then the create's
      await rm(listFile(), { force: true });
      // eslint-disable-next-line no-await-in-loop -- the delete's undo first, then the create's
      await runOperation(
        db,
        'audit.undo',
        { id: entry?.id ?? '' },
        asConfirmedRun()
      );
      // eslint-disable-next-line no-await-in-loop -- the delete's undo first, then the create's
      await expect(readFile(listFile(), 'utf8')).resolves.toBe('');
    }
  });
});
