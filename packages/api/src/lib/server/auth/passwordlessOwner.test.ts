import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { epochSeconds, nowIso, type Db } from '@zamfono/shared';
import { seedUser } from '@zamfono/shared/testDb.js';

import { makeTestDb, seedSession } from '#testing/testDb.js';

import { sha256Hex } from '../hash.js';
import { authenticateToken } from './bearer.js';
import { AuthCodeStore } from './codes.js';
import { signAccessToken } from './jwt.js';
import { matchSsoAccount } from './ssoAccount.js';
import { tokenEndpoint, type TokenDeps } from './tokenEndpoint.js';
import { issueRefresh } from './tokens.js';

const NOW = '2026-01-01T00:00:00.000Z';
const ORIGIN = 'https://pbx.example.com';
const JWT_SECRET = 'test-secret';
const VERIFIER = 'a-valid-code-verifier';
const REDIRECT_URI = 'https://client.test/callback';

/** A database holding Olga, an owner who has not set a password yet, with a live session. */
async function withPasswordlessOwner(): Promise<Db> {
  const db = await makeTestDb();
  await seedUser(db, {
    id: 'olga',
    email: 'olga@x.test',
    role: 'owner',
    ssoSubject: 'sub-olga'
  });
  await seedSession(db, 'olga', 'client-1', 'session-olga');
  return db;
}

function deps(db: Db, codes: AuthCodeStore): TokenDeps {
  return { db, jwtSecret: JWT_SECRET, codes, origin: ORIGIN, now: () => NOW };
}

function tokenRequest(fields: Record<string, string>): Request {
  return new Request('http://test/oauth/token', {
    method: 'POST',
    body: new URLSearchParams(fields)
  });
}

describe('an owner who has not set a password (§5.2)', () => {
  it('redeems no authorization code', async () => {
    const db = await withPasswordlessOwner();
    const codes = new AuthCodeStore(() => 0);
    const code = codes.issue({
      userId: 'olga',
      clientId: 'client-1',
      redirectUri: REDIRECT_URI,
      codeChallenge: createHash('sha256').update(VERIFIER).digest('base64url'),
      scope: ''
    });
    const response = await tokenEndpoint(
      deps(db, codes),
      tokenRequest({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        client_id: 'client-1',
        code_verifier: VERIFIER
      })
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_grant' });
  });

  it('rotates no refresh token', async () => {
    const db = await withPasswordlessOwner();
    const refresh = await issueRefresh(db, 'olga', 'client-1', NOW);
    const response = await tokenEndpoint(
      deps(db, new AuthCodeStore(() => 0)),
      tokenRequest({ grant_type: 'refresh_token', refresh_token: refresh.raw })
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_grant' });
  });

  it('is authenticated by no access token or personal access token', async () => {
    const db = await withPasswordlessOwner();
    const accessToken = await signAccessToken(
      JWT_SECRET,
      { sub: 'olga', role: 'owner', cid: null, sid: 'session-olga' },
      epochSeconds(Date.now()),
      ORIGIN
    );
    const pat = 'zpat_olga';
    await db
      .insertInto('personalAccessTokens')
      .values({
        id: 'pat-olga',
        tokenHash: sha256Hex(pat),
        userId: 'olga',
        name: 'crm-sync',
        createdBy: 'olga',
        createdAt: nowIso()
      })
      .execute();
    const bearer = { db, jwtSecret: JWT_SECRET };
    expect(await authenticateToken(bearer, accessToken)).toBeNull();
    expect(await authenticateToken(bearer, pat)).toBeNull();
  });

  it('is refused at SSO login, bound or by e-mail, as noPassword', async () => {
    const db = await withPasswordlessOwner();
    expect(
      await matchSsoAccount(db, {
        sub: 'sub-olga',
        email: null,
        emailVouched: false
      })
    ).toEqual({ ok: false, reason: 'noPassword' });
    await db
      .updateTable('users')
      .set({ ssoSubject: null })
      .where('id', '=', 'olga')
      .execute();
    expect(
      await matchSsoAccount(db, {
        sub: 'sub-new',
        email: 'olga@x.test',
        emailVouched: true
      })
    ).toEqual({ ok: false, reason: 'noPassword' });
  });
});
