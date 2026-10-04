import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { makeTestDb } from '#testing/testDb.js';

import { keyringFromEnv } from '../secretbox.js';
import { AuthCodeStore } from './codes.js';
import { revokeEndpoint } from './oauth.js';
import { registerEndpoint, type RegisterDeps } from './registerEndpoint.js';
import { tokenEndpoint, type TokenDeps } from './tokenEndpoint.js';

const NOW = '2026-01-01T00:00:00.000Z';
const ORIGIN = 'https://pbx.example.com';
const CODE_TTL_MS = 60_000;
const JUST_OVER_CODE_TTL_MS = CODE_TTL_MS + 1000;

function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function formRequest(fields: Record<string, string>): Request {
  return new Request('http://test/oauth/token', {
    method: 'POST',
    body: new URLSearchParams(fields)
  });
}

async function tokenDeps(): Promise<{
  deps: TokenDeps;
  codes: AuthCodeStore;
  clock: { nowMs: number };
}> {
  const clock = { nowMs: 0 };
  const codes = new AuthCodeStore(() => clock.nowMs);
  const db = await makeTestDb();
  const deps: TokenDeps = {
    db,
    jwtSecret: 'test-secret',
    codes,
    origin: ORIGIN,
    now: () => NOW
  };
  return { deps, codes, clock };
}

/**
 * Inserts the `oauth_clients` row that `/oauth/authorize` upserts on first
 * authorization: `tokens.client_id` is a foreign key, so a refresh token cannot be issued
 * for a client the authorize step never recorded (§5.2 "Client rows").
 */
async function seedClient(deps: TokenDeps, clientId: string): Promise<void> {
  await deps.db
    .insertInto('oauthClients')
    .values({
      clientId,
      name: 'Test Client',
      kind: 'cimd',
      createdAt: NOW,
      lastLoginAt: NOW
    })
    .execute();
}

describe('tokenEndpoint (authorization_code)', () => {
  it('exchanges a valid code and PKCE verifier for an access and refresh token', async () => {
    const { deps, codes } = await tokenDeps();
    await seedClient(deps, 'client-1');
    const verifier = 'a-valid-code-verifier';
    const code = codes.issue({
      userId: 'owner',
      clientId: 'client-1',
      redirectUri: 'https://client.test/callback',
      codeChallenge: s256(verifier),
      scope: ''
    });
    const response = await tokenEndpoint(
      deps,
      formRequest({
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'https://client.test/callback',
        client_id: 'client-1',
        code_verifier: verifier
      })
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      access_token: string;
      refresh_token: string;
    };
    expect(body.access_token).toEqual(expect.any(String));
    expect(body.refresh_token).toEqual(expect.any(String));
  });

  it('refuses a wrong PKCE verifier with invalid_grant', async () => {
    const { deps, codes } = await tokenDeps();
    const code = codes.issue({
      userId: 'owner',
      clientId: 'client-1',
      redirectUri: 'https://client.test/callback',
      codeChallenge: s256('the-real-verifier'),
      scope: ''
    });
    const response = await tokenEndpoint(
      deps,
      formRequest({
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'https://client.test/callback',
        client_id: 'client-1',
        code_verifier: 'a-wrong-verifier'
      })
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_grant' });
  });

  it('refuses a code that has been outstanding for more than 60 seconds', async () => {
    const { deps, codes, clock } = await tokenDeps();
    const verifier = 'a-valid-code-verifier';
    const code = codes.issue({
      userId: 'owner',
      clientId: 'client-1',
      redirectUri: 'https://client.test/callback',
      codeChallenge: s256(verifier),
      scope: ''
    });
    clock.nowMs = JUST_OVER_CODE_TTL_MS;
    const response = await tokenEndpoint(
      deps,
      formRequest({
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'https://client.test/callback',
        client_id: 'client-1',
        code_verifier: verifier
      })
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_grant' });
  });
});

describe('a body that is not a form', () => {
  function jsonRequest(path: string): Request {
    return new Request(`http://test${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', token: 'x' })
    });
  }

  it('answers the token endpoint with a 400 error response (RFC 6749 §5.2)', async () => {
    const { deps } = await tokenDeps();
    const response = await tokenEndpoint(deps, jsonRequest('/oauth/token'));
    expect(response.status).toBe(400);
  });

  it('answers the revocation endpoint with 200, as for any token (RFC 7009)', async () => {
    const { deps } = await tokenDeps();
    const response = await revokeEndpoint(deps, jsonRequest('/oauth/revoke'));
    expect(response.status).toBe(200);
  });
});

describe('tokenEndpoint (rate limit)', () => {
  // §5.5: "An in-memory limiter in the server hooks covers the login, token, password-reset and
  // client-registration endpoints"; the endpoint keeps no second counter of its own.
  it('leaves the per-address limit to the server hooks', async () => {
    const TOKEN_LIMIT_PER_MINUTE = 60;
    const { deps } = await tokenDeps();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < TOKEN_LIMIT_PER_MINUTE + 1; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop -- each request must count before the next is made
      const response = await tokenEndpoint(
        deps,
        formRequest({ grant_type: 'password' })
      );
      statuses.push(response.status);
    }
    expect(new Set(statuses)).toEqual(new Set([400]));
  });
});

describe('registerEndpoint', () => {
  async function registerDeps(): Promise<RegisterDeps> {
    return {
      db: await makeTestDb(),
      keyring: keyringFromEnv({
        SECRETBOX_KEY: '1:MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY='
      }),
      now: () => NOW
    };
  }

  it('refuses more than 5 redirect uris with invalid_client_metadata', async () => {
    const deps = await registerDeps();
    const redirectUris = Array.from(
      { length: 6 },
      (_ignored, index) => `https://client.test/callback${index}`
    );
    const response = await registerEndpoint(
      deps,
      new Request('http://test/oauth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Too Many Redirects',
          redirect_uris: redirectUris,
          application_type: 'web'
        })
      })
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid_client_metadata'
    });
  });

  it.each([
    ['a relative URI', 'web', 'callback'],
    ['a data: URI', 'web', 'data:text/html,hello'],
    ['a private-use scheme for a web client', 'web', 'com.example.app:/cb'],
    ['a private-use scheme without a domain', 'native', 'myapp:/cb']
  ])(
    'refuses %s as a redirect URI with invalid_client_metadata',
    async (_case, applicationType, redirectUri) => {
      const response = await registerEndpoint(
        await registerDeps(),
        new Request('http://test/oauth/register', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            client_name: 'Odd Redirect',
            redirect_uris: [redirectUri],
            application_type: applicationType
          })
        })
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: 'invalid_client_metadata'
      });
    }
  );

  it("registers a native client's private-use scheme (RFC 8252 §7.1)", async () => {
    const response = await registerEndpoint(
      await registerDeps(),
      new Request('http://test/oauth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_name: 'An App',
          redirect_uris: ['com.example.app:/callback'],
          application_type: 'native'
        })
      })
    );
    expect(response.status).toBe(201);
  });

  it('registers a valid client without writing anything', async () => {
    const deps = await registerDeps();
    const response = await registerEndpoint(
      deps,
      new Request('http://test/oauth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_name: 'A CLI',
          redirect_uris: ['https://client.test/callback'],
          application_type: 'web'
        })
      })
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as { client_id: string };
    expect(body.client_id).toEqual(expect.any(String));
    const rows = await deps.db.selectFrom('oauthClients').selectAll().execute();
    expect(rows).toHaveLength(0);
  });
});
