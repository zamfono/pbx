import process from 'node:process';
import type { RequestEvent } from '@sveltejs/kit';
import { beforeAll, describe, expect, it } from 'vitest';

import { newId, nowIso } from '@zamfono/shared';
import { migrateForTest } from '@zamfono/shared/testDb.js';

import { POST } from '#routes/auth/reset/+server.js';

import { getDb } from '../db.js';
import { hashToken, issueRefresh, issueResetToken } from './tokens.js';

process.env.DB_FILE = ':memory:';
const PASSWORD = 'a brand new password';

function eventFor(body: unknown): RequestEvent {
  return {
    request: { json: () => Promise.resolve(body) } as Request
  } as unknown as RequestEvent;
}

beforeAll(async () => {
  await migrateForTest(getDb());
});

describe('POST /auth/reset', () => {
  it('answers 400 for an already-redeemed token', async () => {
    const db = getDb();
    const userId = newId();
    await db
      .insertInto('users')
      .values({
        id: userId,
        name: 'Anna',
        email: 'redeemed@example.com',
        role: 'user',
        passwordHash: 'x',
        createdAt: nowIso()
      })
      .execute();
    const { raw } = await issueResetToken(db, userId, 'reset', nowIso());
    // First redemption succeeds and revokes the token (`redeemResetToken`'s own job)...
    // eslint-disable-next-line new-cap -- POST is the fixed SvelteKit route-handler export name
    const first = await POST(eventFor({ token: raw, password: PASSWORD }));
    expect(first.status).toBe(200);
    // ...so presenting the very same raw token a second time must hit the `revoked_at !== null`
    // branch specifically, not just "no row for this hash" (a never-issued token would too).
    // eslint-disable-next-line new-cap -- POST is the fixed SvelteKit route-handler export name
    const second = await POST(eventFor({ token: raw, password: PASSWORD }));
    expect(second.status).toBe(400);
  });

  it('sets an Argon2id hash and revokes refresh tokens for a valid token', async () => {
    const db = getDb();
    const userId = newId();
    await db
      .insertInto('users')
      .values({
        id: userId,
        name: 'Ben',
        email: 'valid@example.com',
        role: 'user',
        passwordHash: 'x',
        createdAt: nowIso()
      })
      .execute();
    await db
      .insertInto('oauthClients')
      .values({
        clientId: 'client-1',
        name: 'Test Client',
        kind: 'cimd',
        redirectUrisJson: '[]',
        createdAt: nowIso(),
        lastLoginAt: nowIso()
      })
      .execute();
    const refresh = await issueRefresh(db, userId, 'client-1', nowIso());
    const rawResetToken = 'plain-reset-token-value';
    await db
      .insertInto('tokens')
      .values({
        tokenHash: hashToken(rawResetToken),
        userId,
        kind: 'reset',
        clientId: null,
        createdAt: nowIso(),
        expiresAt: '2099-01-01T00:00:00.000Z',
        revokedAt: null
      })
      .execute();

    // eslint-disable-next-line new-cap -- POST is the fixed SvelteKit route-handler export name
    const response = await POST(
      eventFor({ token: rawResetToken, password: PASSWORD })
    );
    expect(response.status).toBe(200);

    const user = await db
      .selectFrom('users')
      .select('passwordHash')
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(user.passwordHash?.startsWith('$argon2')).toBe(true);

    const refreshRow = await db
      .selectFrom('tokens')
      .select('revokedAt')
      .where('tokenHash', '=', hashToken(refresh.raw))
      .executeTakeFirstOrThrow();
    expect(refreshRow.revokedAt).not.toBeNull();
  });
});
