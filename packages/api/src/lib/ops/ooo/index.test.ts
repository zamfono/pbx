import { describe, expect, it } from 'vitest';

import { makeTestDb } from '#lib/testDb.js';

import { runOperation, type RunInput } from '../runner.js';
import { type Actor } from '../types.js';

import './index.js';

const owner: Actor = { id: 'owner', name: 'Owner', role: 'owner' };

function asRun(overrides: Partial<RunInput> = {}): RunInput {
  return { actor: owner, channel: 'rest', requestId: 'req-1', ...overrides };
}

type OooOutput = {
  id: string;
  active: boolean;
  startsAt: string | null;
  expiresAt: string | null;
};

describe('ooo', () => {
  it('creates, lists, updates and deletes a tenant rule', async () => {
    const db = await makeTestDb();
    const created = await runOperation<unknown, OooOutput>(
      db,
      'ooo.create',
      {
        scope: { kind: 'tenant' },
        startsAt: '2026-08-01T00:00:00Z',
        expiresAt: '2026-08-08T00:00:00Z',
        target: { kind: 'external', external: '+491234567' }
      },
      asRun()
    );
    const listed = await runOperation<unknown, { items: OooOutput[] }>(
      db,
      'ooo.list',
      { scope: { kind: 'tenant' } },
      asRun()
    );
    expect(listed.items.map(item => item.id)).toContain(created.id);
    const updated = await runOperation<unknown, OooOutput>(
      db,
      'ooo.update',
      { id: created.id, active: false },
      asRun()
    );
    expect(updated.active).toBe(false);
    await runOperation(
      db,
      'ooo.delete',
      { id: created.id },
      asRun({ confirm: true })
    );
    const afterDelete = await runOperation<unknown, { items: OooOutput[] }>(
      db,
      'ooo.list',
      { scope: { kind: 'tenant' } },
      asRun()
    );
    expect(afterDelete.items.map(item => item.id)).not.toContain(created.id);
  });

  it('list pages through a scope with limit and cursor, answering { items, nextCursor }', async () => {
    const db = await makeTestDb();
    const starts = ['2026-08-01', '2026-08-10', '2026-08-20'];
    const ids: string[] = [];
    for (const day of starts) {
      // eslint-disable-next-line no-await-in-loop -- sqlite has one writer; creates must serialize
      const created = await runOperation<unknown, OooOutput>(
        db,
        'ooo.create',
        {
          scope: { kind: 'tenant' },
          startsAt: `${day}T00:00:00Z`,
          expiresAt: `${day}T12:00:00Z`,
          target: { kind: 'external', external: '+491234567' }
        },
        asRun()
      );
      ids.push(created.id);
    }
    type Page = { items: OooOutput[]; nextCursor: string | null };
    const first = await runOperation<unknown, Page>(
      db,
      'ooo.list',
      { scope: { kind: 'tenant' }, limit: 2 },
      asRun()
    );
    expect(first.items.map(item => item.id)).toEqual(ids.slice(0, 2));
    expect(first.nextCursor).not.toBeNull();
    const second = await runOperation<unknown, Page>(
      db,
      'ooo.list',
      { scope: { kind: 'tenant' }, limit: 2, cursor: first.nextCursor },
      asRun()
    );
    expect(second.items.map(item => item.id)).toEqual(ids.slice(2));
    expect(second.nextCursor).toBeNull();
  });

  it('refuses an active period overlapping another active rule in the same scope', async () => {
    const db = await makeTestDb();
    await runOperation(
      db,
      'ooo.create',
      {
        scope: { kind: 'tenant' },
        startsAt: '2026-08-01T00:00:00Z',
        expiresAt: '2026-08-08T00:00:00Z',
        target: { kind: 'external', external: '+491234567' }
      },
      asRun()
    );
    await expect(
      runOperation(
        db,
        'ooo.create',
        {
          scope: { kind: 'tenant' },
          startsAt: '2026-08-05T00:00:00Z',
          expiresAt: '2026-08-10T00:00:00Z',
          target: { kind: 'external', external: '+491234567' }
        },
        asRun()
      )
    ).rejects.toMatchObject({ status: 422 });
  });

  it('treats an open-ended rule as overlapping every later period in the same scope', async () => {
    const db = await makeTestDb();
    await runOperation(
      db,
      'ooo.create',
      {
        scope: { kind: 'tenant' },
        startsAt: '2026-08-01T00:00:00Z',
        expiresAt: null,
        target: { kind: 'external', external: '+491234567' }
      },
      asRun()
    );
    await expect(
      runOperation(
        db,
        'ooo.create',
        {
          scope: { kind: 'tenant' },
          startsAt: '2030-01-01T00:00:00Z',
          expiresAt: '2030-02-01T00:00:00Z',
          target: { kind: 'external', external: '+491234567' }
        },
        asRun()
      )
    ).rejects.toMatchObject({ status: 422 });
  });

  it('lets an inactive rule overlap freely, since only active periods must not overlap', async () => {
    const db = await makeTestDb();
    await runOperation(
      db,
      'ooo.create',
      {
        scope: { kind: 'tenant' },
        startsAt: '2026-08-01T00:00:00Z',
        expiresAt: null,
        target: { kind: 'external', external: '+491234567' }
      },
      asRun()
    );
    await expect(
      runOperation(
        db,
        'ooo.create',
        {
          scope: { kind: 'tenant' },
          active: false,
          startsAt: '2026-08-05T00:00:00Z',
          expiresAt: '2026-08-10T00:00:00Z',
          target: { kind: 'external', external: '+491234567' }
        },
        asRun()
      )
    ).resolves.toMatchObject({ active: false });
  });

  it('refuses an expiresAt at or before startsAt', async () => {
    const db = await makeTestDb();
    await expect(
      runOperation(
        db,
        'ooo.create',
        {
          scope: { kind: 'tenant' },
          startsAt: '2026-08-08T00:00:00Z',
          expiresAt: '2026-08-01T00:00:00Z',
          target: { kind: 'external', external: '+491234567' }
        },
        asRun()
      )
    ).rejects.toMatchObject({ status: 422 });
  });

  it('catches an overlap expressed with a non-UTC offset and normalizes it to UTC', async () => {
    const db = await makeTestDb();
    await runOperation(
      db,
      'ooo.create',
      {
        scope: { kind: 'tenant' },
        startsAt: '2026-08-01T00:00:00Z',
        expiresAt: '2026-08-08T00:00:00Z',
        target: { kind: 'external', external: '+491234567' }
      },
      asRun()
    );
    // 2026-08-08T01:00:00+05:00 is 2026-08-07T20:00:00Z: inside the first rule's period, though
    // lexicographically greater than '2026-08-08T00:00:00Z' as a raw string.
    await expect(
      runOperation(
        db,
        'ooo.create',
        {
          scope: { kind: 'tenant' },
          startsAt: '2026-08-08T01:00:00+05:00',
          expiresAt: null,
          target: { kind: 'external', external: '+491234567' }
        },
        asRun()
      )
    ).rejects.toMatchObject({ status: 422 });
  });

  it('rejects a non-ISO-8601 startsAt', async () => {
    const db = await makeTestDb();
    await expect(
      runOperation(
        db,
        'ooo.create',
        {
          scope: { kind: 'tenant' },
          startsAt: 'tomorrow',
          target: { kind: 'external', external: '+491234567' }
        },
        asRun()
      )
    ).rejects.toMatchObject({ status: 422 });
  });

  it('lets a user manage only their own user scope', async () => {
    const db = await makeTestDb();
    const asUser = asRun({
      actor: { id: 'owner', name: 'Owner', role: 'user' }
    });
    await expect(
      runOperation(
        db,
        'ooo.create',
        {
          scope: { kind: 'tenant' },
          target: { kind: 'external', external: '+491234567' }
        },
        asUser
      )
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      runOperation(
        db,
        'ooo.create',
        {
          scope: { kind: 'user', id: 'owner' },
          target: { kind: 'external', external: '+491234567' }
        },
        asUser
      )
    ).resolves.toMatchObject({ active: true });
  });
});
