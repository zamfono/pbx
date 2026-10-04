import process from 'node:process';
import type { RequestEvent } from '@sveltejs/kit';
import { beforeAll, describe, expect, it } from 'vitest';

import { epochSeconds, nowIso } from '@zamfono/shared';
import { migrateForTest } from '@zamfono/shared/testDb.js';

import { signAccessToken } from '#lib/server/auth/jwt.js';
import { getDb } from '#lib/server/db.js';
import { requestEvent } from '#testing/requestEvent.js';

import { POST } from './+server.js';

const FQDN = 'pbx.example';
const ORIGIN = `https://${FQDN}`;
const JWT_SECRET = 'test-secret';
const CURRENT = '2026-07-28';

process.env.DB_FILE = ':memory:';
process.env.JWT_SECRET = JWT_SECRET;
process.env.FQDN = FQDN;

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

/** A 2026-07-28 `POST /mcp`: `_meta` and the standard headers as a conforming client sends them. */
async function eventFor(
  id: number,
  method: string,
  params: Record<string, unknown> = {}
): Promise<RequestEvent> {
  const token = await signAccessToken(
    JWT_SECRET,
    { sub: 'admin1', role: 'admin', cid: null },
    epochSeconds(Date.now()),
    ORIGIN
  );
  const name: Record<string, string> =
    typeof params.name === 'string' ? { 'mcp-name': params.name } : {};
  return requestEvent(`${ORIGIN}/mcp`, {
    init: {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'mcp-protocol-version': CURRENT,
        'mcp-method': method,
        ...name
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params: {
          ...params,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': CURRENT,
            'io.modelcontextprotocol/clientCapabilities': {}
          }
        }
      })
    }
  });
}

describe('POST /mcp', () => {
  it('lists the registered operations as tools, proving the registry is filled', async () => {
    const response = await POST(await eventFor(1, 'tools/list'));
    const body = (await response.json()) as {
      result: { tools: { name: string }[] };
    };
    const names = body.result.tools.map(tool => tool.name);
    expect(names).toContain('zamfono.help');
    expect(names).toContain('blockedNumbers.list');
  });

  it('dispatches a tool call to a real operation instead of answering "unknown operation"', async () => {
    const response = await POST(
      await eventFor(2, 'tools/call', {
        name: 'blockedNumbers.list',
        arguments: {}
      })
    );
    const body = (await response.json()) as {
      result?: { isError: boolean; structuredContent: { items: unknown[] } };
      error?: unknown;
    };
    expect(body.error).toBeUndefined();
    expect(body.result?.isError).toBe(false);
    expect(Array.isArray(body.result?.structuredContent.items)).toBe(true);
  });
});
