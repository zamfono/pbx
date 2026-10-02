import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';

import { epochSeconds, nowIso, type Db } from '@zamfono/shared';

import { makeTestDb } from '../testDb.js';
import { authenticateRequest, authenticateToken } from './bearer.js';
import { signAccessToken } from './jwtSigning.js';

const JWT_SECRET = 'test-secret';
const ORIGIN = 'https://pbx.example.com';
const OWNER = { id: 'owner', name: 'Owner', role: 'owner' };

function tokenFor(sub: string, cid: string | null = null): Promise<string> {
  return signAccessToken(
    JWT_SECRET,
    { sub, role: 'owner', cid },
    epochSeconds(Date.now()),
    ORIGIN
  );
}

async function depsWith(seed?: (db: Db) => Promise<unknown>): Promise<{
  db: Db;
  jwtSecret: string;
}> {
  const db = await makeTestDb();
  await seed?.(db);
  return { db, jwtSecret: JWT_SECRET };
}

describe('authenticateToken', () => {
  it('resolves the live user with the role users holds now, not the one the token names', async () => {
    const deps = await depsWith(db =>
      db
        .updateTable('users')
        .set({ role: 'admin' })
        .where('id', '=', 'owner')
        .execute()
    );
    expect(await authenticateToken(deps, await tokenFor('owner'))).toEqual({
      actor: { ...OWNER, role: 'admin' }
    });
  });

  it('names the OAuth client and its name', async () => {
    const deps = await depsWith(db =>
      db
        .insertInto('oauthClients')
        .values({
          clientId: 'client-1',
          name: 'Ops Console',
          kind: 'cimd',
          redirectUrisJson: '[]',
          createdAt: nowIso(),
          lastLoginAt: nowIso()
        })
        .execute()
    );
    expect(
      await authenticateToken(deps, await tokenFor('owner', 'client-1'))
    ).toEqual({
      actor: OWNER,
      clientId: 'client-1',
      clientName: 'Ops Console'
    });
  });

  it('refuses a token for a soft-deleted user', async () => {
    const deps = await depsWith(db =>
      db
        .updateTable('users')
        .set({ deletedAt: nowIso() })
        .where('id', '=', 'owner')
        .execute()
    );
    expect(await authenticateToken(deps, await tokenFor('owner'))).toBeNull();
  });

  it('refuses a token for a user whose stored role is none of the three', async () => {
    const deps = await depsWith(async db => {
      // The `users.role` CHECK (§11.2) keeps such a row out; the refusal must not rely on it.
      await sql`PRAGMA ignore_check_constraints = ON`.execute(db);
      await db
        .updateTable('users')
        .set({ role: 'root' })
        .where('id', '=', 'owner')
        .execute();
    });
    expect(await authenticateToken(deps, await tokenFor('owner'))).toBeNull();
  });

  it('refuses a token not issued for the audience asked for', async () => {
    const deps = await depsWith();
    const token = await tokenFor('owner');
    expect(
      await authenticateToken(deps, token, `${ORIGIN}/mcp`)
    ).not.toBeNull();
    expect(
      await authenticateToken(deps, token, 'https://other.example/mcp')
    ).toBeNull();
  });
});

describe('authenticateRequest', () => {
  it('reads the bearer token of the Authorization header', async () => {
    const deps = await depsWith();
    const token = await tokenFor('owner');
    const request = new Request(ORIGIN, {
      headers: { authorization: `Bearer ${token}` }
    });
    expect((await authenticateRequest(deps, request))?.actor).toEqual(OWNER);
  });

  it('is null without a bearer token', async () => {
    const deps = await depsWith();
    expect(await authenticateRequest(deps, new Request(ORIGIN))).toBeNull();
    const basic = new Request(ORIGIN, {
      headers: { authorization: 'Basic b3duZXI6eA==' }
    });
    expect(await authenticateRequest(deps, basic)).toBeNull();
  });
});
