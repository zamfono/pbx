import type { RequestEvent } from '@sveltejs/kit';
import { beforeAll, describe, expect, it } from 'vitest';

import { nowIso } from '@zamfono/shared';
import { migrateForTest } from '@zamfono/shared/testDb.js';

import { getDb } from '$lib/server/db.js';

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
      redirectUrisJson: '[]',
      createdAt: nowIso(),
      lastLoginAt: nowIso()
    })
    .execute();
});

function eventFor(
  url: string,
  body: unknown,
  clientId: string | null
): RequestEvent {
  return {
    request: new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }),
    url: new URL(url),
    locals: {
      actor: { id: 'admin1', name: 'Admin', role: 'admin' },
      clientId
    },
    getClientAddress: () => '198.51.100.1'
  } as RequestEvent;
}

describe('POST /api/v1/[...path]', () => {
  it('records the OAuth client name alongside its id in the audit entry (§5.7)', async () => {
    // eslint-disable-next-line new-cap -- POST is the fixed SvelteKit route-handler export name
    const response = await POST(
      eventFor(
        'http://api/api/v1/blockedNumbers',
        { number: '+4915112345678' },
        CLIENT_ID
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
    // eslint-disable-next-line new-cap -- POST is the fixed SvelteKit route-handler export name
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
