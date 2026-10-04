import type { RequestEvent } from '@sveltejs/kit';
import { beforeAll, describe, expect, it } from 'vitest';

import { nowIso } from '@zamfono/shared';
import { migrateForTest } from '@zamfono/shared/testDb.js';

import { getDb } from '#lib/server/db.js';
import { jsonPost } from '#testing/requestEvent.js';

import { POST } from './[...path]/+server.js';

const CLIENT_ID = 'client-1';
const CLIENT_NAME = 'Ops Console';

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
  await db
    .insertInto('oauthClients')
    .values({
      clientId: CLIENT_ID,
      name: CLIENT_NAME,
      kind: 'cimd',
      createdAt: nowIso(),
      lastLoginAt: nowIso()
    })
    .execute();
});

function eventFor(
  url: string,
  body: unknown,
  client: { clientId: string; clientName: string } | null
): RequestEvent {
  return jsonPost(url, body, {
    locals: {
      auth: { actor: { id: 'admin1', name: 'Admin', role: 'admin' }, ...client }
    }
  });
}

describe('POST /api/v1/[...path]', () => {
  it('records the OAuth client name alongside its id in the audit entry (§5.7)', async () => {
    const response = await POST(
      eventFor(
        'http://api/api/v1/blockedNumbers',
        { number: '+4915112345678' },
        { clientId: CLIENT_ID, clientName: CLIENT_NAME }
      )
    );
    expect(response.status).toBe(200);
    const entry = await getDb()
      .selectFrom('auditLog')
      .select(['clientId', 'clientName'])
      .where('operation', '=', 'blockedNumbers.create')
      .executeTakeFirstOrThrow();
    expect(entry).toEqual({ clientId: CLIENT_ID, clientName: CLIENT_NAME });
  });

  it('records no client for a call whose token names none', async () => {
    await POST(
      eventFor(
        'http://api/api/v1/blockedNumbers',
        { number: '+4915187654321' },
        null
      )
    );
    const entry = await getDb()
      .selectFrom('auditLog')
      .select(['clientId', 'clientName'])
      .orderBy('createdAt', 'desc')
      .executeTakeFirstOrThrow();
    expect(entry).toEqual({ clientId: null, clientName: null });
  });
});
