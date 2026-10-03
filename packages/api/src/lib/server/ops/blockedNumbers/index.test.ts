import { describe, expect, it } from 'vitest';

import { asRun, makeTestDb } from '#lib/server/testDb.js';

import { runOperation } from '../runner.js';
import { Conflict } from '../types.js';

import './index.js';

describe('blockedNumbers', () => {
  it('creates, lists and deletes a blocked number', async () => {
    const db = await makeTestDb();
    const created = (await runOperation(
      db,
      'blockedNumbers.create',
      { number: '+491234567', label: 'Nuisance caller' },
      asRun()
    )) as { id: string; number: string };
    const listed = (await runOperation(
      db,
      'blockedNumbers.list',
      {},
      asRun()
    )) as { items: { id: string }[] };
    expect(listed.items.map(item => item.id)).toContain(created.id);
    await runOperation(
      db,
      'blockedNumbers.delete',
      { id: created.id },
      asRun({ confirm: true })
    );
    const afterDelete = (await runOperation(
      db,
      'blockedNumbers.list',
      {},
      asRun()
    )) as { items: { id: string }[] };
    expect(afterDelete.items).toHaveLength(0);
  });

  it('pages with an opaque cursor, and refuses a bare row id', async () => {
    const db = await makeTestDb();
    await runOperation(
      db,
      'blockedNumbers.create',
      { number: '+491111' },
      asRun()
    );
    await runOperation(
      db,
      'blockedNumbers.create',
      { number: '+492222' },
      asRun()
    );
    type Page = { items: { id: string }[]; nextCursor: string | null };
    const first = (await runOperation(
      db,
      'blockedNumbers.list',
      { limit: 1 },
      asRun()
    )) as Page;
    const firstId = first.items[0]?.id ?? '';
    expect(first.nextCursor).not.toBe(firstId);
    const second = (await runOperation(
      db,
      'blockedNumbers.list',
      { limit: 1, cursor: first.nextCursor },
      asRun()
    )) as Page;
    expect(second.items).toHaveLength(1);
    expect(second.items[0]?.id).not.toBe(firstId);
    await expect(
      runOperation(
        db,
        'blockedNumbers.list',
        { limit: 1, cursor: firstId },
        asRun()
      )
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      runOperation(
        db,
        'blockedNumbers.list',
        { cursor: 'not-a-cursor' },
        asRun()
      )
    ).rejects.toMatchObject({ status: 422 });
  });

  it('refuses a duplicate live number/prefix pair', async () => {
    const db = await makeTestDb();
    await runOperation(
      db,
      'blockedNumbers.create',
      { number: '+491234567', isPrefix: true },
      asRun()
    );
    await expect(
      runOperation(
        db,
        'blockedNumbers.create',
        { number: '+491234567', isPrefix: true },
        asRun()
      )
    ).rejects.toThrow(Conflict);
  });
});
