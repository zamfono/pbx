import type { RequestEvent } from '@sveltejs/kit';
import { beforeAll, describe, expect, it } from 'vitest';

import { nowIso } from '@zamfono/shared';
import { migrateForTest } from '@zamfono/shared/testDb.js';

import { getDb } from '#lib/server/db.js';

import { GET } from './[...path]/+server.js';

process.env.DB_FILE = ':memory:';

beforeAll(async () => {
  const db = getDb();
  await migrateForTest(db);
  await db
    .insertInto('users')
    .values({
      id: 'admin1',
      name: 'Admin',
      email: 'admin@x',
      role: 'admin',
      passwordHash: 'x',
      createdAt: nowIso()
    })
    .execute();
});

function eventFor(url: string): RequestEvent {
  return {
    request: new Request(url),
    url: new URL(url),
    locals: {
      auth: { actor: { id: 'admin1', name: 'Admin', role: 'admin' } }
    },
    getClientAddress: () => '198.51.100.1'
  } as RequestEvent;
}

describe('GET /api/v1/[...path]', () => {
  it('dispatches to a real registered operation, proving the registry is filled', async () => {
    const response = await GET(eventFor('http://api/api/v1/blockedNumbers'));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: unknown[] };
    expect(Array.isArray(body.items)).toBe(true);
  });
});
